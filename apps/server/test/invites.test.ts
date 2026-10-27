import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io } from 'socket.io-client';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

suite('invite list, show again and reissue', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let hostToken: string;
  let hostCookie: string;
  let sessionId: string;
  let seats: Array<{ role: string; characterId: string | null; token: string }>;
  async function call(url: string, payload?: Record<string, unknown>, token = hostCookie) {
    return app.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, cookie: `rpg_session=${token}` }, ...(payload === undefined ? {} : { payload }) });
  }
  const list = async (token = hostCookie) => (await call(`/api/sessions/${sessionId}/invites`, undefined, token)).json().invites as Array<Record<string, any>>;
  const reissue = (inviteId: string, signOutCurrent: boolean, commandId: string = randomUUID(), token = hostCookie) => call(`/api/sessions/${sessionId}/invites/${inviteId}/reissue`, { commandId, signOutCurrent }, token);
  const seatInvite = async (index: number) => (await list()).filter((invite) => invite.role === 'player')[index]!;
  async function redeem(token: string) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token } });
    expect(response.statusCode, response.body).toBe(200);
    return String(response.headers['set-cookie']).split(';')[0]!.split('=')[1]!;
  }
  async function insertCredential(row: { role: string; session_id?: string | null; character_id?: string | null; producer_grant_id?: string | null; actor_id?: string }) {
    const token = `test-${randomUUID()}`;
    await pool.query("INSERT INTO credentials(token_hash,actor_id,role,session_id,character_id,producer_grant_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 hour')",
      [hash(token), row.actor_id ?? randomUUID(), row.role, row.session_id ?? null, row.character_id ?? null, row.producer_grant_id ?? null]);
    return token;
  }

  beforeEach(async () => {
    hostToken = `invite-test-host-${randomUUID()}`;
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    const signIn = await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } });
    hostCookie = String(signIn.headers['set-cookie']).split(';')[0]!.split('=')[1]!;
    const made = await call('/api/sessions', { commandId: randomUUID() });
    expect(made.statusCode, made.body).toBe(200);
    sessionId = made.json().sessionId;
    seats = made.json().invites;
  });
  afterEach(async () => { await app?.close(); await pool?.end(); });

  it('lists waiting, joined and replaced seats without tokens', async () => {
    const before = await list();
    expect(before).toHaveLength(seats.length);
    expect(before.every((invite) => invite.status === 'waiting' && invite.signedIn === false && invite.replacedBy === null)).toBe(true);
    expect(before.filter((invite) => invite.role === 'player').map((invite) => invite.characterId)).toEqual(seats.filter((seat) => seat.role === 'player').map((seat) => seat.characterId));
    expect(before[before.length - 1]).toMatchObject({ role: 'stage', characterId: null });

    await redeem(seats[0]!.token);
    const joinedList = await list();
    expect(joinedList[0]).toMatchObject({ status: 'joined', signedIn: true });
    expect(joinedList[0]!.redeemedAt).not.toBeNull();

    const reissued = await reissue(joinedList[0]!.id, false);
    expect(reissued.statusCode, reissued.body).toBe(200);
    const after = await list();
    expect(after).toHaveLength(seats.length + 1);
    const old = after.find((invite) => invite.id === joinedList[0]!.id)!;
    const fresh = after.find((invite) => invite.id === reissued.json().invite.id)!;
    expect(old).toMatchObject({ status: 'replaced', replacedBy: fresh.id });
    expect(fresh).toMatchObject({ status: 'waiting', characterId: old.characterId, role: 'player', signedIn: false });
    const raw = JSON.stringify(after);
    for (const seat of seats) expect(raw).not.toContain(seat.token);
    expect(raw).not.toContain(reissued.json().token);
    expect(raw).not.toContain('token');
  });

  it('shows the original link only while the invite is waiting', async () => {
    const invite = await seatInvite(0);
    const shown = await call(`/api/sessions/${sessionId}/invites/${invite.id}/link`);
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.json().token).toBe(seats[0]!.token);
    expect(shown.json().invite).toEqual(invite);
    await redeem(seats[0]!.token);
    const used = await call(`/api/sessions/${sessionId}/invites/${invite.id}/link`);
    expect(used.statusCode).toBe(409);
    expect(used.json().message).toBe('This invitation was already used or replaced. Reissue it to get a new link.');
    expect((await call(`/api/sessions/${sessionId}/invites/${randomUUID()}/link`)).statusCode).toBe(404);
  });

  it('makes the old token useless and the new token work after a reissue', async () => {
    const invite = await seatInvite(1);
    const response = await reissue(invite.id, false);
    expect(response.statusCode, response.body).toBe(200);
    const link = response.json();
    expect(link.invite).toMatchObject({ status: 'waiting', role: 'player', characterId: invite.characterId });
    expect(Date.parse(link.invite.expiresAt) - Date.parse(link.invite.createdAt)).toBeGreaterThan(6.9 * 86400 * 1000);
    const row = (await pool.query('SELECT * FROM invites WHERE id=$1', [link.invite.id])).rows[0];
    expect(row.replaces_invite_id).toBe(invite.id);
    expect(row.token_hash).toBe(hash(link.token));
    expect(link.token).toBe(createHmac('sha256', hostToken).update(JSON.stringify(['rpg-invite-v1', row.id, sessionId, 'player', invite.characterId])).digest('base64url'));
    const oldTry = await app.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token: seats[1]!.token } });
    expect(oldTry.statusCode).toBe(401);
    const cookie = await redeem(link.token);
    const me = await app.inject({ url: `/api/sessions/${sessionId}`, headers: { cookie: `rpg_session=${cookie}` } });
    expect(me.statusCode, me.body).toBe(200);
    expect((await call(`/api/sessions/${sessionId}/invites/${invite.id}/link`)).statusCode).toBe(409);
    const again = await reissue(invite.id, false);
    expect(again.statusCode).toBe(409);
    const audit = (await pool.query("SELECT data FROM audit_events WHERE session_id=$1 AND kind='invite.reissued'", [sessionId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].data).toMatchObject({ inviteId: invite.id, replacementId: link.invite.id });
    expect(JSON.stringify(audit)).not.toContain(link.token);
  });

  it('reissues a stage seat as a stage seat', async () => {
    const stage = (await list()).find((invite) => invite.role === 'stage')!;
    const response = await reissue(stage.id, false);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().invite).toMatchObject({ role: 'stage', characterId: null, status: 'waiting' });
  });

  it('drops the earlier holder when signOutCurrent is true and keeps them when false', async () => {
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const keepInvite = await seatInvite(0);
    const dropInvite = await seatInvite(1);
    const keepCookie = await redeem(seats[0]!.token);
    const dropCookie = await redeem(seats[1]!.token);
    const connect = (cookie: string) => io(base, { transports: ['polling'], auth: { sessionId }, extraHeaders: { cookie: `rpg_session=${cookie}` }, reconnection: false, timeout: 1500 });
    const keepSocket = connect(keepCookie);
    const dropSocket = connect(dropCookie);
    try {
      await Promise.all([keepSocket, dropSocket].map((socket) => new Promise<void>((resolve, reject) => {
        if (socket.connected) return resolve();
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      })));
      const gone = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The socket stayed connected.')), 2000);
        dropSocket.once('disconnect', () => { clearTimeout(timer); resolve(); });
      });
      expect((await reissue(keepInvite.id, false)).statusCode).toBe(200);
      expect((await reissue(dropInvite.id, true)).statusCode).toBe(200);
      await gone;
      expect((await app.inject({ url: `/api/sessions/${sessionId}`, headers: { cookie: `rpg_session=${dropCookie}` } })).statusCode).toBe(401);
      expect((await app.inject({ url: `/api/sessions/${sessionId}`, headers: { cookie: `rpg_session=${keepCookie}` } })).statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(keepSocket.connected).toBe(true);
    } finally {
      keepSocket.disconnect();
      dropSocket.disconnect();
      app.server.closeAllConnections();
    }
  });

  it('leaves test seats alone when signing a holder out', async () => {
    const invite = await seatInvite(0);
    const testSeat = await insertCredential({ role: 'player', session_id: sessionId, character_id: invite.characterId, actor_id: randomUUID() });
    expect((await reissue(invite.id, true)).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/sessions/${sessionId}`, headers: { cookie: `rpg_session=${testSeat}` } })).statusCode).toBe(200);
  });

  it('lets a producer manage invitations and keeps players and stage out', async () => {
    const grantId = randomUUID();
    const ownerId = (await pool.query('SELECT owner_id FROM sessions WHERE id=$1', [sessionId])).rows[0].owner_id;
    await pool.query("INSERT INTO producer_grants(id,owner_id,label,token_hash,expires_at) VALUES($1,$2,'Test producer',$3,now()+interval '1 day')", [grantId, ownerId, hash(`grant-${grantId}`)]);
    const producer = await insertCredential({ role: 'producer', actor_id: ownerId, producer_grant_id: grantId });
    expect(await list(producer)).toHaveLength(seats.length);
    const invite = await seatInvite(0);
    const response = await reissue(invite.id, false, randomUUID(), producer);
    expect(response.statusCode, response.body).toBe(200);
    const audit = (await pool.query("SELECT producer_grant_id FROM audit_events WHERE session_id=$1 AND kind='invite.reissued'", [sessionId])).rows;
    expect(audit).toEqual([{ producer_grant_id: grantId }]);

    const player = await redeem(seats[1]!.token);
    const stage = await redeem(seats[seats.length - 1]!.token);
    for (const token of [player, stage]) {
      expect((await call(`/api/sessions/${sessionId}/invites`, undefined, token)).statusCode).toBe(403);
      expect((await call(`/api/sessions/${sessionId}/invites/${invite.id}/link`, undefined, token)).statusCode).toBe(403);
      expect((await reissue(invite.id, true, randomUUID(), token)).statusCode).toBe(403);
    }
    expect((await app.inject({ url: `/api/sessions/${sessionId}/invites` })).statusCode).toBe(401);
  });

  it('replays the same command with the same invite and token', async () => {
    const invite = await seatInvite(0);
    const commandId = randomUUID();
    const first = await reissue(invite.id, false, commandId);
    const second = await reissue(invite.id, false, commandId);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect((await reissue(invite.id, true, commandId)).statusCode).toBe(409);
    expect((await pool.query('SELECT 1 FROM invites WHERE replaces_invite_id=$1', [invite.id])).rowCount).toBe(1);
  });

  it('no longer returns revoked invites when the create-session command is replayed', async () => {
    const commandId = randomUUID();
    const created = await call('/api/sessions', { commandId });
    const original = created.json();
    const players = original.invites.filter((seat: any) => seat.role === 'player');
    const target = (await pool.query("SELECT id FROM invites WHERE session_id=$1 AND character_id=$2", [original.sessionId, players[0].characterId])).rows[0].id;
    const reissued = await call(`/api/sessions/${original.sessionId}/invites/${target}/reissue`, { commandId: randomUUID(), signOutCurrent: false });
    expect(reissued.statusCode, reissued.body).toBe(200);
    const replay = (await call('/api/sessions', { commandId })).json();
    expect(replay.sessionId).toBe(original.sessionId);
    expect(replay.invites).toHaveLength(original.invites.length);
    expect(replay.invites.find((seat: any) => seat.characterId === players[0].characterId).token).toBe(reissued.json().token);
    expect(replay.invites.map((seat: any) => seat.token)).not.toContain(players[0].token);
  });
  describe('invitation preview', () => {
    const preview = (token: string, headers: Record<string, string> = { origin }) => app.inject({ method: 'POST', url: '/api/auth/invite-preview', headers, payload: { token } });
    const stageToken = () => seats.find((seat) => seat.role === 'stage')!.token;
    const makeCard = (characterId: string, patch: Record<string, unknown>) =>
      pool.query("UPDATE characters SET data=data || $2::jsonb WHERE id=$1", [characterId, JSON.stringify(patch)]);

    it('previews a waiting player invite and a stage invite without signing in', async () => {
      const title = (await pool.query('SELECT title FROM sessions WHERE id=$1', [sessionId])).rows[0].title;
      const player = await preview(seats[0]!.token);
      expect(player.statusCode, player.body).toBe(200);
      expect(player.json()).toMatchObject({ title, role: 'player' });
      const stage = await preview(stageToken());
      expect(stage.statusCode, stage.body).toBe(200);
      expect(stage.json()).toEqual({ title, role: 'stage' });
    });

    it('sends the character name only for a seat with a card', async () => {
      const [first, second] = seats.filter((seat) => seat.role === 'player');
      const name = (await pool.query('SELECT data->>\'displayName\' AS name FROM characters WHERE id=$1', [first!.characterId])).rows[0].name;
      await makeCard(first!.characterId!, { approved: true, draft: null });
      expect((await preview(first!.token)).json()).toMatchObject({ role: 'player', characterName: name });
      await makeCard(second!.characterId!, { approved: false, draft: null });
      expect((await preview(second!.token)).json()).not.toHaveProperty('characterName');
      await makeCard(first!.characterId!, { approved: true, draft: { name: 'Pending' } });
      expect((await preview(first!.token)).json()).not.toHaveProperty('characterName');
      await makeCard(first!.characterId!, { approved: false, draft: null });
      expect((await preview(first!.token)).json()).not.toHaveProperty('characterName');
      expect((await preview(stageToken())).json()).not.toHaveProperty('characterName');
    });

    it('refuses invalid, redeemed, revoked, expired and replaced tokens with the redeem message', async () => {
      const message = 'This invitation is expired, already redeemed, or invalid.';
      const expectRefused = async (token: string) => {
        const response = await preview(token);
        expect(response.statusCode, response.body).toBe(401);
        expect(response.json()).toMatchObject({ code: 'unauthorized', message });
        expect(response.headers['set-cookie']).toBeUndefined();
      };
      await expectRefused('not-a-real-token');
      await redeem(seats[0]!.token);
      await expectRefused(seats[0]!.token);
      await pool.query('UPDATE invites SET revoked_at=now() WHERE token_hash=$1', [hash(seats[1]!.token)]);
      await expectRefused(seats[1]!.token);
      await pool.query("UPDATE invites SET expires_at=now()-interval '1 minute' WHERE token_hash=$1", [hash(stageToken())]);
      await expectRefused(stageToken());
      const third = (await list()).filter((invite) => invite.role === 'player')[2];
      expect(third).toBeDefined();
      expect((await reissue(third!.id, false)).statusCode).toBe(200);
      await expectRefused(seats[2]!.token);
    });

    it('does not redeem, set a cookie or need a sign-in', async () => {
      const before = await preview(seats[0]!.token, { origin });
      expect(before.statusCode, before.body).toBe(200);
      expect(before.headers['set-cookie']).toBeUndefined();
      expect((await preview(seats[0]!.token)).statusCode).toBe(200);
      expect((await pool.query('SELECT redeemed_at FROM invites WHERE token_hash=$1', [hash(seats[0]!.token)])).rows[0].redeemed_at).toBeNull();
      expect((await list())[0]).toMatchObject({ status: 'waiting', signedIn: false });
      await redeem(seats[0]!.token);
    });

    it('keeps the Origin check and rejects a malformed body', async () => {
      expect((await preview(seats[0]!.token, {})).statusCode).toBe(403);
      const bad = await app.inject({ method: 'POST', url: '/api/auth/invite-preview', headers: { origin }, payload: { token: '' } });
      expect(bad.statusCode).toBeGreaterThanOrEqual(400);
      expect(bad.statusCode).toBeLessThan(500);
    });
  });
});
