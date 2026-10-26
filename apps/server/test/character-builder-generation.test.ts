import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeAiProvider } from '../src/fake-provider';
import { ProviderError } from '@rpg/providers';
import type { AiProvider, CardDraft } from '@rpg/contracts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const draft = () => ({
  schemaVersion: 1, displayName: 'Map maker', pronouns: '', appearance: '', personality: '', backstory: '',
  traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, specialty: '', flaw: '', possessions: ['', '', ''],
  connection: '', secret: 'Saved private draft', extensions: {},
});
const cardDraft = (): CardDraft => ({
  displayName: 'Mara Quill', pronouns: 'she/her', appearance: 'Ink-stained gloves.', personality: 'Careful and dry.', backstory: 'Drew maps for the harbor.',
  specialty: 'Reading old charts.', flaw: 'Trusts paper over people.', connection: 'Owes the party a favor.', secret: 'Sold a false map.',
  possessions: ['Brass compass'], strongestTrait: 'wits', weakestTrait: 'force',
});
const cardInput = () => ({ expectedRevision: 0, prompt: '  A careful mapmaker  ', keepFilled: true, current: { kind: 'character', displayName: 'Unsaved cartographer', secret: 'Unsaved private secret' } });
const input = () => ({ expectedRevision: 0, field: 'character.backstory', seed: '  An unsaved idea  ', characterContext: { kind: 'character', displayName: 'Unsaved cartographer', secret: 'Unsaved private secret' } });

suite('private character-builder field generation', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let hostToken: string;
  let identity: string;
  let builderId: string;
  let jar: Map<string, string>;
  let provider: FakeAiProvider;
  const generateField = vi.fn();
  const generateCard = vi.fn();
  const cookies = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  async function request(url: string, payload?: Record<string, unknown>, selected?: string, extraHeaders: Record<string, string> = {}) {
    const response = await app.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, cookie: cookies(), ...(selected === undefined ? {} : { 'x-rpg-identity': selected }), ...extraHeaders }, ...(payload === undefined ? {} : { payload }) });
    const setCookie = response.headers['set-cookie'];
    for (const value of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
      const pair = String(value).split(';')[0]!;
      const split = pair.indexOf('=');
      jar.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return response;
  }
  const post = (payload: Record<string, unknown> = input(), selected = identity, headers: Record<string, string> = {}) => request('/api/character-builder/generate-field', payload, selected, headers);
  const postCard = (payload: Record<string, unknown> = cardInput(), selected = identity, headers: Record<string, string> = {}) => request('/api/character-builder/generate-card', payload, selected, headers);
  async function create(instructions: string) {
    const link = await request('/api/character-builders', { commandId: randomUUID(), label: 'Private builder', instructions });
    expect(link.statusCode, link.body).toBe(200);
    const access = await request('/api/character-builder/access', { token: link.json().token });
    expect(access.statusCode, access.body).toBe(200);
    return { identity: access.json().identityId as string, id: link.json().builder.id as string };
  }
  beforeEach(async () => {
    hostToken = `builder-generation-test-${randomUUID()}`;
    jar = new Map();
    generateField.mockReset().mockResolvedValue({ text: '  A generated character draft.  ' });
    provider = new FakeAiProvider();
    provider.generateField = generateField;
    generateCard.mockReset().mockResolvedValue(cardDraft());
    (provider as AiProvider).generateCard = generateCard;
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, provider, providerTimeoutMs: 2000, serveStatic: false });
    expect((await request('/api/auth/host', { token: hostToken })).statusCode).toBe(200);
    const created = await create('  Instructions from this builder owner.  ');
    identity = created.identity;
    builderId = created.id;
  });
  afterEach(async () => { await app?.close(); await pool?.end(); });

  it('authenticates before input validation and never falls back to core host, player, or stage cookies', async () => {
    expect((await request('/api/character-builder/generate-field', {})).statusCode).toBe(401);
    expect((await post({}, identity, { cookie: '' })).statusCode).toBe(401);
    const host = (await request('/api/auth/host', { token: hostToken, tab: true })).json().identityId;
    expect((await post({}, host)).statusCode).toBe(401);
    const session = (await request('/api/sessions', { commandId: randomUUID() })).json();
    for (const role of ['player', 'stage']) {
      const token = session.invites.find((invite: { role: string }) => invite.role === role).token;
      const other = (await request('/api/auth/redeem', { token, tab: true })).json().identityId;
      expect((await post({}, other)).statusCode).toBe(401);
    }
    for (const selected of ['', 'invalid', 'f'.repeat(32)]) expect((await post({}, selected)).statusCode).toBe(401);
    expect((await request(`/api/character-builder/generate-field?identity=${identity}&identity=${identity}`, {}, identity)).statusCode).toBe(401);
    expect((await request(`/api/character-builder/generate-field?identity=${'e'.repeat(32)}`, {}, identity)).statusCode).toBe(401);
    for (const requestOrigin of ['', 'https://attacker.invalid']) expect((await post({}, identity, { origin: requestOrigin })).statusCode).toBe(403);
    expect((await request('/api/authoring/generate-field', { field: 'character.backstory', seed: 'Idea' }, identity)).statusCode).toBe(401);
    expect(generateField).not.toHaveBeenCalled();
  });

  it('allows only character fields and strict current-character context, with no client-controlled instructions, premise, or identifiers', async () => {
    const valid = input();
    const invalid = [
      ...['scenario.premise', 'npc.secret', 'scene.description', 'track.label', 'character.traits', 'character.approved'].map(field => ({ ...valid, field })),
      ...['instructions', 'premise', 'builderId', 'characterId', 'sessionId', 'commandId'].map(key => ({ ...valid, [key]: 'forged' })),
      { ...valid, expectedRevision: -1 }, { ...valid, expectedRevision: 0.5 }, { ...valid, seed: 'x'.repeat(12001) },
      { ...valid, characterContext: undefined }, { ...valid, characterContext: { kind: 'npc', secrets: ['Unrelated'] } },
      { ...valid, characterContext: { kind: 'character', otherCharacter: 'Not selected' } },
      { ...valid, characterContext: { kind: 'character', secret: 'x'.repeat(2001) } },
      { ...valid, characterContext: { kind: 'character', traits: { force: 3 } } },
    ];
    for (const payload of invalid) expect((await post(payload)).statusCode).toBe(400);
    expect(generateField).not.toHaveBeenCalled();
    for (const field of ['displayName', 'pronouns', 'appearance', 'personality', 'backstory', 'specialty', 'flaw', 'connection', 'secret', 'possession']) {
      expect((await post({ ...valid, field: `character.${field}` })).statusCode).toBe(200);
    }
    expect(generateField).toHaveBeenCalledTimes(10);
  });

  it('passes only supplied unsaved character details and the selected grant instructions, without saving any generation output', async () => {
    expect((await request('/api/character-builder/save', { commandId: randomUUID(), expectedRevision: 0, draft: draft() }, identity)).statusCode).toBe(200);
    const other = await create('Unrelated builder instructions');
    expect((await request('/api/character-builder/save', { commandId: randomUUID(), expectedRevision: 0, draft: { ...draft(), secret: 'Other builder secret' } }, other.identity)).statusCode).toBe(200);
    const read = async () => ({
      builders: (await pool.query('SELECT * FROM character_builders WHERE id=ANY($1::text[]) ORDER BY id', [[builderId, other.id]])).rows,
      library: (await request('/api/library')).json(),
      counts: (await pool.query('SELECT (SELECT count(*) FROM audit_events) AS events, (SELECT count(*) FROM command_receipts) AS receipts, (SELECT count(*) FROM generation_jobs) AS jobs, (SELECT count(*) FROM sessions) AS sessions, (SELECT count(*) FROM characters) AS characters, (SELECT count(*) FROM character_builder_credentials) AS credentials')).rows,
    });
    const before = await read();
    const payload = { ...input(), expectedRevision: 1 };
    const response = await post(payload);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ text: 'A generated character draft.' });
    expect(generateField).toHaveBeenCalledExactlyOnceWith({ field: payload.field, seed: 'An unsaved idea', characterContext: payload.characterContext, instructions: 'Instructions from this builder owner.' });
    expect(JSON.stringify(generateField.mock.calls)).not.toContain('Saved private draft');
    expect(JSON.stringify(generateField.mock.calls)).not.toContain('Unrelated builder');
    expect(JSON.stringify(generateField.mock.calls)).not.toContain('Other builder secret');
    expect(await read()).toEqual(before);
    generateField.mockClear();
    const ownOther = await post({ ...input(), expectedRevision: 1 }, other.identity);
    expect(ownOther.statusCode).toBe(200);
    expect(generateField.mock.calls[0]![0].instructions).toBe('Unrelated builder instructions');
  });

  it('uses own instructions as a blank-card starting point, omits blank instructions, and requires explicit pronouns', async () => {
    const emptyContext = { expectedRevision: 0, field: 'character.backstory', seed: ' ', characterContext: { kind: 'character' } };
    expect((await post(emptyContext)).statusCode).toBe(200);
    expect(generateField).toHaveBeenLastCalledWith({ field: 'character.backstory', seed: '', characterContext: { kind: 'character' }, instructions: 'Instructions from this builder owner.' });
    expect((await post({ ...emptyContext, field: 'character.pronouns' })).statusCode).toBe(400);
    const blank = await create('   ');
    expect((await post(emptyContext, blank.identity)).statusCode).toBe(400);
    const text = await post(input(), blank.identity);
    expect(text.statusCode).toBe(200);
    expect(generateField.mock.calls.at(-1)![0]).not.toHaveProperty('instructions');
    expect((await post({ ...emptyContext, field: 'character.pronouns', seed: 'they/them' })).statusCode).toBe(200);
  });

  it.each(['saved', 'submitted', 'revoked', 'expired', 'credential-expired', 'logout'] as const)('rejects %s state before calling the provider', async (state) => {
    let expected = 401;
    if (state === 'saved' || state === 'submitted') {
      const action = state === 'saved' ? 'save' : 'submit';
      expect((await request(`/api/character-builder/${action}`, { commandId: randomUUID(), expectedRevision: 0, draft: draft() }, identity)).statusCode).toBe(200);
      expected = 409;
    } else if (state === 'revoked') {
      expect((await request(`/api/character-builders/${builderId}/revoke`, { commandId: randomUUID() })).statusCode).toBe(200);
    } else if (state === 'expired') await pool.query("UPDATE character_builders SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [builderId]);
    else if (state === 'credential-expired') await pool.query("UPDATE character_builder_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [hash(jar.get(`rpg_builder_${identity}`)!)]);
    else expect((await request('/api/character-builder/logout', {}, identity)).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(expected);
    expect(generateField).not.toHaveBeenCalled();
  });

  it.each(['save', 'submit', 'revoke', 'expire', 'credential-expire', 'logout'] as const)('holds no grant lock during AI and withholds output after concurrent %s', async (state) => {
    let finish: ((value: { text: string }) => void) | undefined;
    generateField.mockImplementationOnce(() => new Promise<{ text: string }>(resolve => { finish = resolve; }));
    const generated = post();
    try {
      await vi.waitFor(() => expect(finish).toBeDefined(), { timeout: 1000, interval: 10 });
      const checker = await pool.connect();
      try {
        await checker.query('BEGIN');
        await checker.query('SELECT id FROM character_builders WHERE id=$1 FOR UPDATE NOWAIT', [builderId]);
        await checker.query('ROLLBACK');
      } finally { await checker.query('ROLLBACK'); checker.release(); }
      let expected = 401;
      if (state === 'save' || state === 'submit') {
        expect((await request(`/api/character-builder/${state}`, { commandId: randomUUID(), expectedRevision: 0, draft: draft() }, identity)).statusCode).toBe(200);
        expected = 409;
      } else if (state === 'revoke') {
        expect((await request(`/api/character-builders/${builderId}/revoke`, { commandId: randomUUID() })).statusCode).toBe(200);
      } else if (state === 'expire') await pool.query("UPDATE character_builders SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [builderId]);
      else if (state === 'credential-expire') await pool.query("UPDATE character_builder_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [hash(jar.get(`rpg_builder_${identity}`)!)]);
      else expect((await request('/api/character-builder/logout', {}, identity)).statusCode).toBe(200);
      finish!({ text: 'Stale private generated result' });
      const response = await generated;
      expect(response.statusCode, response.body).toBe(expected);
      expect(response.body).not.toContain('Stale private generated result');
      expect(response.json()).not.toHaveProperty('text');
    } finally { finish?.({ text: 'Cleanup response' }); await generated; }
  });

  it('validates provider shape and field limits and hides provider failure details', async () => {
    for (const output of [{ text: '' }, { text: 'x'.repeat(81) }, { text: 'Fine', hidden: 'provider-secret' }, { text: 42 }]) {
      generateField.mockResolvedValueOnce(output);
      const response = await post({ ...input(), field: 'character.displayName' });
      expect(response.statusCode, response.body).toBe(502);
      expect(response.json().code).toBe('generation_failed');
      expect(response.json()).not.toHaveProperty('text');
    }
    generateField.mockRejectedValueOnce(new Error('Private credentials in upstream error'));
    const response = await post();
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('Private credentials');
    generateField.mockRejectedValueOnce(new ProviderError('timeout', 'ClewdR'));
    expect((await post()).statusCode).toBe(504);
  });

  it('bounds a hung provider with a safe timeout and does not substitute a fake result', async () => {
    await app.close();
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, provider, providerTimeoutMs: 25, serveStatic: false });
    generateField.mockImplementationOnce(() => new Promise(() => {}));
    const response = await post();
    expect(response.statusCode).toBe(504);
    expect(response.json().code).toBe('generation_timeout');
    expect(response.json()).not.toHaveProperty('text');
  });

  it('reports unsupported provider capability after authentication without a fallback', async () => {
    await app.close();
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, provider: { plan: provider.plan.bind(provider), render: provider.render.bind(provider) }, serveStatic: false });
    const response = await post();
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('generation_unavailable');
    expect(response.json()).not.toHaveProperty('text');
    expect((await request('/api/character-builder/generate-field', {})).statusCode).toBe(401);
  });

  describe('whole-card generation', () => {
    it('authenticates before validation and never falls back to host, player, or stage cookies', async () => {
      expect((await request('/api/character-builder/generate-card', {})).statusCode).toBe(401);
      expect((await postCard({}, identity, { cookie: '' })).statusCode).toBe(401);
      const host = (await request('/api/auth/host', { token: hostToken, tab: true })).json().identityId;
      expect((await postCard({}, host)).statusCode).toBe(401);
      const session = (await request('/api/sessions', { commandId: randomUUID() })).json();
      for (const role of ['player', 'stage']) {
        const token = session.invites.find((invite: { role: string }) => invite.role === role).token;
        const other = (await request('/api/auth/redeem', { token, tab: true })).json().identityId;
        expect((await postCard({}, other)).statusCode).toBe(401);
      }
      for (const selected of ['', 'invalid', 'f'.repeat(32)]) expect((await postCard({}, selected)).statusCode).toBe(401);
      for (const requestOrigin of ['', 'https://attacker.invalid']) expect((await postCard({}, identity, { origin: requestOrigin })).statusCode).toBe(403);
      expect(generateCard).not.toHaveBeenCalled();
    });

    it('rejects client instructions, premise, identifiers, and unknown keys without calling the AI', async () => {
      const valid = cardInput();
      const invalid = [
        ...['instructions', 'premise', 'builderId', 'characterId', 'sessionId', 'commandId', 'extra'].map(key => ({ ...valid, [key]: 'forged' })),
        { ...valid, expectedRevision: -1 }, { ...valid, expectedRevision: 0.5 }, { ...valid, prompt: '   ' }, { ...valid, prompt: 'x'.repeat(4001) },
        { ...valid, current: undefined }, { ...valid, current: { kind: 'npc', secrets: ['Unrelated'] } },
        { ...valid, current: { kind: 'character', otherCharacter: 'Not selected' } },
        { ...valid, current: { kind: 'character', traits: { force: 3 } } },
      ];
      for (const payload of invalid) expect((await postCard(payload)).statusCode, JSON.stringify(payload)).toBe(400);
      expect(generateCard).not.toHaveBeenCalled();
    });

    it('adds the grant instructions server-side, omits blank ones, saves nothing, and returns a repaired card', async () => {
      const before = async () => ({
        builder: (await pool.query('SELECT draft,draft_revision,submitted_at FROM character_builders WHERE id=$1', [builderId])).rows,
        templates: (await pool.query('SELECT count(*) AS n FROM library_templates WHERE owner_id=(SELECT owner_id FROM character_builders WHERE id=$1)', [builderId])).rows,
      });
      const snapshot = await before();
      const response = await postCard();
      expect(response.statusCode, response.body).toBe(200);
      expect(generateCard).toHaveBeenCalledExactlyOnceWith({
        prompt: 'A careful mapmaker', keepFilled: true, current: cardInput().current, instructions: 'Instructions from this builder owner.',
      });
      const body = response.json();
      expect(body.card.displayName).toBe('Unsaved cartographer');
      expect(body.card.secret).toBe('Unsaved private secret');
      expect(body.card.traits).toEqual({ force: 0, finesse: 1, wits: 2, presence: 1 });
      expect(body.pronounsSuggested).toBe(true);
      expect(body.notes).toContain('Kept what you already wrote.');
      expect(await before()).toEqual(snapshot);

      const blank = await create('   ');
      generateCard.mockClear();
      expect((await postCard(cardInput(), blank.identity)).statusCode).toBe(200);
      expect(generateCard.mock.calls[0]![0]).not.toHaveProperty('instructions');
    });

    it.each(['saved', 'submitted', 'revoked', 'expired', 'credential-expired', 'logout'] as const)('rejects %s state before calling the AI', async (state) => {
      let expected = 401;
      if (state === 'saved' || state === 'submitted') {
        const action = state === 'saved' ? 'save' : 'submit';
        expect((await request(`/api/character-builder/${action}`, { commandId: randomUUID(), expectedRevision: 0, draft: draft() }, identity)).statusCode).toBe(200);
        expected = 409;
      } else if (state === 'revoked') {
        expect((await request(`/api/character-builders/${builderId}/revoke`, { commandId: randomUUID() })).statusCode).toBe(200);
      } else if (state === 'expired') await pool.query("UPDATE character_builders SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [builderId]);
      else if (state === 'credential-expired') await pool.query("UPDATE character_builder_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [hash(jar.get(`rpg_builder_${identity}`)!)]);
      else expect((await request('/api/character-builder/logout', {}, identity)).statusCode).toBe(200);
      expect((await postCard()).statusCode).toBe(expected);
      expect(generateCard).not.toHaveBeenCalled();
    });

    it('rejects a stale revision before calling the AI', async () => {
      const response = await postCard({ ...cardInput(), expectedRevision: 3 });
      expect(response.statusCode).toBe(409);
      expect(response.json().message).toBe('This draft changed. Reload it before generating.');
      expect(generateCard).not.toHaveBeenCalled();
    });

    it.each(['save', 'submit', 'revoke', 'expire', 'credential-expire', 'logout'] as const)('holds no grant lock during AI and withholds the card after concurrent %s', async (state) => {
      let finish: ((value: CardDraft) => void) | undefined;
      generateCard.mockImplementationOnce(() => new Promise<CardDraft>(resolve => { finish = resolve; }));
      const generated = postCard();
      try {
        await vi.waitFor(() => expect(finish).toBeDefined(), { timeout: 1000, interval: 10 });
        const checker = await pool.connect();
        try {
          await checker.query('BEGIN');
          await checker.query('SELECT id FROM character_builders WHERE id=$1 FOR UPDATE NOWAIT', [builderId]);
          await checker.query('ROLLBACK');
        } finally { await checker.query('ROLLBACK'); checker.release(); }
        let expected = 401;
        if (state === 'save' || state === 'submit') {
          expect((await request(`/api/character-builder/${state}`, { commandId: randomUUID(), expectedRevision: 0, draft: draft() }, identity)).statusCode).toBe(200);
          expected = 409;
        } else if (state === 'revoke') {
          expect((await request(`/api/character-builders/${builderId}/revoke`, { commandId: randomUUID() })).statusCode).toBe(200);
        } else if (state === 'expire') await pool.query("UPDATE character_builders SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [builderId]);
        else if (state === 'credential-expire') await pool.query("UPDATE character_builder_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [hash(jar.get(`rpg_builder_${identity}`)!)]);
        else expect((await request('/api/character-builder/logout', {}, identity)).statusCode).toBe(200);
        finish!({ ...cardDraft(), displayName: 'Stale private generated name' });
        const response = await generated;
        expect(response.statusCode, response.body).toBe(expected);
        expect(response.body).not.toContain('Stale private generated name');
        expect(response.json()).not.toHaveProperty('card');
      } finally { finish?.(cardDraft()); await generated; }
    });

    it('hides provider details for bad shapes, failures, timeouts, and a missing capability', async () => {
      for (const output of [{ ...cardDraft(), strongestTrait: 'luck' }, { ...cardDraft(), hidden: 'provider-secret', displayName: 'x'.repeat(81) }, 42]) {
        generateCard.mockResolvedValueOnce(output);
        const response = await postCard();
        expect(response.statusCode, response.body).toBe(502);
        expect(response.json().code).toBe('generation_failed');
        expect(response.json()).not.toHaveProperty('card');
        expect(response.body).not.toContain('provider-secret');
      }
      generateCard.mockRejectedValueOnce(new Error('Private credentials in upstream error'));
      const failed = await postCard();
      expect(failed.statusCode).toBe(502);
      expect(failed.body).not.toContain('Private credentials');
      generateCard.mockRejectedValueOnce(new ProviderError('timeout', 'ClewdR'));
      const timedOut = await postCard();
      expect(timedOut.statusCode).toBe(504);
      expect(timedOut.json().code).toBe('generation_timeout');

      await app.close();
      app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, provider: { plan: provider.plan.bind(provider), render: provider.render.bind(provider) }, serveStatic: false });
      const unavailable = await postCard();
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json().code).toBe('generation_unavailable');
      expect((await request('/api/character-builder/generate-card', {})).statusCode).toBe(401);
    });

    it('bounds a hung provider with a safe timeout', async () => {
      await app.close();
      app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, provider, providerTimeoutMs: 25, serveStatic: false });
      generateCard.mockImplementationOnce(() => new Promise(() => {}));
      const response = await postCard();
      expect(response.statusCode).toBe(504);
      expect(response.json().code).toBe('generation_timeout');
    });
  });
});
