import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const blankDraft = () => ({
  schemaVersion: 1 as const, displayName: '', pronouns: '', appearance: '', personality: '', backstory: '',
  traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, specialty: '', flaw: '', possessions: ['', '', ''],
  connection: '', secret: '', extensions: {},
});
const validDraft = () => ({ ...blankDraft(), displayName: 'The hidden cartographer', backstory: 'A private past.', secret: 'Knows the director-only route.', possessions: ['', 'Compass', ''], extensions: { source: 'player' } });

suite('private reusable character builders', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let hostToken: string;
  let jar: Map<string, string>;
  const cookies = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  async function request(url: string, payload?: Record<string, unknown>, identityId?: string, headers: Record<string, string> = {}) {
    const response = await app.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, cookie: cookies(), ...(identityId === undefined ? {} : { 'x-rpg-identity': identityId }), ...headers }, ...(payload === undefined ? {} : { payload }) });
    const setCookie = response.headers['set-cookie'];
    for (const value of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
      const pair = String(value).split(';')[0]!;
      const separator = pair.indexOf('=');
      jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return response;
  }
  async function create(label = 'A player', instructions = 'Keep the secret private.') {
    const response = await request('/api/character-builders', { commandId: randomUUID(), label, instructions });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function access(token: string) {
    const response = await request('/api/character-builder/access', { token });
    expect(response.statusCode, response.body).toBe(200);
    return { ...response.json(), cookie: String(response.headers['set-cookie']) };
  }
  beforeEach(async () => {
    hostToken = `builder-test-host-${randomUUID()}`;
    jar = new Map();
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    expect((await request('/api/auth/host', { token: hostToken })).statusCode).toBe(200);
  });
  afterEach(async () => { await app?.close(); await pool?.end(); });

  it('creates reusable links with private summaries, stable retries, and hashed credentials only', async () => {
    const command = { commandId: randomUUID(), label: '  A player  ', instructions: 'One secret, please.' };
    const response = await request('/api/character-builders', command);
    expect(response.statusCode, response.body).toBe(200);
    const link = response.json();
    expect(link.builder).toMatchObject({ label: 'A player', instructions: command.instructions, revokedAt: null, submittedAt: null, submittedTemplate: null });
    expect(Date.parse(link.builder.expiresAt) - Date.parse(link.builder.createdAt)).toBe(30 * 86400 * 1000);
    expect((await request('/api/character-builders', command)).json()).toEqual(link);
    expect((await request(`/api/character-builders/${link.builder.id}/link`)).json()).toEqual(link);
    expect((await request('/api/character-builders', { ...command, label: 'Changed' })).statusCode).toBe(409);
    expect(Object.keys(link.builder).sort()).toEqual(['id', 'label', 'instructions', 'createdAt', 'expiresAt', 'revokedAt', 'submittedAt', 'submittedTemplate'].sort());
    expect((await request('/api/character-builders')).json()).toEqual({ builders: [link.builder] });
    const row = (await pool.query('SELECT * FROM character_builders WHERE id=$1', [link.builder.id])).rows[0];
    expect(row.token_hash).toBe(hash(link.token));
    const receipt = (await pool.query('SELECT response FROM command_receipts WHERE actor_id=$1 AND command_id=$2', [hash(hostToken), command.commandId])).rows[0];
    expect(receipt.response).toEqual({ builderId: link.builder.id });
    expect(JSON.stringify(row)).not.toContain(link.token);
    expect(JSON.stringify(receipt)).not.toContain(link.token);
    const first = await access(link.token);
    const second = await access(link.token);
    expect(first.identityId).toMatch(/^[a-f0-9]{32}$/);
    expect(second.identityId).not.toBe(first.identityId);
    expect(first.cookie).toContain(`rpg_builder_${first.identityId}=`);
    expect(first.cookie).toContain('HttpOnly');
    expect(first.cookie).toContain('SameSite=Strict');
    expect(first.cookie).not.toContain('Secure');
    expect(Number(/Max-Age=(\d+)/.exec(first.cookie)![1])).toBeLessThanOrEqual(30 * 86400);
    expect(first.builder).toMatchObject({ id: link.builder.id, revision: 0, draft: blankDraft(), submittedTemplate: null });
    const credential = jar.get(`rpg_builder_${first.identityId}`)!;
    expect((await pool.query('SELECT token_hash FROM character_builder_credentials WHERE token_hash=$1', [hash(credential)])).rowCount).toBe(1);
    expect((await pool.query('SELECT 1 FROM credentials WHERE token_hash=$1', [hash(credential)])).rowCount).toBe(0);
  });

  it('saves incomplete forms, preserves private fields and allocation, and resumes across a server restart', async () => {
    const link = await create();
    const identity = (await access(link.token)).identityId;
    const draft = { ...blankDraft(), displayName: '', secret: 'An unfinished secret', possessions: ['', '', 'Map'], traits: { force: 2, finesse: 2, wits: 2, presence: 2 } };
    const command = { commandId: randomUUID(), expectedRevision: 0, draft };
    const saved = await request('/api/character-builder/save', command, identity);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ id: link.builder.id, revision: 1, draft });
    expect((await request('/api/character-builder/save', command, identity)).json()).toEqual(saved.json());
    expect((await request('/api/character-builder/save', { ...command, draft: blankDraft() }, identity)).statusCode).toBe(409);
    expect((await request('/api/character-builder/save', { ...command, commandId: randomUUID() }, identity)).statusCode).toBe(409);
    await app.close();
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    expect((await request('/api/character-builder', undefined, identity)).json()).toEqual(saved.json());
    expect((await access(link.token)).builder).toEqual(saved.json());
    expect((await request('/api/library')).json().characters).toEqual([]);
  });

  it('submits the current supplied form once, trims blank slots, and keeps the resulting card unapproved in a custom session', async () => {
    const link = await create();
    const identity = (await access(link.token)).identityId;
    const draft = validDraft();
    const command = { commandId: randomUUID(), expectedRevision: 0, draft };
    const submitted = await request('/api/character-builder/submit', command, identity);
    expect(submitted.statusCode, submitted.body).toBe(200);
    const snapshot = submitted.json();
    expect(snapshot).toMatchObject({ revision: 1, submittedTemplate: { version: 1 }, draft: { ...draft, possessions: ['Compass'] } });
    expect((await request('/api/character-builder/submit', command, identity)).json()).toEqual(snapshot);
    expect((await request('/api/character-builder/submit', { ...command, commandId: randomUUID(), expectedRevision: 1 }, identity)).statusCode).toBe(409);
    expect((await request('/api/character-builder/save', { commandId: randomUUID(), expectedRevision: 1, draft: blankDraft() }, identity)).statusCode).toBe(409);
    const library = (await request('/api/library')).json();
    expect(library.characters).toEqual([{ id: snapshot.submittedTemplate.templateId, version: 1, definition: { ...draft, possessions: ['Compass'] } }]);
    const summary = (await request('/api/character-builders')).json().builders[0];
    expect(summary.submittedTemplate).toEqual(snapshot.submittedTemplate);
    expect(summary.submittedAt).not.toBeNull();
    expect(JSON.stringify(summary)).not.toContain(draft.secret);
    const starter = (await request('/api/library/starter')).json();
    const scenario = (await request('/api/library/scenarios', { commandId: randomUUID(), expectedVersion: 0, definition: starter.scenario })).json();
    const created = (await request('/api/sessions', { commandId: randomUUID(), scenario: { templateId: scenario.id, version: 1 }, characters: [snapshot.submittedTemplate, snapshot.submittedTemplate] })).json();
    const director = (await request(`/api/sessions/${created.sessionId}`)).json();
    expect(director.characterDetails).toHaveLength(2);
    for (const character of director.characterDetails) {
      expect(character.approved).toBe(false);
      expect(character.draft).toEqual(library.characters[0].definition);
    }
    expect(director.setup.started).toBe(false);
  });

  it('requires final card validity and rejects forged fields, bounds, types, and excess bytes on draft saves', async () => {
    const identity = (await access((await create()).token)).identityId;
    for (const draft of [blankDraft(), { ...validDraft(), traits: { force: 2, finesse: 2, wits: 2, presence: 2 } }]) {
      expect((await request('/api/character-builder/submit', { commandId: randomUUID(), expectedRevision: 0, draft }, identity)).statusCode).toBe(400);
    }
    const invalid = [
      { ...blankDraft(), approved: true }, { ...blankDraft(), owner_id: hash(hostToken) },
      { ...blankDraft(), displayName: 'x'.repeat(81) }, { ...blankDraft(), possessions: ['', '', '', ''] },
      { ...blankDraft(), traits: { force: 3, finesse: 1, wits: 1, presence: 0 } },
      { ...blankDraft(), traits: { force: 0.5, finesse: 1, wits: 1, presence: 0 } },
      { ...blankDraft(), traits: { force: 2, finesse: 1, wits: 1, presence: 0, extra: 1 } },
      { ...blankDraft(), extensions: { nested: { url: 'https://invalid.test' } } },
      { ...blankDraft(), extensions: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [String(i), '界'.repeat(1400)])) },
    ];
    for (const draft of invalid) expect((await request('/api/character-builder/save', { commandId: randomUUID(), expectedRevision: 0, draft }, identity)).statusCode).toBe(400);
    expect((await request('/api/character-builder', undefined, identity)).json().revision).toBe(0);
  });

  it('isolates builders from the host, other builders, player/stage identities, library, and session routes', async () => {
    const first = await create('First');
    const second = await create('Second');
    const firstIdentity = (await access(first.token)).identityId;
    const secondIdentity = (await access(second.token)).identityId;
    await request('/api/character-builder/save', { commandId: randomUUID(), expectedRevision: 0, draft: { ...blankDraft(), secret: 'Only the first builder' } }, firstIdentity);
    expect((await request('/api/character-builder', undefined, secondIdentity)).json().draft.secret).toBe('');
    for (const url of ['/api/character-builders', `/api/character-builders/${first.builder.id}/link`, '/api/library', '/api/library/starter', '/api/sessions']) {
      expect((await request(url, undefined, firstIdentity)).statusCode).toBe(401);
    }
    expect((await request('/api/character-builders', { commandId: randomUUID(), label: 'Forged' }, firstIdentity)).statusCode).toBe(401);
    expect((await request(`/api/character-builders/${second.builder.id}/revoke`, { commandId: randomUUID() }, firstIdentity)).statusCode).toBe(401);
    expect((await request('/api/character-builder')).statusCode).toBe(401);
    const host = await request('/api/auth/host', { token: hostToken, tab: true });
    const hostIdentity = host.json().identityId;
    expect((await request('/api/character-builder', undefined, hostIdentity)).statusCode).toBe(401);
    const session = (await request('/api/sessions', { commandId: randomUUID() })).json();
    expect((await request(`/api/sessions/${session.sessionId}`, undefined, firstIdentity)).statusCode).toBe(401);
    for (const role of ['player', 'stage']) {
      const redeemed = await request('/api/auth/redeem', { token: session.invites.find((invite: { role: string }) => invite.role === role).token, tab: true });
      expect((await request('/api/character-builder', undefined, redeemed.json().identityId)).statusCode).toBe(401);
      expect((await request('/api/character-builders', undefined, redeemed.json().identityId)).statusCode).toBe(403);
    }
    jar.set(`rpg_tab_${firstIdentity}`, jar.get(`rpg_builder_${firstIdentity}`)!);
    expect((await request('/api/library', undefined, firstIdentity)).statusCode).toBe(401);
    jar.set(`rpg_builder_${hostIdentity}`, jar.get(`rpg_tab_${hostIdentity}`)!);
    expect((await request('/api/character-builder', undefined, hostIdentity)).statusCode).toBe(401);
    expect((await request('/api/authoring/generate-field', {}, firstIdentity)).statusCode).toBe(401);
    expect((await request('/api/character-builder/save', { commandId: randomUUID(), expectedRevision: 0, draft: blankDraft(), builderId: first.builder.id }, secondIdentity)).statusCode).toBe(400);
  });

  it('never falls back for missing, duplicate, malformed, or conflicting identity selectors', async () => {
    const identity = (await access((await create()).token)).identityId;
    expect((await request(`/api/character-builder?identity=${identity}`)).statusCode).toBe(200);
    for (const invalid of ['', 'wrong', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(32)]) {
      expect((await request('/api/character-builder', undefined, invalid)).statusCode).toBe(401);
    }
    expect((await request(`/api/character-builder?identity=${identity}`, undefined, 'b'.repeat(32))).statusCode).toBe(401);
    expect((await request(`/api/character-builder?identity=${identity}&identity=${identity}`)).statusCode).toBe(401);
    jar.delete(`rpg_builder_${identity}`);
    expect((await request('/api/character-builder', undefined, identity)).statusCode).toBe(401);
    expect((await request('/api/library')).statusCode).toBe(200);
  });

  it('keeps manager reads and revocation scoped to the owning host', async () => {
    const link = await create();
    await pool.query('UPDATE character_builders SET owner_id=$2 WHERE id=$1', [link.builder.id, 'another-host']);
    expect((await request('/api/character-builders')).json()).toEqual({ builders: [] });
    expect((await request(`/api/character-builders/${link.builder.id}/link`)).statusCode).toBe(404);
    expect((await request(`/api/character-builders/${link.builder.id}/revoke`, { commandId: randomUUID() })).statusCode).toBe(404);
  });

  it.each(['revoked', 'expired'] as const)('blocks %s grants, all issued credentials and saved command replays while preserving submitted cards', async (state) => {
    const link = await create();
    const identities = [(await access(link.token)).identityId, (await access(link.token)).identityId];
    const command = { commandId: randomUUID(), expectedRevision: 0, draft: validDraft() };
    const submitted = (await request('/api/character-builder/submit', command, identities[0])).json();
    if (state === 'revoked') {
      const revoke = { commandId: randomUUID() };
      const response = await request(`/api/character-builders/${link.builder.id}/revoke`, revoke);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().revokedAt).not.toBeNull();
      expect((await request(`/api/character-builders/${link.builder.id}/revoke`, revoke)).json()).toEqual(response.json());
      expect((await pool.query('SELECT 1 FROM character_builder_credentials WHERE builder_id=$1 AND revoked_at IS NULL', [link.builder.id])).rowCount).toBe(0);
    } else await pool.query("UPDATE character_builders SET expires_at=now()-interval '1 second' WHERE id=$1", [link.builder.id]);
    expect((await request(`/api/character-builders/${link.builder.id}/link`)).statusCode).toBe(404);
    expect((await request('/api/character-builder/access', { token: link.token })).statusCode).toBe(401);
    for (const identity of identities) {
      expect((await request('/api/character-builder', undefined, identity)).statusCode).toBe(401);
      expect((await request('/api/character-builder/submit', command, identity)).statusCode).toBe(401);
      expect((await request('/api/character-builder/save', { commandId: randomUUID(), expectedRevision: 1, draft: blankDraft() }, identity)).statusCode).toBe(401);
    }
    expect((await request('/api/library')).json().characters[0].id).toBe(submitted.submittedTemplate.templateId);
  });

  it('caps credential lifetime at grant expiry, sets HTTPS cookie security, and checks credential expiry separately', async () => {
    const link = await create();
    await pool.query("UPDATE character_builders SET expires_at=now()+interval '10 minutes' WHERE id=$1", [link.builder.id]);
    await app.close();
    const secureOrigin = 'https://show.example.test';
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin: secureOrigin, serveStatic: false });
    const response = await request('/api/character-builder/access', { token: link.token }, undefined, { origin: secureOrigin });
    expect(response.statusCode, response.body).toBe(200);
    const identity = response.json().identityId;
    expect(String(response.headers['set-cookie'])).toContain('Secure');
    const age = Number(/Max-Age=(\d+)/.exec(String(response.headers['set-cookie']))![1]);
    expect(age).toBeGreaterThan(0);
    expect(age).toBeLessThanOrEqual(600);
    const credential = jar.get(`rpg_builder_${identity}`)!;
    await pool.query("UPDATE character_builder_credentials SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [hash(credential)]);
    expect((await request('/api/character-builder', undefined, identity)).statusCode).toBe(401);
    expect((await request('/api/character-builder/access', { token: link.token }, undefined, { origin: secureOrigin })).statusCode).toBe(200);
  });

  it('logs out only the selected builder credential and permits access again through the reusable link', async () => {
    const link = await create();
    const first = (await access(link.token)).identityId;
    const second = (await access(link.token)).identityId;
    const old = jar.get(`rpg_builder_${first}`)!;
    const logout = await request('/api/character-builder/logout', {}, first);
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ ok: true });
    expect(String(logout.headers['set-cookie'])).toContain(`rpg_builder_${first}=`);
    jar.set(`rpg_builder_${first}`, old);
    expect((await request('/api/character-builder', undefined, first)).statusCode).toBe(401);
    expect((await request('/api/character-builder', undefined, second)).statusCode).toBe(200);
    expect((await request('/api/library')).statusCode).toBe(200);
    expect((await access(link.token)).builder.id).toBe(link.builder.id);
  });

  it('serializes simultaneous saves, submissions, and save-versus-submit without duplicate cards', async () => {
    for (const operations of [['save', 'save'], ['submit', 'submit'], ['save', 'submit']]) {
      const link = await create(operations.join('-'));
      const identity = (await access(link.token)).identityId;
      const responses = await Promise.all(operations.map((operation, index) => request(`/api/character-builder/${operation}`, { commandId: randomUUID(), expectedRevision: 0, draft: { ...validDraft(), displayName: `Concurrent ${index}` } }, identity)));
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      const final = (await request('/api/character-builder', undefined, identity)).json();
      expect(final.revision).toBe(1);
      const winning = responses.find((response) => response.statusCode === 200)!.json();
      expect(final).toEqual(winning);
      if (final.submittedTemplate) expect((await pool.query('SELECT 1 FROM library_versions WHERE template_id=$1', [final.submittedTemplate.templateId])).rowCount).toBe(1);
    }
  });

  it('replays identical concurrent commands and prevents operation collisions', async () => {
    const createCommand = { commandId: randomUUID(), label: 'Concurrent creation' };
    const created = await Promise.all([request('/api/character-builders', createCommand), request('/api/character-builders', createCommand)]);
    expect(created.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(created[0]!.json()).toEqual(created[1]!.json());
    const link = created[0]!.json();
    const identity = (await access(link.token)).identityId;
    const command = { commandId: randomUUID(), expectedRevision: 0, draft: validDraft() };
    const submitted = await Promise.all([request('/api/character-builder/submit', command, identity), request('/api/character-builder/submit', command, identity)]);
    expect(submitted.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(submitted[0]!.json()).toEqual(submitted[1]!.json());
    expect((await request('/api/character-builder/save', command, identity)).statusCode).toBe(409);
    expect((await request(`/api/character-builders/${link.builder.id}/revoke`, { commandId: createCommand.commandId })).statusCode).toBe(409);
    const other = await create('Other');
    const revoke = { commandId: randomUUID() };
    expect((await request(`/api/character-builders/${link.builder.id}/revoke`, revoke)).statusCode).toBe(200);
    expect((await request(`/api/character-builders/${other.builder.id}/revoke`, revoke)).statusCode).toBe(409);
  });

  it('replays an earlier saved response after submission without reverting the terminal draft', async () => {
    const identity = (await access((await create()).token)).identityId;
    const save = { commandId: randomUUID(), expectedRevision: 0, draft: blankDraft() };
    const saved = (await request('/api/character-builder/save', save, identity)).json();
    const submitted = await request('/api/character-builder/submit', { commandId: randomUUID(), expectedRevision: 1, draft: validDraft() }, identity);
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect((await request('/api/character-builder/save', save, identity)).json()).toEqual(saved);
    expect((await request('/api/character-builder', undefined, identity)).json()).toEqual(submitted.json());
  });

  it('checks revocation after waiting for the grant lock before returning a command receipt', async () => {
    const link = await create();
    const identity = (await access(link.token)).identityId;
    const command = { commandId: randomUUID(), expectedRevision: 0, draft: validDraft() };
    expect((await request('/api/character-builder/submit', command, identity)).statusCode).toBe(200);
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    const blockingPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await blocker.query('SELECT id FROM character_builders WHERE id=$1 FOR UPDATE', [link.builder.id]);
    const replay = request('/api/character-builder/submit', command, identity);
    try {
      let waiting = false;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !waiting) {
        waiting = Boolean((await pool.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pg_blocking_pids(pid) @> ARRAY[$1::int]', [blockingPid])).rowCount);
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting, 'The receipt replay must wait for the builder grant lock.').toBe(true);
      await blocker.query('UPDATE character_builders SET revoked_at=clock_timestamp() WHERE id=$1', [link.builder.id]);
      await blocker.query('COMMIT');
      expect((await replay).statusCode).toBe(401);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await replay;
    }
  });

  it('inherits strict origin checks on every builder mutation and rejects forged create/access/revoke payloads', async () => {
    const link = await create();
    const identity = (await access(link.token)).identityId;
    for (const [url, payload] of [
      ['/api/character-builders', { commandId: randomUUID(), label: 'New' }],
      [`/api/character-builders/${link.builder.id}/revoke`, { commandId: randomUUID() }],
      ['/api/character-builder/access', { token: link.token }],
      ['/api/character-builder/save', { commandId: randomUUID(), expectedRevision: 0, draft: blankDraft() }],
      ['/api/character-builder/submit', { commandId: randomUUID(), expectedRevision: 0, draft: validDraft() }],
      ['/api/character-builder/logout', {}],
    ] as Array<[string, Record<string, unknown>]>) {
      for (const rejectedOrigin of ['https://attacker.example', '']) expect((await request(url, payload, identity, { origin: rejectedOrigin })).statusCode).toBe(403);
    }
    expect((await request('/api/character-builders', { commandId: randomUUID(), label: ' ', instructions: '' })).statusCode).toBe(400);
    expect((await request('/api/character-builders', { commandId: randomUUID(), label: 'Valid', instructions: 'x'.repeat(4001) })).statusCode).toBe(400);
    expect((await request('/api/character-builder/access', { token: link.token, role: 'host' })).statusCode).toBe(400);
    expect((await request('/api/character-builder/access', { token: 'missing' })).statusCode).toBe(401);
    expect((await request(`/api/character-builders/${link.builder.id}/revoke`, { commandId: randomUUID(), owner: hash(hostToken) })).statusCode).toBe(400);
  });
});
