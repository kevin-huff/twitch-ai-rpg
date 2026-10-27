import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { AiProvider, CharacterCardDefinition, DirectorSnapshot, ScenarioDefinition } from '@rpg/contracts';
import { ProviderError } from '@rpg/providers';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeAiProvider } from '../src/fake-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const PREMISE = 'A stolen ledger could ruin the whole city.';
const cardDraft = () => ({
  displayName: '  Ada Quill  ', pronouns: 'she/her', appearance: 'Ink on her gloves.', personality: 'Curious and patient.',
  backstory: 'Grew up in a print shop.', specialty: 'Breaking codes.', flaw: 'Will not let a puzzle go.',
  connection: 'Owes the others a favor.', secret: 'Generated private secret', possessions: ['Pen', 'Lens'],
  strongestTrait: 'wits', weakestTrait: 'force',
});
const current = () => ({ kind: 'character', displayName: 'Unsaved seat name', secret: 'Unsaved seat secret' });
const cardBody = (extra: Record<string, unknown> = {}) => ({ expectedCharacterRevision: 0, prompt: '  A code breaker, she/her  ', keepFilled: true, current: current(), ...extra });
const fieldBody = (extra: Record<string, unknown> = {}) => ({ expectedCharacterRevision: 0, field: 'character.backstory', seed: '  A printer  ', characterContext: current(), ...extra });

interface Credential { cookie: string; identity?: string }
interface Seat extends Credential { characterId: string }

suite('player seat card and field generation', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let hostToken: string;
  let host: Credential;
  let stage: Credential;
  let seats: Seat[];
  let sessionId: string;
  let starter: { scenario: ScenarioDefinition; characters: CharacterCardDefinition[] };
  let provider: FakeAiProvider;
  const generateField = vi.fn();
  const generateCard = vi.fn();

  const cookieOf = (headers: Record<string, unknown>) => {
    const values = headers['set-cookie'];
    return String(Array.isArray(values) ? values[0] : values).split(';')[0]!;
  };
  const request = (url: string, payload?: Record<string, unknown>, credential: Credential = host, headers: Record<string, string> = {}) => app.inject({
    method: payload === undefined ? 'GET' : 'POST', url,
    headers: { origin, cookie: credential.cookie, ...(credential.identity ? { 'x-rpg-identity': credential.identity } : {}), ...headers },
    ...(payload === undefined ? {} : { payload }),
  });
  const card = (payload: Record<string, unknown> = cardBody(), credential: Credential = seats[0]!, id = sessionId, headers: Record<string, string> = {}) => request(`/api/sessions/${id}/character/generate-card`, payload, credential, headers);
  const field = (payload: Record<string, unknown> = fieldBody(), credential: Credential = seats[0]!, id = sessionId, headers: Record<string, string> = {}) => request(`/api/sessions/${id}/character/generate-field`, payload, credential, headers);
  const command = (payload: Record<string, unknown>, credential: Credential = host, id = sessionId) => request(`/api/sessions/${id}/commands`, { commandId: randomUUID(), ...payload }, credential);
  const director = async (id = sessionId) => (await request(`/api/sessions/${id}`)).json() as DirectorSnapshot;

  async function createSession(scenario: ScenarioDefinition | null) {
    let body: Record<string, unknown> = { commandId: randomUUID() };
    if (scenario) {
      const saved = (await request('/api/library/scenarios', { commandId: randomUUID(), expectedVersion: 0, definition: scenario })).json();
      const characters = [];
      for (const definition of starter.characters.slice(0, 2)) {
        const template = (await request('/api/library/characters', { commandId: randomUUID(), expectedVersion: 0, definition })).json();
        characters.push({ templateId: template.id, version: template.version });
      }
      body = { ...body, scenario: { templateId: saved.id, version: saved.version }, characters };
    }
    const created = await request('/api/sessions', body);
    expect(created.statusCode, created.body).toBe(200);
    const players: Seat[] = [];
    let stageCredential: Credential | undefined;
    for (const invite of created.json().invites as Array<{ role: string; token: string; characterId: string | null }>) {
      const redeemed = await request('/api/auth/redeem', { token: invite.token }, { cookie: '' });
      expect(redeemed.statusCode, redeemed.body).toBe(200);
      const cookie = cookieOf(redeemed.headers);
      if (invite.role === 'player') players.push({ cookie, characterId: invite.characterId! }); else stageCredential = { cookie };
    }
    return { sessionId: created.json().sessionId as string, players, stage: stageCredential! };
  }
  async function writes(id = sessionId) {
    const actors = (await pool.query('SELECT actor_id FROM credentials WHERE token_hash=ANY($1::text[])', [seats.map(seat => hash(seat.cookie.split('=')[1]!))])).rows.map(row => row.actor_id);
    return (await pool.query(`SELECT
      (SELECT count(*) FROM audit_events WHERE session_id=$1) AS events,
      (SELECT count(*) FROM command_receipts WHERE session_id=$1 OR actor_id=ANY($2::text[])) AS receipts,
      (SELECT json_agg(data ORDER BY id) FROM characters WHERE session_id=$1) AS characters,
      (SELECT version FROM sessions WHERE id=$1) AS version`, [id, actors])).rows[0];
  }

  beforeEach(async () => {
    hostToken = `seat-generation-test-${randomUUID()}`;
    generateField.mockReset().mockResolvedValue({ text: '  A generated backstory.  ' });
    generateCard.mockReset().mockImplementation(async () => cardDraft());
    provider = new FakeAiProvider();
    provider.generateField = generateField;
    (provider as AiProvider).generateCard = generateCard;
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, provider, providerTimeoutMs: 2000, serveStatic: false });
    const signedIn = await request('/api/auth/host', { token: hostToken }, { cookie: '' });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    host = { cookie: cookieOf(signedIn.headers) };
    starter = (await request('/api/library/starter')).json();
    const created = await createSession({ ...starter.scenario, premise: `  ${PREMISE}  ` });
    sessionId = created.sessionId; seats = created.players; stage = created.stage;
  });
  afterEach(async () => { await app?.close(); await pool?.end(); });

  it('signs in the player before anything else and refuses other credentials without calling the AI', async () => {
    for (const route of [card, field]) {
      expect((await route(cardBody(), { cookie: '' })).statusCode).toBe(401);
      expect((await route({}, { cookie: '' })).statusCode).toBe(401);
      const hostResponse = await route(cardBody(), host);
      expect(hostResponse.statusCode).toBe(403);
      expect(hostResponse.json()).toMatchObject({ code: 'forbidden', message: 'Use your own player seat to write a card.' });
      expect((await route({}, host)).statusCode).toBe(403);
      expect((await route(cardBody(), stage)).statusCode).toBe(403);
      for (const wrong of ['', 'https://attacker.invalid']) expect((await route(cardBody(), seats[0]!, sessionId, { origin: wrong })).statusCode).toBe(403);
    }
    const link = await request('/api/character-builders', { commandId: randomUUID(), label: 'Private builder', instructions: 'Builder notes' });
    expect(link.statusCode, link.body).toBe(200);
    const access = await request('/api/character-builder/access', { token: link.json().token }, { cookie: '' });
    expect(access.statusCode, access.body).toBe(200);
    const builder = { cookie: cookieOf(access.headers), identity: access.json().identityId as string };
    expect((await card(cardBody(), builder)).statusCode).toBe(401);
    expect((await field(fieldBody(), builder)).statusCode).toBe(401);
    expect((await card(cardBody(), { cookie: builder.cookie })).statusCode).toBe(401);
    expect(generateCard).not.toHaveBeenCalled();
    expect(generateField).not.toHaveBeenCalled();
  });

  it('rejects client premise, instructions, unknown keys, other fields and other contexts without calling the AI', async () => {
    const invalidCards = [
      ...['premise', 'instructions', 'sessionId', 'characterId', 'commandId'].map(key => cardBody({ [key]: 'forged' })),
      cardBody({ current: { kind: 'npc', secrets: ['Unrelated'] } }), cardBody({ current: undefined }), cardBody({ prompt: '   ' }),
      cardBody({ expectedCharacterRevision: -1 }), cardBody({ prompt: 'x'.repeat(4001) }),
    ];
    for (const payload of invalidCards) expect((await card(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    const invalidFields = [
      ...['premise', 'instructions', 'sessionId', 'characterId'].map(key => fieldBody({ [key]: 'forged' })),
      ...['scenario.premise', 'npc.secret', 'scene.description', 'character.traits'].map(name => fieldBody({ field: name })),
      fieldBody({ characterContext: { kind: 'npc', secrets: ['Unrelated'] } }), fieldBody({ characterContext: undefined }),
    ];
    for (const payload of invalidFields) expect((await field(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    expect(generateCard).not.toHaveBeenCalled();
    expect(generateField).not.toHaveBeenCalled();
  });

  it('refuses a stale revision, a rehearsal session and a started session without calling the AI', async () => {
    for (const stale of [await card(cardBody({ expectedCharacterRevision: 1 })), await field(fieldBody({ expectedCharacterRevision: 1 }))]) {
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json().message).toBe('Your card changed. Load the latest card, then try again.');
    }
    const rehearsal = await createSession(null);
    for (const response of [await card(cardBody(), rehearsal.players[0]!, rehearsal.sessionId), await field(fieldBody(), rehearsal.players[0]!, rehearsal.sessionId)]) {
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().message).toBe('This session uses the original rehearsal cast rather than an editable lobby.');
    }
    expect((await card(cardBody(), rehearsal.players[0]!)).statusCode).toBe(404);
    // Cards from the library start approved, so the show can start without any approval step.
    for (const character of (await director()).characterDetails) expect(character).toMatchObject({ approved: true, draft: null });
    const revision = (await director()).session.stateRevision;
    const started = await command({ type: 'start_session', expectedStateRevision: revision });
    expect(started.statusCode, started.body).toBe(200);
    for (const response of [await card(cardBody({ expectedCharacterRevision: 1 })), await field(fieldBody({ expectedCharacterRevision: 1 }))]) {
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().message).toBe('Cards can only change before the show starts.');
    }
    expect(generateCard).not.toHaveBeenCalled();
    expect(generateField).not.toHaveBeenCalled();
  });

  it('sends the trimmed premise with the card, and only the supplied unsaved card, writing nothing', async () => {
    const before = await writes();
    const response = await card();
    expect(response.statusCode, response.body).toBe(200);
    expect(generateCard).toHaveBeenCalledExactlyOnceWith({ prompt: 'A code breaker, she/her', keepFilled: true, current: current(), premise: PREMISE });
    const sent = JSON.stringify(generateCard.mock.calls);
    for (const saved of starter.characters.slice(0, 2)) expect(sent).not.toContain(saved.secret);
    expect(response.json()).toMatchObject({ pronounsSuggested: false, card: { displayName: 'Unsaved seat name', secret: 'Unsaved seat secret', pronouns: 'she/her', traits: { wits: 2, force: 0, finesse: 1, presence: 1 } } });
    expect(response.json().notes).toContain('Kept what you already wrote.');
    expect(await writes()).toEqual(before);

    const blank = await createSession({ ...starter.scenario, premise: '   ' });
    expect((await card(cardBody(), blank.players[0]!, blank.sessionId)).statusCode).toBe(200);
    expect(generateCard.mock.calls.at(-1)![0]).not.toHaveProperty('premise');
  });

  it('sends the premise on the field route only with usePremise on an allowed field, writing nothing', async () => {
    const before = await writes();
    const plain = await field();
    expect(plain.statusCode, plain.body).toBe(200);
    expect(plain.json()).toEqual({ text: 'A generated backstory.' });
    expect(generateField).toHaveBeenLastCalledWith({ field: 'character.backstory', seed: 'A printer', characterContext: current() });
    expect((await field(fieldBody({ usePremise: true }))).statusCode).toBe(200);
    expect(generateField).toHaveBeenLastCalledWith({ field: 'character.backstory', seed: 'A printer', characterContext: current(), premise: PREMISE });
    generateField.mockResolvedValueOnce({ text: 'she/her' });
    expect((await field(fieldBody({ field: 'character.pronouns', seed: 'she/her', usePremise: true }))).statusCode).toBe(200);
    expect(generateField.mock.calls.at(-1)![0]).not.toHaveProperty('premise');
    expect((await field(fieldBody({ field: 'character.pronouns', seed: ' ', usePremise: true }))).statusCode).toBe(400);
    expect(await writes()).toEqual(before);
    expect(generateField).toHaveBeenCalledTimes(3);
  });

  it.each(['save', 'director save', 'revoke'] as const)('holds no session lock during the AI call and withholds the card after a concurrent %s', async (change) => {
    let finish: ((value: ReturnType<typeof cardDraft>) => void) | undefined;
    generateCard.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const generated = card();
    try {
      await vi.waitFor(() => expect(finish).toBeDefined(), { timeout: 2000, interval: 10 });
      const checker = await pool.connect();
      try {
        await checker.query('BEGIN');
        await checker.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE NOWAIT', [sessionId]);
      } finally { await checker.query('ROLLBACK'); checker.release(); }
      let expected = 409;
      if (change === 'save') {
        const saved = await command({ type: 'save_character', expectedCharacterRevision: 0, card: starter.characters[0] }, seats[0]);
        expect(saved.statusCode, saved.body).toBe(200);
      } else if (change === 'director save') {
        const written = await command({ type: 'save_character', characterId: seats[0]!.characterId, expectedCharacterRevision: 0, card: starter.characters[0] });
        expect(written.statusCode, written.body).toBe(200);
      } else {
        expect((await pool.query('UPDATE credentials SET revoked_at=now() WHERE token_hash=$1', [hash(seats[0]!.cookie.split('=')[1]!)])).rowCount).toBe(1);
        expected = 401;
      }
      finish!({ ...cardDraft(), secret: 'Stale generated secret' });
      const response = await generated;
      expect(response.statusCode, response.body).toBe(expected);
      if (expected === 409) expect(response.json().message).toBe('Your card changed while the AI was writing. Load the latest card, then try again.');
      expect(response.body).not.toContain('Stale generated secret');
      expect(response.json()).not.toHaveProperty('card');
    } finally { finish?.(cardDraft()); await generated; }
  });

  it('withholds a field draft after a concurrent save', async () => {
    let finish: ((value: { text: string }) => void) | undefined;
    generateField.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const generated = field();
    try {
      await vi.waitFor(() => expect(finish).toBeDefined(), { timeout: 2000, interval: 10 });
      expect((await command({ type: 'save_character', expectedCharacterRevision: 0, card: starter.characters[0] }, seats[0])).statusCode).toBe(200);
      finish!({ text: 'Stale generated backstory' });
      const response = await generated;
      expect(response.statusCode, response.body).toBe(409);
      expect(response.body).not.toContain('Stale generated backstory');
    } finally { finish?.({ text: 'Cleanup' }); await generated; }
  });

  it('hides provider failures, reports timeouts and writes nothing', async () => {
    const before = await writes();
    generateCard.mockRejectedValueOnce(new Error('Private upstream credentials'));
    const failed = await card();
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ code: 'generation_failed', message: "The AI's draft did not fit the form. Try again, or fill in the form yourself.", recoverable: false });
    generateCard.mockResolvedValueOnce({ ...cardDraft(), strongestTrait: 'luck', hidden: 'provider-secret' });
    const misshapen = await card();
    expect(misshapen.statusCode).toBe(502);
    expect(misshapen.body).not.toContain('provider-secret');
    generateCard.mockRejectedValueOnce(new ProviderError('timeout', 'ClewdR'));
    expect((await card()).statusCode).toBe(504);
    generateField.mockRejectedValueOnce(new Error('Private upstream field detail'));
    const fieldFailed = await field();
    expect(fieldFailed.statusCode).toBe(502);
    expect(fieldFailed.body).not.toContain('Private upstream');
    generateField.mockRejectedValueOnce(new ProviderError('timeout', 'ClewdR'));
    expect((await field()).statusCode).toBe(504);
    expect(await writes()).toEqual(before);
  });

  it('bounds a hung provider with the configured timeout', async () => {
    await app.close();
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, provider, providerTimeoutMs: 25, serveStatic: false });
    generateCard.mockImplementationOnce(() => new Promise(() => {}));
    const response = await card();
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ code: 'generation_timeout', message: 'The AI took too long. Try again, or fill in the form yourself.' });
  });

  it('reports 503 when the provider cannot write whole cards', async () => {
    await app.close();
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, provider: { plan: provider.plan.bind(provider), render: provider.render.bind(provider), generateField }, serveStatic: false });
    const response = await card();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'generation_unavailable', message: 'AI drafting is not available right now. You can still fill in the form yourself.' });
    expect((await field()).statusCode).toBe(200);
  });

  it("lets the director's test-seat credential use both routes", async () => {
    const opened = await request(`/api/sessions/${sessionId}/test-seat`, { characterId: seats[1]!.characterId });
    expect(opened.statusCode, opened.body).toBe(200);
    const testSeat = { cookie: cookieOf(opened.headers), identity: opened.json().identityId as string };
    const before = await writes();
    expect((await card(cardBody(), testSeat)).statusCode).toBe(200);
    expect((await field(fieldBody(), testSeat)).statusCode).toBe(200);
    expect(await writes()).toEqual(before);
  });
});
