import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardDraftSchema, type AiProvider, type CardDraft, type CardGenerationInput } from '@rpg/contracts';
import { ProviderError } from '@rpg/providers';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeAiProvider } from '../src/fake-provider';
import { AppError } from '../src/repository';
import { cardFromDraft, executeCardGeneration } from '../src/card-generation';

const draft = (overrides: Partial<CardDraft> = {}): CardDraft => CardDraftSchema.parse({
  displayName: ' Mara Venn ', pronouns: 'she/her', appearance: ' Tall, ink-stained hands. ', personality: 'Dry and watchful.',
  backstory: 'Left the archive after a fire.', specialty: 'Reading old maps.', flaw: 'Trusts no one.', connection: 'Owes the captain a favor.',
  secret: 'Set the fire herself.', possessions: [' brass compass ', 'letter'], strongestTrait: 'wits', weakestTrait: 'force', ...overrides,
});
const input = (overrides: Partial<CardGenerationInput> = {}): CardGenerationInput => ({ prompt: 'A cartographer who is clever', keepFilled: true, ...overrides });
const failure = async (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected a rejection'); }, (error: unknown) => error as AppError);

describe('card repair', () => {
  it('maps strongest to +2, weakest to +0 and the other two to +1', () => {
    const { card } = cardFromDraft(draft({ strongestTrait: 'presence', weakestTrait: 'finesse' }), input());
    expect(card.traits).toEqual({ force: 1, finesse: 0, wits: 1, presence: 2 });
    expect(card.displayName).toBe('Mara Venn');
    expect(card.appearance).toBe('Tall, ink-stained hands.');
    expect(card.extensions).toEqual({});
  });
  it('moves the weakest trait when both name the same trait and says so', () => {
    const forceBoth = cardFromDraft(draft({ strongestTrait: 'force', weakestTrait: 'force' }), input());
    expect(forceBoth.card.traits).toEqual({ force: 2, finesse: 0, wits: 1, presence: 1 });
    expect(forceBoth.notes).toContain('The AI picked the same trait as best and weakest, so Finesse is now the weakest.');
    const witsBoth = cardFromDraft(draft({ strongestTrait: 'wits', weakestTrait: 'wits' }), input());
    expect(witsBoth.card.traits).toEqual({ force: 0, finesse: 1, wits: 2, presence: 1 });
    expect(witsBoth.notes).toContain('The AI picked the same trait as best and weakest, so Force is now the weakest.');
  });
  it('never keeps traits even when keepFilled is on', () => {
    const { card } = cardFromDraft(draft(), input({ current: { kind: 'character', traits: { force: 2, finesse: 1, wits: 1, presence: 0 } } }));
    expect(card.traits).toEqual({ force: 0, finesse: 1, wits: 2, presence: 1 });
  });
  it('merges possessions by position, trims, drops blanks and caps at three', () => {
    const kept = cardFromDraft(draft({ possessions: ['a', 'b', 'c'] }), input({ current: { kind: 'character', possessions: ['  mine  ', '', ' '] } }));
    expect(kept.card.possessions).toEqual(['mine', 'b', 'c']);
    const off = cardFromDraft(draft({ possessions: [' a ', '  ', 'c'] }), input({ keepFilled: false, current: { kind: 'character', possessions: ['mine'] } }));
    expect(off.card.possessions).toEqual(['a', 'c']);
    expect(cardFromDraft(draft({ possessions: [] }), input()).card.possessions).toEqual([]);
  });
  it('uses stated pronouns as written in the description without suggesting them', () => {
    const result = cardFromDraft(draft({ pronouns: ' She/Her ' }), input({ prompt: 'A pilot. She goes by her call sign.' }));
    expect(result).toMatchObject({ pronounsSuggested: false, card: { pronouns: 'She/Her' } });
  });
  it('marks pronouns the description never gave as suggested', () => {
    const result = cardFromDraft(draft({ pronouns: 'they/them' }), input({ prompt: 'A cartographer who is clever, and they' }));
    expect(result.pronounsSuggested).toBe(true);
    expect(result.card.pronouns).toBe('they/them');
    expect(result.notes).toEqual([]);
  });
  it('leaves blank pronouns blank with a note', () => {
    const result = cardFromDraft(draft({ pronouns: '  ' }), input());
    expect(result.card.pronouns).toBe('');
    expect(result.pronounsSuggested).toBe(false);
    expect(result.notes).toContain('The pronouns box is blank. Add pronouns if you want them.');
  });
  it('keeps pronouns typed by the person exactly and never marks them suggested', () => {
    const result = cardFromDraft(draft({ pronouns: 'he/him' }), input({ current: { kind: 'character', pronouns: ' xe/xem ' } }));
    expect(result).toMatchObject({ pronounsSuggested: false, card: { pronouns: ' xe/xem ' } });
    const replaced = cardFromDraft(draft({ pronouns: 'he/him' }), input({ keepFilled: false, current: { kind: 'character', pronouns: 'xe/xem' } }));
    expect(replaced).toMatchObject({ pronounsSuggested: true, card: { pronouns: 'he/him' } });
  });
  it('copies each filled text box back exactly, including the secret, and adds one note', () => {
    const current = {
      kind: 'character' as const, displayName: 'Own Name', appearance: ' own look ', personality: 'own mind', backstory: 'own past',
      specialty: 'own skill', flaw: 'own flaw', connection: 'own tie', secret: 'own secret',
    };
    const { card, notes } = cardFromDraft(draft(), input({ current }));
    expect(card).toMatchObject({ displayName: 'Own Name', appearance: ' own look ', personality: 'own mind', backstory: 'own past', specialty: 'own skill', flaw: 'own flaw', connection: 'own tie', secret: 'own secret' });
    expect(notes.filter(note => note === 'Kept what you already wrote.')).toHaveLength(1);
  });
  it('keeps only the filled boxes and writes the blank ones', () => {
    const { card, notes } = cardFromDraft(draft(), input({ current: { kind: 'character', secret: 'mine', flaw: '   ' } }));
    expect(card.secret).toBe('mine');
    expect(card.flaw).toBe('Trusts no one.');
    expect(notes).toContain('Kept what you already wrote.');
  });
  it('replaces everything when keepFilled is off and adds no kept note', () => {
    const { card, notes } = cardFromDraft(draft(), input({ keepFilled: false, current: { kind: 'character', secret: 'mine', displayName: 'Own' } }));
    expect(card.secret).toBe('Set the fire herself.');
    expect(card.displayName).toBe('Mara Venn');
    expect(notes).not.toContain('Kept what you already wrote.');
  });
  it('rejects a draft with no name when nothing was kept', () => {
    expect(() => cardFromDraft(draft({ displayName: '   ' }), input())).toThrow(AppError);
    expect(() => cardFromDraft(draft({ displayName: '   ' }), input({ current: { kind: 'character', displayName: 'Own' } }))).not.toThrow();
  });
});

describe('card executor', () => {
  const provider = (generateCard?: AiProvider['generateCard']): AiProvider => ({ plan: vi.fn(), render: vi.fn(), ...(generateCard ? { generateCard } : {}) });
  it('returns a checked response', async () => {
    const result = await executeCardGeneration(provider(async () => draft()), input());
    expect(result.card.displayName).toBe('Mara Venn');
    expect(result.pronounsSuggested).toBe(true);
    expect(result.notes).toEqual([]);
  });
  it('caps notes at ten', async () => {
    const many = { ...draft(), pronouns: '' };
    const response = await executeCardGeneration(provider(async () => many), input());
    expect(response.notes.length).toBeLessThanOrEqual(10);
  });
  it('reports 503 when the provider cannot write cards', async () => {
    const error = await failure(executeCardGeneration(provider(), input()));
    expect(error).toMatchObject({ status: 503, code: 'generation_unavailable', message: 'AI drafting is not available right now. You can still fill in the form yourself.' });
  });
  it('maps a provider timeout and a hung provider to 504', async () => {
    const timeout = await failure(executeCardGeneration(provider(async () => { throw new ProviderError('timeout', 'ClewdR'); }), input()));
    expect(timeout).toMatchObject({ status: 504, code: 'generation_timeout', message: 'The AI took too long. Try again, or fill in the form yourself.' });
    const hung = await failure(executeCardGeneration(provider(() => new Promise(() => {})), input(), 20));
    expect(hung.status).toBe(504);
  });
  it('maps thrown errors, invalid drafts and blank names to 502 without provider text', async () => {
    const thrown = await failure(executeCardGeneration(provider(async () => { throw new Error('Private key leaked here'); }), input()));
    expect(thrown).toMatchObject({ status: 502, code: 'generation_failed', message: "The AI's draft did not fit the form. Try again, or fill in the form yourself." });
    expect(thrown.message).not.toContain('Private key');
    const invalid = await failure(executeCardGeneration(provider(async () => ({ displayName: 'x', strongestTrait: 'luck', weakestTrait: 'force' }) as unknown as CardDraft), input()));
    expect(invalid.status).toBe(502);
    const blank = await failure(executeCardGeneration(provider(async () => draft({ displayName: '' })), input()));
    expect(blank.status).toBe(502);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite('director card route', () => {
  const origin = 'http://localhost:3000';
  const hostToken = `card-generation-test-${crypto.randomUUID()}`;
  const generateCard = vi.fn();
  let app: Awaited<ReturnType<typeof buildApp>>;
  let host: string;
  let player: string;
  let stage: string;
  let hostActorId: string;
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const post = (payload: unknown, credential = host) => app.inject({ method: 'POST', url: '/api/authoring/generate-card', headers: { cookie: credential, origin }, payload: payload as Record<string, unknown> });
  const plain = (extra: Partial<AiProvider> = {}): AiProvider => {
    const fake = new FakeAiProvider();
    return { plan: fake.plan.bind(fake), render: fake.render.bind(fake), ...extra };
  };
  beforeAll(async () => {
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, provider: plain({ generateCard }), providerTimeoutMs: 40, serveStatic: false });
    host = cookie(await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } }));
    const created = (await app.inject({ method: 'POST', url: '/api/sessions', headers: { origin, cookie: host }, payload: { commandId: crypto.randomUUID() } })).json();
    for (const role of ['player', 'stage']) {
      const invitation = created.invites.find((invite: { role: string }) => invite.role === role);
      const credential = cookie(await app.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token: invitation.token } }));
      if (role === 'player') player = credential; else stage = credential;
    }
    const pool = createPool(databaseUrl!);
    try { hostActorId = (await pool.query('SELECT owner_id FROM sessions WHERE id=$1', [created.sessionId])).rows[0].owner_id; } finally { await pool.end(); }
  });
  beforeEach(() => { generateCard.mockReset().mockResolvedValue(draft()); });
  afterAll(async () => { await app?.close(); });

  it('checks sign-in and role before validating or calling the AI', async () => {
    expect((await post({ nope: true }, '')).statusCode).toBe(401);
    for (const credential of [player, stage]) {
      const response = await post({ nope: true }, credential);
      expect(response.statusCode).toBe(403);
      expect(response.json().message).toBe('Only the director can generate character cards.');
    }
    expect(generateCard).not.toHaveBeenCalled();
  });
  it('rejects unknown keys, instructions and non-character context without calling the AI', async () => {
    for (const payload of [
      { prompt: 'A pilot', extra: 1 },
      { prompt: 'A pilot', instructions: 'Be nice' },
      { prompt: ' ' },
      { prompt: 'A pilot', current: { kind: 'npc', displayName: 'Keeper' } },
    ]) expect((await post(payload)).statusCode).toBe(400);
    expect(generateCard).not.toHaveBeenCalled();
  });
  it('gives the AI exactly the parsed input and returns a checked card', async () => {
    const response = await post({ prompt: '  A clever cartographer  ' });
    expect(response.statusCode, response.body).toBe(200);
    expect(generateCard).toHaveBeenLastCalledWith({ prompt: 'A clever cartographer', keepFilled: true });
    expect(response.json()).toMatchObject({ card: { displayName: 'Mara Venn', schemaVersion: 1 }, pronounsSuggested: true });
    const current = { kind: 'character', displayName: 'Own', pronouns: 'xe/xem' };
    const second = await post({ prompt: 'A pilot', keepFilled: false, current, premise: '  A drowned city.  ' });
    expect(second.statusCode, second.body).toBe(200);
    expect(generateCard).toHaveBeenLastCalledWith({ prompt: 'A pilot', keepFilled: false, current, premise: 'A drowned city.' });
  });
  it('reports 503 without generateCard', async () => {
    const other = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, provider: plain(), serveStatic: false });
    try {
      const response = await other.inject({ method: 'POST', url: '/api/authoring/generate-card', headers: { origin, cookie: host }, payload: { prompt: 'A pilot' } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'generation_unavailable' });
    } finally { await other.close(); }
  });
  it('hides provider text and bounds a hung provider', async () => {
    generateCard.mockRejectedValueOnce(new Error('Private key and provider body must not appear'));
    const failed = await post({ prompt: 'A pilot' });
    expect(failed.statusCode).toBe(502);
    expect(failed.body).not.toContain('Private key');
    generateCard.mockResolvedValueOnce({ displayName: 'x' });
    expect((await post({ prompt: 'A pilot' })).statusCode).toBe(502);
    generateCard.mockImplementationOnce(() => new Promise(() => {}));
    expect((await post({ prompt: 'A pilot' })).statusCode).toBe(504);
  });
  it('writes nothing for this host', async () => {
    const pool = createPool(databaseUrl!);
    const count = async () => (await pool.query(
      `SELECT (SELECT count(*) FROM library_templates WHERE owner_id=$1) AS templates,
              (SELECT count(*) FROM sessions WHERE owner_id=$1) AS sessions,
              (SELECT count(*) FROM command_receipts WHERE actor_id=$1) AS receipts`, [hostActorId])).rows[0];
    try {
      const before = await count();
      expect((await post({ prompt: 'A pilot' })).statusCode).toBe(200);
      expect(await count()).toEqual(before);
    } finally { await pool.end(); }
  });
});
