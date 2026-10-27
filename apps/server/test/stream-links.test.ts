import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

suite('stream link management routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let hostToken: string;
  let hostCookie: string;
  let sessionId: string;
  let characters: string[];
  async function call(url: string, payload?: Record<string, unknown>, token = hostCookie) {
    return app.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, cookie: `rpg_session=${token}` }, ...(payload === undefined ? {} : { payload }) });
  }
  async function insertCredential(row: { role: string; session_id?: string | null; character_id?: string | null; producer_grant_id?: string | null; stream_link_id?: string | null; actor_id?: string }) {
    const token = `test-${randomUUID()}`;
    await pool.query("INSERT INTO credentials(token_hash,actor_id,role,session_id,character_id,producer_grant_id,stream_link_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '1 hour')",
      [hash(token), row.actor_id ?? randomUUID(), row.role, row.session_id ?? null, row.character_id ?? null, row.producer_grant_id ?? null, row.stream_link_id ?? null]);
    return token;
  }
  async function mainShowLink() {
    const { rows } = await pool.query("SELECT id FROM stream_links WHERE session_id=$1 AND subject='show' ORDER BY created_at, id LIMIT 1", [sessionId]);
    return rows[0]!.id as string;
  }
  const links = (token = hostCookie) => call(`/api/sessions/${sessionId}/stream-links`, undefined, token);
  const create = (body: Record<string, unknown>, token = hostCookie) => call(`/api/sessions/${sessionId}/stream-links`, { commandId: randomUUID(), ...body }, token);
  async function playerToken(index = 0) {
    return insertCredential({ role: 'player', session_id: sessionId, character_id: characters[index]!, actor_id: randomUUID() });
  }

  beforeEach(async () => {
    hostToken = `stream-test-host-${randomUUID()}`;
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    const signIn = await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } });
    hostCookie = String(signIn.headers['set-cookie']).split(';')[0]!.split('=')[1]!;
    const made = await call('/api/sessions', { commandId: randomUUID() });
    expect(made.statusCode, made.body).toBe(200);
    sessionId = made.json().sessionId;
    characters = (await pool.query('SELECT id FROM characters WHERE session_id=$1 ORDER BY ordinal', [sessionId])).rows.map((r) => r.id);
  });
  afterEach(async () => { await app?.close(); await pool?.end(); });

  it('creates and shows the same re-derived token, stores only the hash, and lists no secrets', async () => {
    const mainId = await mainShowLink();
    const mainListed = (await links()).json().links;
    expect(mainListed).toHaveLength(1);
    expect(mainListed[0]).toMatchObject({ id: mainId, subject: 'show', label: 'Main show', canPresent: true, revokedAt: null, characterId: null, producerGrantId: null });
    expect(Date.parse(mainListed[0].expiresAt) - Date.parse(mainListed[0].createdAt)).toBe(2160 * 3600 * 1000);
    const command = { commandId: randomUUID(), subject: 'show' };
    const response = await call(`/api/sessions/${sessionId}/stream-links`, command);
    expect(response.statusCode, response.body).toBe(200);
    const made = response.json();
    expect(made.link).toMatchObject({ subject: 'show', label: 'Main show', canPresent: true, revokedAt: null, characterId: null, producerGrantId: null });
    expect(Date.parse(made.link.expiresAt) - Date.parse(made.link.createdAt)).toBe(90 * 86400 * 1000);
    expect(made.token).toBe(createHmac('sha256', hostToken).update(JSON.stringify(['rpg-stream-v1', made.link.id])).digest('base64url'));
    expect((await call(`/api/sessions/${sessionId}/stream-links`, command)).json()).toEqual(made);
    const shown = await call(`/api/sessions/${sessionId}/stream-links/${made.link.id}/link`);
    expect(shown.json()).toEqual(made);
    const listed = await links();
    expect(listed.json()).toEqual({ links: [made.link, mainListed[0]] });
    expect(listed.body).not.toContain(made.token);
    const row = (await pool.query('SELECT * FROM stream_links WHERE id=$1', [made.link.id])).rows[0];
    expect(row.token_hash).toBe(hash(made.token));
    expect(JSON.stringify(row)).not.toContain(made.token);
    const audit = (await pool.query("SELECT data FROM audit_events WHERE session_id=$1 AND kind='stream_link.created' ORDER BY sequence", [sessionId])).rows;
    expect(audit).toHaveLength(2);
    expect(audit[0].data).toEqual({ linkId: mainId, subject: 'show', characterId: null, producerGrantId: null });
    expect(audit[1].data).toEqual({ linkId: made.link.id, subject: 'show', characterId: null, producerGrantId: null });
    expect(JSON.stringify(audit)).not.toContain(made.token);
  });

  it('lets directors make several show links, a listen-only show link, and one personal link each', async () => {
    const mainId = await mainShowLink();
    const first = (await create({ subject: 'show' })).json();
    expect(first.link.id).not.toBe(mainId);
    const second = (await create({ subject: 'show', label: 'Backup', canPresent: false })).json();
    expect(second.link).toMatchObject({ label: 'Backup', canPresent: false });
    expect(second.link.id).not.toBe(first.link.id);
    const host = (await create({ subject: 'host' })).json();
    expect(host.link).toMatchObject({ subject: 'host', label: 'Host view', canPresent: false });
    expect((await create({ subject: 'host' })).json()).toEqual(host);
    const player = (await create({ subject: 'player', characterId: characters[0] })).json();
    expect(player.link.characterId).toBe(characters[0]);
    expect(player.link.label).toMatch(/ view$/);
    expect((await create({ subject: 'player', characterId: characters[0] })).json()).toEqual(player);
    expect((await create({ subject: 'player', characterId: randomUUID() })).statusCode).toBe(404);
    expect((await links()).json().links.map((l: { id: string }) => l.id)).toEqual([player.link.id, host.link.id, second.link.id, first.link.id, mainId]);
  });

  it('replaces an expired personal link and returns an active one', async () => {
    const old = (await create({ subject: 'host' })).json();
    await pool.query("UPDATE stream_links SET created_at=now()-interval '100 days',expires_at=now()-interval '10 days' WHERE id=$1", [old.link.id]);
    const fresh = (await create({ subject: 'host' })).json();
    expect(fresh.link.id).not.toBe(old.link.id);
    const rows = (await pool.query('SELECT id,revoked_at FROM stream_links WHERE session_id=$1 AND subject=$2', [sessionId, 'host'])).rows;
    expect(rows.find((r) => r.id === old.link.id).revoked_at).not.toBeNull();
    expect(rows.find((r) => r.id === fresh.link.id).revoked_at).toBeNull();
    expect((await call(`/api/sessions/${sessionId}/stream-links/${old.link.id}/link`)).statusCode).toBe(404);
    expect((await links()).json().links).toHaveLength(3);
  });

  it('lets a player create and see only their own link, and rejects canPresent from a player', async () => {
    const own = await playerToken(0);
    const made = await create({ subject: 'player', characterId: characters[0] }, own);
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json().link).toMatchObject({ subject: 'player', canPresent: false });
    expect((await create({ subject: 'player', characterId: characters[0] }, own)).json()).toEqual(made.json());
    expect((await create({ subject: 'player', characterId: characters[0], canPresent: true }, own)).statusCode).toBe(400);
    expect((await create({ subject: 'player', characterId: characters[1] }, own)).statusCode).toBe(403);
    expect((await create({ subject: 'show' }, own)).statusCode).toBe(403);
    expect((await create({ subject: 'host' }, own)).statusCode).toBe(403);
    const hostLink = (await create({ subject: 'host' })).json();
    const otherPlayer = (await create({ subject: 'player', characterId: characters[1] })).json();
    const mine = (await links(own)).json().links;
    expect(mine.map((l: { id: string }) => l.id)).toEqual([made.json().link.id]);
    expect((await call(`/api/sessions/${sessionId}/stream-links/${made.json().link.id}/link`, undefined, own)).json()).toEqual(made.json());
    expect((await call(`/api/sessions/${sessionId}/stream-links/${hostLink.link.id}/link`, undefined, own)).statusCode).toBe(404);
    expect((await call(`/api/sessions/${sessionId}/stream-links/${otherPlayer.link.id}/revoke`, { commandId: randomUUID() }, own)).statusCode).toBe(404);
    expect((await call(`/api/sessions/${sessionId}/stream-links/${made.json().link.id}/revoke`, { commandId: randomUUID() }, own)).statusCode).toBe(200);
  });

  it('keeps stream views and unrelated sessions out', async () => {
    const link = (await create({ subject: 'show' })).json();
    const stage = await insertCredential({ role: 'stage', session_id: sessionId });
    expect((await links(stage)).statusCode).toBe(403);
    expect((await create({ subject: 'show' }, stage)).statusCode).toBe(403);
    expect((await call(`/api/sessions/${sessionId}/stream-links/${link.link.id}/link`, undefined, stage)).statusCode).toBe(403);
    expect((await call(`/api/sessions/${sessionId}/stream-links/${link.link.id}/revoke`, { commandId: randomUUID() }, stage)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/stream-links`, headers: { origin } })).statusCode).toBe(401);
    expect((await call(`/api/sessions/${randomUUID()}/stream-links`)).statusCode).toBe(404);
  });

  it('lets a producer credential make show and host links and checks the producer subject grant', async () => {
    const grant = (await call('/api/producers', { commandId: randomUUID(), label: 'Night crew' })).json().producer;
    const producer = await insertCredential({ role: 'producer', producer_grant_id: grant.id, actor_id: hash(hostToken) });
    const show = await create({ subject: 'show' }, producer);
    expect(show.statusCode, show.body).toBe(200);
    const host = await create({ subject: 'host' }, producer);
    expect(host.statusCode, host.body).toBe(200);
    const personal = await create({ subject: 'producer', producerGrantId: grant.id }, producer);
    expect(personal.statusCode, personal.body).toBe(200);
    expect(personal.json().link).toMatchObject({ subject: 'producer', producerGrantId: grant.id, label: 'Night crew view', canPresent: false });
    expect((await create({ subject: 'producer', producerGrantId: grant.id })).json()).toEqual(personal.json());
    expect((await create({ subject: 'producer', producerGrantId: randomUUID() })).statusCode).toBe(404);
    const audit = (await pool.query("SELECT producer_grant_id FROM audit_events WHERE session_id=$1 AND kind='stream_link.created' ORDER BY sequence", [sessionId])).rows;
    expect(audit.map((r) => r.producer_grant_id)).toEqual([null, grant.id, grant.id, grant.id]);
    await pool.query("UPDATE producer_grants SET owner_id='someone-else' WHERE id=$1", [grant.id]);
    const stranger = await create({ subject: 'producer', producerGrantId: grant.id });
    expect(stranger.statusCode).toBe(404);
  });

  it('caps a default producer link label at 80 characters', async () => {
    const name = 'P'.repeat(80);
    const grant = await call('/api/producers', { commandId: randomUUID(), label: name });
    expect(grant.statusCode, grant.body).toBe(200);
    const made = await create({ subject: 'producer', producerGrantId: grant.json().producer.id });
    expect(made.statusCode, made.body).toBe(200);
    const label = made.json().link.label as string;
    expect(label.length).toBeLessThanOrEqual(80);
    expect(label.startsWith('PPPPPPPP')).toBe(true);
  });

  it('revokes with a stable replay, turns off its credentials, and records an audit event', async () => {
    const link = (await create({ subject: 'show' })).json();
    const credential = await insertCredential({ role: 'stage', session_id: sessionId, stream_link_id: link.link.id, actor_id: `stream:${link.link.id}` });
    const command = { commandId: randomUUID() };
    const url = `/api/sessions/${sessionId}/stream-links/${link.link.id}/revoke`;
    const response = await call(url, command);
    expect(response.statusCode, response.body).toBe(200);
    const summary = response.json();
    expect(summary).toMatchObject({ id: link.link.id, subject: 'show' });
    expect(Date.parse(summary.revokedAt)).not.toBeNaN();
    expect(response.body).not.toContain(link.token);
    expect((await call(url, command)).json()).toEqual(summary);
    expect((await call(url, { commandId: randomUUID() })).json().revokedAt).toBe(summary.revokedAt);
    expect((await call(`/api/sessions/${sessionId}/stream-links/${link.link.id}/link`)).statusCode).toBe(404);
    expect((await call(`/api/sessions/${sessionId}/stream-links/${randomUUID()}/revoke`, { commandId: randomUUID() })).statusCode).toBe(404);
    expect((await pool.query('SELECT revoked_at FROM credentials WHERE token_hash=$1', [hash(credential)])).rows[0].revoked_at).not.toBeNull();
    const audit = (await pool.query("SELECT data FROM audit_events WHERE session_id=$1 AND kind='stream_link.revoked'", [sessionId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].data).toEqual({ linkId: link.link.id, subject: 'show', characterId: null, producerGrantId: null });
    expect((await links()).json().links[0].revokedAt).toBe(summary.revokedAt);
    const again = await create({ subject: 'show' });
    expect(again.json().link.id).not.toBe(link.link.id);
  });
});

suite('stream link access exchange', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let hostToken: string;
  let hostCookie: string;
  let sessionId: string;
  const call = (url: string, payload?: Record<string, unknown>, headers: Record<string, string> = { cookie: `rpg_session=${hostCookie}` }) =>
    app.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, ...headers }, ...(payload === undefined ? {} : { payload }) });
  const cookieOf = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const showLink = async () => (await call(`/api/sessions/${sessionId}/stream-links`, { commandId: randomUUID(), subject: 'show' })).json() as { link: { id: string }; token: string };
  const exchange = (token: string) => call('/api/stream/access', { token }, {});
  const identityFor = (linkId: string) => hash(`rpg-stream-identity-v1:${linkId}`).slice(0, 32);
  const asStream = (identity: string, cookie: string): Record<string, string> => ({ cookie, 'x-rpg-identity': identity });

  beforeEach(async () => {
    hostToken = `stream-access-host-${randomUUID()}`;
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    const signIn = await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } });
    hostCookie = cookieOf(signIn).split('=')[1]!;
    const made = await call('/api/sessions', { commandId: randomUUID() });
    expect(made.statusCode, made.body).toBe(200);
    sessionId = made.json().sessionId;
  });
  afterEach(async () => { await app?.close(); await pool?.end(); });

  it('exchanges a token with no cookie for the same identity every time and keeps earlier credentials valid', async () => {
    const made = await showLink();
    const first = await exchange(made.token);
    expect(first.statusCode, first.body).toBe(200);
    const identity = identityFor(made.link.id);
    expect(first.json()).toMatchObject({ identityId: identity, sessionId, link: { id: made.link.id, subject: 'show', characterId: null, canPresent: true } });
    expect(first.body).not.toContain(made.token);
    const cookie = String(first.headers['set-cookie']);
    expect(cookie).toContain(`rpg_tab_${identity}=`);
    expect(cookie).not.toContain('rpg_session=');
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)![1]);
    expect(maxAge).toBeGreaterThan(12 * 3600 - 60);
    expect(maxAge).toBeLessThanOrEqual(12 * 3600);
    const row = (await pool.query('SELECT actor_id,role,session_id,character_id,stream_link_id,expires_at FROM credentials WHERE token_hash=$1', [hash(cookieOf(first).split('=')[1]!)])).rows[0];
    expect(row).toMatchObject({ actor_id: `stream:${made.link.id}`, role: 'stage', session_id: sessionId, character_id: null, stream_link_id: made.link.id });
    expect(Date.parse(first.json().expiresAt)).toBe(row.expires_at.getTime());
    const second = await exchange(made.token);
    expect(second.statusCode).toBe(200);
    expect(second.json().identityId).toBe(identity);
    expect(cookieOf(second)).not.toBe(cookieOf(first));
    expect((await call(`/api/sessions/${sessionId}?view=stage`, undefined, asStream(identity, cookieOf(first)))).statusCode).toBe(200);
    expect((await call(`/api/sessions/${sessionId}?view=stage`, undefined, asStream(identity, cookieOf(second)))).statusCode).toBe(200);
    expect((await pool.query('SELECT count(*)::int AS n FROM credentials WHERE stream_link_id=$1 AND revoked_at IS NULL', [made.link.id])).rows[0].n).toBe(2);
    expect(JSON.stringify((await pool.query('SELECT data FROM audit_events WHERE session_id=$1', [sessionId])).rows)).not.toContain(made.token);
  });

  it('caps the credential at the link expiry', async () => {
    const made = await showLink();
    await pool.query("UPDATE stream_links SET expires_at=now()+interval '2 hours' WHERE id=$1", [made.link.id]);
    const response = await exchange(made.token);
    expect(response.statusCode, response.body).toBe(200);
    const left = Date.parse(response.json().expiresAt) - Date.now();
    expect(left).toBeGreaterThan(2 * 3600 * 1000 - 60_000);
    expect(left).toBeLessThanOrEqual(2 * 3600 * 1000);
    expect(Number(/Max-Age=(\d+)/.exec(String(response.headers['set-cookie']))![1])).toBeLessThanOrEqual(2 * 3600);
  });

  it('rejects unknown, expired and malformed tokens', async () => {
    const made = await showLink();
    expect((await exchange('not-a-real-token')).statusCode).toBe(401);
    expect((await exchange('not-a-real-token')).json().message).toBe('This stream link has been turned off.');
    expect((await call('/api/stream/access', {}, {})).statusCode).toBe(400);
    expect((await call('/api/stream/access', { token: made.token, extra: 1 }, {})).statusCode).toBe(400);
    await pool.query("UPDATE stream_links SET created_at=now()-interval '100 days',expires_at=now()-interval '1 day' WHERE id=$1", [made.link.id]);
    expect((await exchange(made.token)).statusCode).toBe(401);
  });

  it('lets a stream credential read only the stage view', async () => {
    const made = await showLink();
    const response = await exchange(made.token);
    const headers = asStream(response.json().identityId, cookieOf(response));
    const stage = await call(`/api/sessions/${sessionId}?view=stage`, undefined, headers);
    expect(stage.statusCode, stage.body).toBe(200);
    expect(stage.json().role).toBe('stage');
    expect((await call(`/api/sessions/${sessionId}?view=director`, undefined, headers)).statusCode).toBe(403);
    expect((await call(`/api/sessions/${sessionId}?view=player`, undefined, headers)).statusCode).toBe(403);
    expect((await call(`/api/sessions/${sessionId}/commands`, { commandId: randomUUID(), type: 'set_status', status: 'paused', expectedStateRevision: 0 }, headers)).statusCode).toBe(403);
    expect((await call('/api/library', undefined, headers)).statusCode).toBe(403);
    expect((await call('/api/producers', undefined, headers)).statusCode).toBe(403);
  });

  it('turns access off at once when the link is revoked, including the stream socket', async () => {
    const made = await showLink();
    const response = await exchange(made.token);
    const identity = response.json().identityId as string;
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const socket = io(base, { transports: ['polling'], auth: { sessionId, identityId: identity }, extraHeaders: { cookie: cookieOf(response) }, reconnection: false, timeout: 1500 });
    try {
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
      const disconnected = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The revoked stream socket remained connected.')), 2000);
        socket.once('disconnect', () => { clearTimeout(timer); resolve(); });
      });
      const revoked = await call(`/api/sessions/${sessionId}/stream-links/${made.link.id}/revoke`, { commandId: randomUUID() });
      expect(revoked.statusCode, revoked.body).toBe(200);
      await disconnected;
    } finally { socket.disconnect(); }
    expect((await exchange(made.token)).statusCode).toBe(401);
    expect((await call(`/api/sessions/${sessionId}?view=stage`, undefined, asStream(identity, cookieOf(response)))).statusCode).toBe(401);
  });

  it('turns off a producer personal link when the producer grant is revoked', async () => {
    const grant = (await call('/api/producers', { commandId: randomUUID(), label: 'Late crew' })).json().producer;
    const personal = (await call(`/api/sessions/${sessionId}/stream-links`, { commandId: randomUUID(), subject: 'producer', producerGrantId: grant.id })).json();
    const response = await exchange(personal.token);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().link).toMatchObject({ subject: 'producer', canPresent: false });
    const headers = asStream(response.json().identityId, cookieOf(response));
    expect((await call(`/api/sessions/${sessionId}?view=stage`, undefined, headers)).statusCode).toBe(200);
    const revoked = await call(`/api/producers/${grant.id}/revoke`, { commandId: randomUUID() });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await exchange(personal.token)).statusCode).toBe(401);
    expect((await call(`/api/sessions/${sessionId}?view=stage`, undefined, headers)).statusCode).toBe(401);
  });
});
