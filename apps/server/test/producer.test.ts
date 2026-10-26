import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const MESSAGE = 'Only the host can manage producer access.';

suite('producer management routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let hostToken: string;
  async function call(url: string, payload?: Record<string, unknown>, token = hostToken) {
    return app.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, cookie: `rpg_session=${token}` }, ...(payload === undefined ? {} : { payload }) });
  }
  async function signIn() {
    const response = await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } });
    expect(response.statusCode, response.body).toBe(200);
    return String(response.headers['set-cookie']).split(';')[0]!.split('=')[1]!;
  }
  let hostCookie: string;
  const host = (url: string, payload?: Record<string, unknown>) => call(url, payload, hostCookie);
  async function create(label = 'Night producer') {
    const response = await host('/api/producers', { commandId: randomUUID(), label });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function insertCredential(row: { role: string; session_id?: string | null; character_id?: string | null; producer_grant_id?: string | null; stream_link_id?: string | null; actor_id?: string }) {
    const token = `test-${randomUUID()}`;
    await pool.query("INSERT INTO credentials(token_hash,actor_id,role,session_id,character_id,producer_grant_id,stream_link_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '1 hour')",
      [hash(token), row.actor_id ?? randomUUID(), row.role, row.session_id ?? null, row.character_id ?? null, row.producer_grant_id ?? null, row.stream_link_id ?? null]);
    return token;
  }
  async function newSession() {
    const response = await host('/api/sessions', { commandId: randomUUID() });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().sessionId as string;
  }

  beforeEach(async () => {
    hostToken = `producer-test-host-${randomUUID()}`;
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    hostCookie = await signIn();
  });
  afterEach(async () => { await app?.close(); await pool?.end(); });

  it('creates and shows the same re-derived token, stores only the hash, and lists no secrets', async () => {
    const command = { commandId: randomUUID(), label: '  Night producer  ' };
    const response = await host('/api/producers', command);
    expect(response.statusCode, response.body).toBe(200);
    const link = response.json();
    expect(link.producer).toMatchObject({ label: 'Night producer', revokedAt: null, lastSignedInAt: null, activeSignIns: 0 });
    expect(Date.parse(link.producer.expiresAt) - Date.parse(link.producer.createdAt)).toBe(30 * 86400 * 1000);
    expect(link.token).toBe(createHmac('sha256', hostToken).update(JSON.stringify(['rpg-producer-v1', link.producer.id])).digest('base64url'));
    expect((await host('/api/producers', command)).json()).toEqual(link);
    expect((await host('/api/producers', { ...command, label: 'Changed' })).statusCode).toBe(409);
    expect((await host(`/api/producers/${link.producer.id}/link`)).json()).toEqual(link);
    const listed = await host('/api/producers');
    expect(listed.json()).toEqual({ producers: [link.producer] });
    expect(listed.body).not.toContain(link.token);
    expect(listed.body).not.toMatch(/hash/i);
    const row = (await pool.query('SELECT * FROM producer_grants WHERE id=$1', [link.producer.id])).rows[0];
    expect(row.token_hash).toBe(hash(link.token));
    expect(row.owner_id).toBe(hash(hostToken));
    expect(JSON.stringify(row)).not.toContain(link.token);
    const receipt = (await pool.query('SELECT response FROM command_receipts WHERE actor_id=$1 AND command_id=$2', [hash(hostToken), command.commandId])).rows[0];
    expect(JSON.stringify(receipt)).not.toContain(link.token);
  });

  it('lists newest first and counts active producer sign-ins', async () => {
    const first = await create('First');
    const second = await create('Second');
    await insertCredential({ role: 'producer', producer_grant_id: first.producer.id });
    await insertCredential({ role: 'producer', producer_grant_id: first.producer.id });
    const list = (await host('/api/producers')).json().producers;
    expect(list.map((p: { id: string }) => p.id)).toEqual([second.producer.id, first.producer.id]);
    expect(list[1].activeSignIns).toBe(2);
    expect(list[0].activeSignIns).toBe(0);
  });

  it('refuses players, stage seats, and producers on all four routes', async () => {
    const link = await create();
    const sessionId = await newSession();
    const character = (await pool.query('SELECT id FROM characters WHERE session_id=$1 LIMIT 1', [sessionId])).rows[0].id as string;
    const player = await insertCredential({ role: 'player', session_id: sessionId, character_id: character });
    const stage = await insertCredential({ role: 'stage', session_id: sessionId });
    const producer = await insertCredential({ role: 'producer', producer_grant_id: link.producer.id, actor_id: hash(hostToken) });
    for (const token of [player, stage, producer]) {
      const attempts = [
        await call('/api/producers', undefined, token),
        await call('/api/producers', { commandId: randomUUID(), label: 'Sneaky' }, token),
        await call(`/api/producers/${link.producer.id}/link`, undefined, token),
        await call(`/api/producers/${link.producer.id}/revoke`, { commandId: randomUUID() }, token),
      ];
      for (const response of attempts) {
        expect(response.statusCode, response.body).toBe(403);
        expect(response.json().message).toBe(MESSAGE);
      }
    }
    expect((await host('/api/producers')).json().producers[0].revokedAt).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/producers', headers: { origin } })).statusCode).toBe(401);
  });

  it('revokes with a stable replay, hides the revoked link, and cascades to credentials and stream links', async () => {
    const link = await create();
    const other = await create('Other');
    const sessionId = await newSession();
    const grantId = link.producer.id as string;
    const signIn = await insertCredential({ role: 'producer', producer_grant_id: grantId, actor_id: hash(hostToken) });
    const otherSignIn = await insertCredential({ role: 'producer', producer_grant_id: other.producer.id, actor_id: hash(hostToken) });
    const streamId = randomUUID();
    await pool.query("INSERT INTO stream_links(id,session_id,subject,producer_grant_id,label,token_hash,expires_at) VALUES($1,$2,'producer',$3,'Producer view',$4,now()+interval '1 day')", [streamId, sessionId, grantId, hash(`stream-${streamId}`)]);
    const streamCredential = await insertCredential({ role: 'stage', session_id: sessionId, stream_link_id: streamId, actor_id: `stream:${streamId}` });
    const testSeat = await host(`/api/sessions/${sessionId}/test-seat`, { characterId: (await pool.query('SELECT id FROM characters WHERE session_id=$1 LIMIT 1', [sessionId])).rows[0].id });
    expect(testSeat.statusCode, testSeat.body).toBe(200);

    const command = { commandId: randomUUID() };
    const response = await host(`/api/producers/${grantId}/revoke`, command);
    expect(response.statusCode, response.body).toBe(200);
    const summary = response.json();
    expect(summary.id).toBe(grantId);
    expect(Date.parse(summary.revokedAt)).not.toBeNaN();
    expect(summary.activeSignIns).toBe(0);
    expect((await host(`/api/producers/${grantId}/revoke`, command)).json()).toEqual(summary);
    expect((await host(`/api/producers/${grantId}/revoke`, { commandId: randomUUID() })).json().revokedAt).toBe(summary.revokedAt);
    expect((await host(`/api/producers/${grantId}/link`)).statusCode).toBe(404);
    expect((await host(`/api/producers/${randomUUID()}/revoke`, { commandId: randomUUID() })).statusCode).toBe(404);

    const revoked = (table: string, column: string, value: string) => pool.query(`SELECT revoked_at FROM ${table} WHERE ${column}=$1`, [value]);
    expect((await revoked('credentials', 'token_hash', hash(signIn))).rows[0].revoked_at).not.toBeNull();
    expect((await revoked('credentials', 'token_hash', hash(streamCredential))).rows[0].revoked_at).not.toBeNull();
    expect((await revoked('stream_links', 'id', streamId)).rows[0].revoked_at).not.toBeNull();
    expect((await revoked('credentials', 'token_hash', hash(otherSignIn))).rows[0].revoked_at).toBeNull();
    const seats = await pool.query('SELECT revoked_at FROM credentials WHERE producer_grant_id=$1', [grantId]);
    expect(seats.rows.every((row) => row.revoked_at !== null)).toBe(true);
    expect((await host(`/api/producers/${other.producer.id}/link`)).statusCode).toBe(200);
    expect((await host('/api/producers')).json().producers.find((p: { id: string }) => p.id === grantId).revokedAt).toBe(summary.revokedAt);
  });

  it('keeps one host from reading or revoking another host\'s producers', async () => {
    const link = await create();
    await pool.query("UPDATE producer_grants SET owner_id='someone-else' WHERE id=$1", [link.producer.id]);
    expect((await host('/api/producers')).json()).toEqual({ producers: [] });
    expect((await host(`/api/producers/${link.producer.id}/link`)).statusCode).toBe(404);
    expect((await host(`/api/producers/${link.producer.id}/revoke`, { commandId: randomUUID() })).statusCode).toBe(404);
  });

  async function producerSignIn(token: string, tab?: true) {
    return app.inject({ method: 'POST', url: '/api/auth/producer', headers: { origin }, payload: { token, ...(tab ? { tab } : {}) } });
  }
  const cookiePair = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const cookieValue = (response: { headers: Record<string, unknown> }) => cookiePair(response).split('=')[1]!;
  async function signedInProducer(label = 'Night producer') {
    const link = await create(label);
    const response = await producerSignIn(link.token);
    expect(response.statusCode, response.body).toBe(200);
    return { link, session: cookieValue(response), response };
  }

  describe('producer sign-in', () => {
    it('signs in on a tab with an HttpOnly tab cookie, a 32-hex identity, and the pinned response', async () => {
      const link = await create('Tab producer');
      const response = await producerSignIn(link.token, true);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ role: 'producer', label: 'Tab producer' });
      expect(body.identityId).toMatch(/^[a-f0-9]{32}$/);
      const header = String(response.headers['set-cookie']);
      expect(header).toContain(`rpg_tab_${body.identityId}=`);
      expect(header).toMatch(/HttpOnly/i);
      expect(header).not.toContain('rpg_session=');
      expect(Date.parse(body.expiresAt)).toBeLessThanOrEqual(Date.now() + 12 * 3600 * 1000 + 5000);
      expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now() + 11 * 3600 * 1000);
      const maxAge = Number(/Max-Age=(\d+)/i.exec(header)![1]);
      expect(maxAge).toBeGreaterThan(11 * 3600);
      expect(maxAge).toBeLessThanOrEqual(12 * 3600);
      const grant = (await pool.query('SELECT last_signed_in_at FROM producer_grants WHERE id=$1', [link.producer.id])).rows[0];
      expect(grant.last_signed_in_at).not.toBeNull();
      const row = (await pool.query('SELECT role,actor_id,session_id,character_id,producer_grant_id FROM credentials WHERE token_hash=$1', [hash(cookieValue(response))])).rows[0];
      expect(row).toEqual({ role: 'producer', actor_id: hash(hostToken), session_id: null, character_id: null, producer_grant_id: link.producer.id });
      const withoutTab = await producerSignIn(link.token);
      expect(withoutTab.json().identityId).toBeUndefined();
      expect(String(withoutTab.headers['set-cookie'])).toContain('rpg_session=');
      expect((await producerSignIn(link.token, true)).json().identityId).not.toBe(body.identityId);
    });

    it('caps the credential and cookie at the grant expiry', async () => {
      const link = await create('Short grant');
      await pool.query("UPDATE producer_grants SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [link.producer.id]);
      const response = await producerSignIn(link.token);
      expect(response.statusCode, response.body).toBe(200);
      const grantExpiry = (await pool.query('SELECT expires_at FROM producer_grants WHERE id=$1', [link.producer.id])).rows[0].expires_at as Date;
      expect(response.json().expiresAt).toBe(grantExpiry.toISOString());
      const maxAge = Number(/Max-Age=(\d+)/i.exec(String(response.headers['set-cookie']))![1]);
      expect(maxAge).toBeGreaterThan(3500);
      expect(maxAge).toBeLessThanOrEqual(3600);
    });

    it('rejects unknown, malformed, revoked and expired links with the pinned message', async () => {
      const message = 'This producer link is expired, revoked, or invalid. Ask the host for a new link.';
      const link = await create('Soon gone');
      for (const token of ['nonsense', link.token + 'x']) {
        const response = await producerSignIn(token);
        expect(response.statusCode).toBe(401);
        expect(response.json().message).toBe(message);
      }
      expect((await app.inject({ method: 'POST', url: '/api/auth/producer', headers: { origin }, payload: { token: link.token, extra: 1 } })).statusCode).toBe(400);
      await pool.query("UPDATE producer_grants SET created_at=created_at-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [link.producer.id]);
      expect((await producerSignIn(link.token)).statusCode).toBe(401);
      const again = await create('Revoked');
      expect((await host(`/api/producers/${again.producer.id}/revoke`, { commandId: randomUUID() })).statusCode).toBe(200);
      const revoked = await producerSignIn(again.token);
      expect(revoked.statusCode).toBe(401);
      expect(revoked.json().message).toBe(message);
      expect(revoked.headers['set-cookie']).toBeUndefined();
    });

    it('rejects a link made under a different host token on the same database', async () => {
      const link = await create('Other host');
      const other = await buildApp({ databaseUrl: databaseUrl!, hostToken: `other-host-token-${randomUUID()}`, origin, serveStatic: false });
      try {
        const response = await other.inject({ method: 'POST', url: '/api/auth/producer', headers: { origin }, payload: { token: link.token } });
        expect(response.statusCode, response.body).toBe(401);
      } finally { await other.close(); }
      expect((await producerSignIn(link.token)).statusCode).toBe(200);
    });
  });

  describe('GET /api/auth/me', () => {
    it('describes host, producer, player and stage viewers', async () => {
      const created = (await host('/api/sessions', { commandId: randomUUID() })).json();
      const sessionId = created.sessionId as string;
      const redeem = async (role: string) => {
        const invite = created.invites.find((item: { role: string }) => item.role === role);
        const response = await app.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token: invite.token } });
        expect(response.statusCode, response.body).toBe(200);
        return { token: cookieValue(response), invite };
      };
      const hostMe = await host('/api/auth/me');
      expect(hostMe.statusCode, hostMe.body).toBe(200);
      expect(hostMe.json()).toMatchObject({ role: 'host', sessionId: null, characterId: null, producer: null, streamLinkId: null });
      expect(Date.parse(hostMe.json().expiresAt)).toBeGreaterThan(Date.now());

      const player = await redeem('player');
      const playerMe = await call('/api/auth/me', undefined, player.token);
      expect(playerMe.json()).toMatchObject({ role: 'player', sessionId, characterId: player.invite.characterId, producer: null, streamLinkId: null });
      const stage = await redeem('stage');
      expect((await call('/api/auth/me', undefined, stage.token)).json()).toMatchObject({ role: 'stage', sessionId, characterId: null, producer: null });

      const { link, session } = await signedInProducer('Mia');
      const producerMe = await call('/api/auth/me', undefined, session);
      expect(producerMe.statusCode, producerMe.body).toBe(200);
      const body = producerMe.json();
      expect(body).toMatchObject({ role: 'producer', sessionId: null, characterId: null, streamLinkId: null, producer: { grantId: link.producer.id, label: 'Mia' } });
      expect(body.producer.expiresAt).toBe(link.producer.expiresAt);
      const credential = (await pool.query('SELECT expires_at FROM credentials WHERE token_hash=$1', [hash(session)])).rows[0];
      expect(body.expiresAt).toBe((credential.expires_at as Date).toISOString());

      expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { origin } })).statusCode).toBe(401);
      expect((await call('/api/auth/me', undefined, 'not-a-credential')).statusCode).toBe(401);
    });
  });

  describe('producer access', () => {
    it('is refused on all four management routes, including its own grant', async () => {
      const { link, session } = await signedInProducer();
      const attempts = [
        await call('/api/producers', undefined, session),
        await call('/api/producers', { commandId: randomUUID(), label: 'Sneaky' }, session),
        await call(`/api/producers/${link.producer.id}/link`, undefined, session),
        await call(`/api/producers/${link.producer.id}/revoke`, { commandId: randomUUID() }, session),
      ];
      for (const response of attempts) {
        expect(response.statusCode, response.body).toBe(403);
        expect(response.json().message).toBe(MESSAGE);
      }
      expect((await host('/api/producers')).json().producers).toHaveLength(1);
      expect((await host('/api/producers')).json().producers[0].revokedAt).toBeNull();
    });

    it('has full host access to sessions, live controls, the library and test seats', async () => {
      const { session } = await signedInProducer();
      const sessionId = await newSession();
      await pool.query("UPDATE sessions SET status='live' WHERE id=$1", [sessionId]);
      const listed = await call('/api/sessions', undefined, session);
      expect(listed.statusCode, listed.body).toBe(200);
      expect(listed.json().map((row: { id: string }) => row.id)).toContain(sessionId);
      const snapshot = await call(`/api/sessions/${sessionId}?view=director`, undefined, session);
      expect(snapshot.statusCode, snapshot.body).toBe(200);
      expect(snapshot.json().role).toBe('director');
      const opened = await call(`/api/sessions/${sessionId}/commands`, { commandId: randomUUID(), type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.json().session.inputEpoch }, session);
      expect(opened.statusCode, opened.body).toBe(200);
      const starter = (await call('/api/library/starter', undefined, session)).json();
      const saved = await call('/api/library/scenarios', { commandId: randomUUID(), expectedVersion: 0, definition: starter.scenario }, session);
      expect(saved.statusCode, saved.body).toBe(200);
      expect((await call('/api/library', undefined, session)).json().scenarios.map((item: { id: string }) => item.id)).toContain(saved.json().id);
      const characterId = (await pool.query('SELECT id FROM characters WHERE session_id=$1 LIMIT 1', [sessionId])).rows[0].id as string;
      const seat = await call(`/api/sessions/${sessionId}/test-seat`, { characterId }, session);
      expect(seat.statusCode, seat.body).toBe(200);
      expect(seat.json()).toMatchObject({ sessionId, role: 'player', characterId });
    });

    it('stops at once for HTTP calls, test seats, sockets and new sign-ins after the host revokes it', async () => {
      const { link, session } = await signedInProducer();
      const sessionId = await newSession();
      const characterId = (await pool.query('SELECT id FROM characters WHERE session_id=$1 LIMIT 1', [sessionId])).rows[0].id as string;
      const seat = await call(`/api/sessions/${sessionId}/test-seat`, { characterId }, session);
      expect(seat.statusCode, seat.body).toBe(200);
      const seatHeaders = { origin, cookie: `rpg_tab_${seat.json().identityId}=${cookieValue(seat)}`, 'x-rpg-identity': seat.json().identityId as string };
      expect((await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}`, headers: seatHeaders })).statusCode).toBe(200);

      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const socket = io(base, { transports: ['polling'], auth: { sessionId }, extraHeaders: { cookie: `rpg_session=${session}` }, reconnection: false, timeout: 1500 });
      try {
        await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
        const disconnected = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('The revoked producer socket remained connected.')), 2000);
          socket.once('disconnect', () => { clearTimeout(timer); resolve(); });
        });
        expect((await host(`/api/producers/${link.producer.id}/revoke`, { commandId: randomUUID() })).statusCode).toBe(200);
        await disconnected;
      } finally { socket.disconnect(); }

      expect((await call('/api/sessions', undefined, session)).statusCode).toBe(401);
      expect((await call('/api/auth/me', undefined, session)).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}`, headers: seatHeaders })).statusCode).toBe(401);
      expect((await producerSignIn(link.token)).statusCode).toBe(401);
      expect((await host('/api/sessions')).statusCode).toBe(200);
    });
  });
});
