import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';

suite('removing a seat before the show starts', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let hostToken: string;
  let hostCookie: string;
  let sessionId: string;
  let seats: Array<{ role: string; characterId: string | null; token: string }>;
  let players: Array<{ role: string; characterId: string | null; token: string }>;
  const call = (url: string, payload?: Record<string, unknown>, cookie = hostCookie) =>
    app.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, cookie: `rpg_session=${cookie}` }, ...(payload === undefined ? {} : { payload }) });
  const snapshot = async (cookie = hostCookie) => {
    const response = await call(`/api/sessions/${sessionId}`, undefined, cookie);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as any;
  };
  const revision = async () => (await snapshot()).session.stateRevision as number;
  const send = (command: Record<string, unknown>, cookie = hostCookie) => call(`/api/sessions/${sessionId}/commands`, { commandId: randomUUID(), ...command }, cookie);
  const remove = async (characterId: string, overrides: Record<string, unknown> = {}, cookie = hostCookie) =>
    send({ type: 'remove_seat', expectedStateRevision: await revision(), characterId, ...overrides }, cookie);
  async function redeem(token: string) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token } });
    return { status: response.statusCode, cookie: response.statusCode === 200 ? String(response.headers['set-cookie']).split(';')[0]!.split('=')[1]! : '' };
  }
  const count = async (sql: string, args: unknown[]) => Number((await pool.query(sql, args)).rows[0].count);

  beforeEach(async () => {
    hostToken = `remove-seat-host-${randomUUID()}`;
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    const signIn = await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } });
    hostCookie = String(signIn.headers['set-cookie']).split(';')[0]!.split('=')[1]!;
    const starter = (await call('/api/library/starter')).json() as { scenario: Record<string, any>; characters: Array<Record<string, any>> };
    const savedScenario = (await call('/api/library/scenarios', { commandId: randomUUID(), expectedVersion: 0, definition: starter.scenario })).json();
    const refs = [];
    for (const definition of starter.characters.slice(0, 3)) {
      const saved = (await call('/api/library/characters', { commandId: randomUUID(), expectedVersion: 0, definition })).json();
      refs.push({ templateId: saved.id, version: saved.version });
    }
    const made = await call('/api/sessions', { commandId: randomUUID(), scenario: { templateId: savedScenario.id, version: savedScenario.version }, characters: refs });
    expect(made.statusCode, made.body).toBe(200);
    sessionId = made.json().sessionId;
    seats = made.json().invites;
    players = seats.filter((seat) => seat.role === 'player');
    expect(players).toHaveLength(3);
  });
  afterEach(async () => { await app?.close(); await pool?.end(); });

  it('lets only a director remove a seat', async () => {
    const player = await redeem(players[0]!.token);
    expect(player.status).toBe(200);
    const denied = await remove(players[1]!.characterId!, {}, player.cookie);
    expect(denied.statusCode, denied.body).toBe(403);
    expect((await snapshot()).characterDetails).toHaveLength(players.length);
    const allowed = await remove(players[1]!.characterId!);
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json().snapshot.characterDetails).toHaveLength(players.length - 1);
  });

  it('refuses a stale revision, an unknown seat and the last seat', async () => {
    const stale = await remove(players[0]!.characterId!, { expectedStateRevision: (await revision()) + 5 });
    expect(stale.statusCode, stale.body).toBe(409);
    const unknown = await remove(randomUUID());
    expect(unknown.statusCode, unknown.body).toBe(404);
    for (const seat of players.slice(1)) expect((await remove(seat.characterId!)).statusCode).toBe(200);
    const last = await remove(players[0]!.characterId!);
    expect(last.statusCode, last.body).toBe(409);
    expect(last.json().message).toBe('At least one seat must remain.');
    expect((await snapshot()).characterDetails).toHaveLength(1);
  });

  it('works only in the lobby', async () => {
    const started = await send({ type: 'start_session', expectedStateRevision: await revision() });
    expect(started.statusCode, started.body).toBe(200);
    const late = await remove(players[0]!.characterId!);
    expect(late.statusCode, late.body).toBe(409);
    expect((await snapshot()).characterDetails).toHaveLength(players.length);
  });

  it('removes the seat, its invitation, sign-ins, stream links and submissions, and leaves the rest alone', async () => {
    const [gone, kept] = [players[0]!, players[1]!];
    const goneId = gone.characterId!;
    const player = await redeem(gone.token);
    expect(player.status).toBe(200);
    expect((await call(`/api/sessions/${sessionId}`, undefined, player.cookie)).statusCode).toBe(200);
    const keptPlayer = await redeem(kept.token);
    expect(keptPlayer.status).toBe(200);
    const testSeat = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/test-seat`, headers: { origin, cookie: `rpg_session=${hostCookie}` }, payload: { characterId: goneId } });
    expect(testSeat.statusCode, testSeat.body).toBe(200);
    const link = await call(`/api/sessions/${sessionId}/stream-links`, { commandId: randomUUID(), subject: 'player', characterId: goneId }, hostCookie);
    expect(link.statusCode, link.body).toBe(200);
    const keptLink = await call(`/api/sessions/${sessionId}/stream-links`, { commandId: randomUUID(), subject: 'player', characterId: kept.characterId }, hostCookie);
    expect(keptLink.statusCode, keptLink.body).toBe(200);
    const linkId = link.json().link.id as string;
    await pool.query("INSERT INTO credentials(token_hash,actor_id,role,session_id,stream_link_id,expires_at) VALUES($1,$2,'stage',$3,$4,now()+interval '1 hour')", [randomUUID(), randomUUID(), sessionId, linkId]);
    const note = await send({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: (await snapshot()).session.inputEpoch, contextBeatId: null, kind: 'ooc', text: 'Pause requested.' }, player.cookie);
    expect(note.statusCode, note.body).toBe(200);
    expect(await count('SELECT count(*) FROM submissions WHERE character_id=$1', [goneId])).toBe(1);

    const removed = await remove(goneId);
    expect(removed.statusCode, removed.body).toBe(200);

    const director = await snapshot();
    expect(director.characterDetails.map((item: { id: string }) => item.id)).not.toContain(goneId);
    expect(director.characterDetails).toHaveLength(players.length - 1);
    expect(director.setup.boundaries).toBeDefined();
    expect((await call(`/api/sessions/${sessionId}`, undefined, player.cookie)).statusCode).toBe(401);
    expect((await call(`/api/sessions/${sessionId}`, undefined, testSeat.headers['set-cookie'] ? String(testSeat.headers['set-cookie']).split(';')[0]!.split('=')[1]! : '')).statusCode).toBe(401);
    expect((await redeem(gone.token)).status).toBe(401);
    expect(await count('SELECT count(*) FROM invites WHERE session_id=$1 AND character_id=$2', [sessionId, goneId])).toBe(0);
    expect(await count('SELECT count(*) FROM stream_links WHERE session_id=$1 AND character_id=$2', [sessionId, goneId])).toBe(0);
    expect(await count('SELECT count(*) FROM credentials WHERE stream_link_id=$1 OR character_id=$2', [linkId, goneId])).toBe(0);
    expect(await count('SELECT count(*) FROM submissions WHERE character_id=$1', [goneId])).toBe(0);
    expect(await count('SELECT count(*) FROM characters WHERE id=$1', [goneId])).toBe(0);

    const keptSnapshot = await snapshot(keptPlayer.cookie);
    expect(keptSnapshot.ownCharacter.id).toBe(kept.characterId);
    expect(keptSnapshot.characters.map((item: { id: string }) => item.id)).not.toContain(goneId);
    expect(keptSnapshot.characters).toHaveLength(players.length - 1);
    expect(keptSnapshot.setup).toBeDefined();
    expect(await count("SELECT count(*) FROM stream_links WHERE session_id=$1 AND character_id=$2 AND revoked_at IS NULL", [sessionId, kept.characterId])).toBe(1);
    for (const seat of players.slice(2)) expect((await redeem(seat.token)).status).toBe(200);

    const started = await send({ type: 'start_session', expectedStateRevision: await revision() });
    expect(started.statusCode, started.body).toBe(200);
  });

  it('replays the same command without removing a second seat', async () => {
    const command = { commandId: randomUUID(), type: 'remove_seat', expectedStateRevision: await revision(), characterId: players[0]!.characterId };
    const first = await call(`/api/sessions/${sessionId}/commands`, command);
    expect(first.statusCode, first.body).toBe(200);
    const again = await call(`/api/sessions/${sessionId}/commands`, command);
    expect(again.statusCode, again.body).toBe(200);
    expect((await snapshot()).characterDetails).toHaveLength(players.length - 1);
  });

  describe('ending a show', () => {
    it('cuts long player sign-ins to twelve hours, leaves the player able to read the ended show, and leaves the host alone', async () => {
      const player = await redeem(players[0]!.token);
      expect(player.status).toBe(200);
      const other = await redeem(players[1]!.token);
      await pool.query("UPDATE credentials SET expires_at=clock_timestamp()+interval '2000 hours' WHERE session_id=$1 AND role='player'", [sessionId]);
      await pool.query("UPDATE credentials SET expires_at=clock_timestamp()+interval '2 hours' WHERE session_id=$1 AND character_id=$2", [sessionId, players[1]!.characterId]);
      const hostBefore = (await pool.query("SELECT token_hash,expires_at FROM credentials WHERE role='host' ORDER BY token_hash")).rows;
      const ended = await send({ type: 'set_status', status: 'ended', expectedStateRevision: await revision() });
      expect(ended.statusCode, ended.body).toBe(200);

      const rows = (await pool.query("SELECT character_id, (expires_at - clock_timestamp()) < interval '12 hours 1 minute' AS capped, expires_at > clock_timestamp() AS live FROM credentials WHERE session_id=$1 AND role='player'", [sessionId])).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.capped && row.live)).toBe(true);
      const shortOne = (await pool.query("SELECT (expires_at - clock_timestamp()) < interval '2 hours' AS short FROM credentials WHERE session_id=$1 AND character_id=$2", [sessionId, players[1]!.characterId])).rows[0];
      expect(shortOne.short).toBe(true);
      const ownSnapshot = await snapshot(player.cookie);
      expect(ownSnapshot.session.status).toBe('ended');
      expect((await snapshot(other.cookie)).session.status).toBe('ended');
      expect((await pool.query("SELECT token_hash,expires_at FROM credentials WHERE role='host' ORDER BY token_hash")).rows).toEqual(hostBefore);
    });
  });
});
