import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeAiProvider } from '../src/fake-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite('private director field drafting', () => {
  const origin = 'http://localhost:3000';
  const hostToken = 'field-generation-test-host-credential';
  const generateField = vi.fn();
  let app: Awaited<ReturnType<typeof buildApp>>;
  let host: string;
  let player: string;
  let stage: string;
  let sessionId: string;
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const post = (payload: Record<string, unknown>, credential = host, requestOrigin = origin) => app.inject({ method: 'POST', url: '/api/authoring/generate-field', headers: { cookie: credential, origin: requestOrigin }, payload });
  beforeAll(async () => {
    const provider = new FakeAiProvider(); provider.generateField = generateField;
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, provider, providerTimeoutMs: 40 });
    host = cookie(await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } }));
    const created = (await app.inject({ method: 'POST', url: '/api/sessions', headers: { origin, cookie: host }, payload: { commandId: crypto.randomUUID() } })).json();
    sessionId = created.sessionId;
    for (const role of ['player', 'stage']) {
      const invitation = created.invites.find((invite: { role: string }) => invite.role === role);
      const credential = cookie(await app.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token: invitation.token } }));
      if (role === 'player') player = credential; else stage = credential;
    }
  });
  beforeEach(() => { generateField.mockReset().mockResolvedValue({ text: 'Expanded description.' }); });
  afterAll(async () => { await app?.close(); });

  it('authorizes the host and origin before validating input or invoking AI', async () => {
    expect((await post({ secret: 'invalid body' }, '')).statusCode).toBe(401);
    for (const credential of [player, stage]) expect((await post({ secret: 'invalid body' }, credential)).statusCode).toBe(403);
    expect((await post({ field: 'scenario.premise', seed: 'short' }, host, 'https://untrusted.example')).statusCode).toBe(403);
    expect(generateField).not.toHaveBeenCalled();
  });
  it('rejects unsupported fields, hidden context, and invalid seeds without calling AI', async () => {
    for (const payload of [{ field: 'voiceProfileId', seed: 'voice' }, { field: 'scenario.premise', seed: ' ' }, { field: 'scenario.premise', seed: 'x'.repeat(12001) }, { field: 'scenario.premise', seed: 'short', context: { secrets: 'private' } }]) expect((await post(payload)).statusCode).toBe(400);
    expect(generateField).not.toHaveBeenCalled();
  });
  it('forwards supplied same-character details without loading or changing saved characters', async () => {
    const read = () => app.inject({ method: 'GET', url: `/api/sessions/${sessionId}`, headers: { cookie: host } });
    const before = (await read()).json();
    const characterContext = { kind: 'npc', displayName: 'Unsaved keeper', role: 'Beacon keeper', hiddenIdentity: 'An invented private identity', knowledge: [{ statement: '', category: 'belief' }], secrets: ['An invented secret'] };
    const payload = { field: 'npc.motivation', seed: '', characterContext };
    const result = await post(payload);
    expect(result.statusCode, result.body).toBe(200);
    expect(generateField).toHaveBeenCalledExactlyOnceWith(payload);
    expect((await read()).json()).toEqual(before);
    for (const credential of [player, stage]) expect((await post(payload, credential)).statusCode).toBe(403);
    expect(generateField).toHaveBeenCalledTimes(1);
  });
  it('accepts bounded character drafts above the general request limit and rejects excessive or mismatched context', async () => {
    const characterContext = { kind: 'npc', knowledge: Array(18).fill({ statement: 'x'.repeat(6000), category: 'fact' }) };
    const payload = { field: 'npc.motivation', seed: '界'.repeat(12000), premise: '星'.repeat(4000), characterContext };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(128 * 1024);
    const result = await post(payload);
    expect(result.statusCode, result.body).toBe(200);
    expect(generateField).toHaveBeenCalledExactlyOnceWith(payload);
    generateField.mockClear();
    for (const invalid of [
      { field: 'character.backstory', seed: 'A brief', characterContext },
      { field: 'npc.role', seed: 'A brief', characterContext: { kind: 'npc', otherCharacter: 'Unrelated private details' } },
      { field: 'npc.role', seed: '', characterContext: { kind: 'npc', knowledge: Array(21).fill({ statement: 'x'.repeat(6000), category: 'fact' }) } },
      { field: 'npc.limit', seed: '', characterContext: { kind: 'npc', role: 'Keeper' } },
    ]) expect((await post(invalid)).statusCode).toBe(400);
    const oversized = await post({ ...payload, extra: '界'.repeat(90000) });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json().message).toBe('Request body is too large');
    expect(generateField).not.toHaveBeenCalled();
  });
  it('forwards only explicitly supplied premise and optional direction without modifying the saved source', async () => {
    const read = () => app.inject({ method: 'GET', url: `/api/sessions/${sessionId}`, headers: { cookie: host } });
    const before = (await read()).json();
    const response = await post({ field: 'scene.description', seed: ' ', premise: '  A clockwork city is losing time.  ' });
    expect(response.statusCode, response.body).toBe(200);
    expect(generateField).toHaveBeenCalledExactlyOnceWith({ field: 'scene.description', seed: '', premise: 'A clockwork city is losing time.' });
    expect((await read()).json()).toEqual(before);
    for (const invalid of [
      { field: 'scene.description', seed: '', premise: ' ' },
      { field: 'scene.description', seed: '', premise: 'x'.repeat(4001) },
      { field: 'scenario.boundaries', seed: '', premise: 'A dark setting' },
      { field: 'live.publicReveal', seed: 'A reveal', premise: 'A setting' },
    ]) expect((await post(invalid)).statusCode).toBe(400);
    expect(generateField).toHaveBeenCalledTimes(1);
    expect((await post({ field: 'scene.description', seed: '', premise: 'A setting' }, player)).statusCode).toBe(403);
  });
  it('passes only the trimmed seed and target and leaves libraries, session, events, receipts and jobs unchanged', async () => {
    const pool = createPool(databaseUrl!);
    const read = async () => ({
      library: (await app.inject({ method: 'GET', url: '/api/library', headers: { cookie: host } })).json(),
      session: (await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}`, headers: { cookie: host } })).json(),
      counts: (await pool.query('SELECT (SELECT count(*) FROM audit_events) AS events, (SELECT count(*) FROM command_receipts) AS receipts, (SELECT count(*) FROM generation_jobs) AS jobs')).rows,
    });
    try {
      const before = await read();
      const response = await post({ field: 'scenario.premise', seed: '  short  ' });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ text: 'Expanded description.' });
      expect(generateField).toHaveBeenCalledExactlyOnceWith({ field: 'scenario.premise', seed: 'short' });
      expect(await read()).toEqual(before);
    } finally { await pool.end(); }
  });
  it('rejects invalid provider output and hides arbitrary provider error details', async () => {
    for (const value of [{ text: '' }, { text: 'x'.repeat(161) }, { text: 'Title', secret: 'private response' }, { text: 42 }]) {
      generateField.mockResolvedValueOnce(value);
      expect((await post({ field: 'scenario.title', seed: 'name' })).statusCode).toBe(502);
    }
    generateField.mockRejectedValueOnce(new Error('Private key and provider body must not appear'));
    const response = await post({ field: 'scenario.title', seed: 'name' });
    expect(response.statusCode).toBe(502); expect(response.body).not.toContain('Private key');
  });
  it('bounds a hung provider and never substitutes a fake result', async () => {
    generateField.mockImplementationOnce(() => new Promise(() => {}));
    const response = await post({ field: 'scenario.title', seed: 'name' });
    expect(response.statusCode).toBe(504); expect(response.json()).not.toHaveProperty('text');
  });
  it('reports an unavailable capability without substituting the fake provider', async () => {
    const provider = new FakeAiProvider();
    const other = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, provider: { plan: provider.plan.bind(provider), render: provider.render.bind(provider) } });
    try {
      const response = await other.inject({ method: 'POST', url: '/api/authoring/generate-field', headers: { origin, cookie: host }, payload: { field: 'scenario.title', seed: 'name' } });
      expect(response.statusCode).toBe(503); expect(response.json()).not.toHaveProperty('text');
    } finally { await other.close(); }
  });
});
