import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp, hash } from '../src/app';
import { createPool } from '../src/database';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'sign-in-lifetime-test-host-credential';
const HOUR = 3600 * 1000;

type Response = { statusCode: number; body: string; headers: Record<string, unknown>; json(): any };
const setCookies = (response: Response) => {
  const values = response.headers['set-cookie'];
  return (Array.isArray(values) ? values : values ? [values] : []).map(String);
};
const cookieNamed = (response: Response, name: string) => setCookies(response).find((value) => value.startsWith(`${name}=`));
const tokenOf = (cookie: string) => cookie.split(';')[0]!.slice(cookie.indexOf('=') + 1);
const maxAgeOf = (cookie: string) => Number(/Max-Age=(\d+)/i.exec(cookie)![1]);

suite('sign-in lifetimes and renewal', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  const post = (url: string, payload: unknown, cookie?: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, headers: { origin, ...(cookie ? { cookie } : {}), ...headers }, payload: payload as Record<string, unknown> }) as Promise<Response>;
  const get = (url: string, cookie?: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers: { origin, ...(cookie ? { cookie } : {}), ...headers } }) as Promise<Response>;
  const expiryOf = async (token: string) => (await pool.query('SELECT expires_at FROM credentials WHERE token_hash=$1', [hash(token)])).rows[0].expires_at as Date;
  const setLeft = (token: string, hours: number) => pool.query("UPDATE credentials SET expires_at=clock_timestamp()+$2::int*interval '1 hour' WHERE token_hash=$1", [hash(token), hours]);
  const hoursLeft = async (token: string) => ((await expiryOf(token)).getTime() - Date.now()) / HOUR;

  async function hostSignIn() {
    const response = await post('/api/auth/host', { token: hostToken });
    expect(response.statusCode, response.body).toBe(200);
    return tokenOf(cookieNamed(response, 'rpg_session')!);
  }
  async function newShow(hostSession: string) {
    const response = await post('/api/sessions', { commandId: randomUUID() }, `rpg_session=${hostSession}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { sessionId: string; invites: Array<{ role: string; characterId: string | null; token: string }> };
  }
  async function redeem(token: string, tab?: true) {
    const response = await post('/api/auth/redeem', { token, ...(tab ? { tab } : {}) });
    expect(response.statusCode, response.body).toBe(200);
    return response;
  }

  let hostSession: string;
  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    hostSession = await hostSignIn();
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  describe('lifetimes at sign-in', () => {
    it('gives a player invitation 2160 hours with a matching cookie Max-Age', async () => {
      const show = await newShow(hostSession);
      const response = await redeem(show.invites.find((invite) => invite.role === 'player')!.token);
      const cookie = cookieNamed(response, 'rpg_session')!;
      expect(maxAgeOf(cookie)).toBe(7776000);
      const left = await hoursLeft(tokenOf(cookie));
      expect(left).toBeGreaterThan(2159.9);
      expect(left).toBeLessThanOrEqual(2160);
    });

    it('gives a per-tab player invitation the same lifetime', async () => {
      const show = await newShow(hostSession);
      const response = await redeem(show.invites.find((invite) => invite.role === 'player')!.token, true);
      const cookie = cookieNamed(response, `rpg_tab_${response.json().identityId}`)!;
      expect(maxAgeOf(cookie)).toBe(7776000);
      expect(await hoursLeft(tokenOf(cookie))).toBeGreaterThan(2159.9);
    });

    it('gives 12 hours to a player who redeems after the show ended', async () => {
      const show = await newShow(hostSession);
      await pool.query("UPDATE sessions SET status='ended' WHERE id=$1", [show.sessionId]);
      const response = await redeem(show.invites.find((invite) => invite.role === 'player')!.token);
      const cookie = cookieNamed(response, 'rpg_session')!;
      expect(maxAgeOf(cookie)).toBe(12 * 3600);
      const left = await hoursLeft(tokenOf(cookie));
      expect(left).toBeGreaterThan(11.9);
      expect(left).toBeLessThanOrEqual(12);
    });

    it('gives 12 hours to a stage invitation, a test seat and the host', async () => {
      const show = await newShow(hostSession);
      const stage = cookieNamed(await redeem(show.invites.find((invite) => invite.role === 'stage')!.token), 'rpg_session')!;
      const seat = await post(`/api/sessions/${show.sessionId}/test-seat`, { characterId: show.invites.find((invite) => invite.role === 'player')!.characterId }, `rpg_session=${hostSession}`);
      expect(seat.statusCode, seat.body).toBe(200);
      const seatCookie = cookieNamed(seat, `rpg_tab_${seat.json().identityId}`)!;
      const hostResponse = await post('/api/auth/host', { token: hostToken });
      const hostCookie = cookieNamed(hostResponse, 'rpg_session')!;
      for (const cookie of [stage, seatCookie, hostCookie]) {
        expect(maxAgeOf(cookie)).toBe(12 * 3600);
        const left = await hoursLeft(tokenOf(cookie));
        expect(left).toBeGreaterThan(11.9);
        expect(left).toBeLessThanOrEqual(12);
      }
    });

    it('still accepts tab on host sign-in', async () => {
      const response = await post('/api/auth/host', { token: hostToken, tab: true });
      expect(response.statusCode, response.body).toBe(200);
      expect(cookieNamed(response, `rpg_tab_${response.json().identityId}`)).toBeDefined();
      expect(cookieNamed(response, 'rpg_session')).toBeUndefined();
    });
  });

  describe('renewal on use', () => {
    it('renews a host sign-in with 5 hours left to about 12 hours and re-sets rpg_session', async () => {
      const token = await hostSignIn();
      await setLeft(token, 5);
      const response = await get('/api/sessions', `rpg_session=${token}`);
      expect(response.statusCode, response.body).toBe(200);
      const cookie = cookieNamed(response, 'rpg_session')!;
      expect(cookie).toBeDefined();
      expect(tokenOf(cookie)).toBe(token);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(maxAgeOf(cookie)).toBeGreaterThan(12 * 3600 - 60);
      expect(maxAgeOf(cookie)).toBeLessThanOrEqual(12 * 3600);
      const left = await hoursLeft(token);
      expect(left).toBeGreaterThan(11.9);
      expect(left).toBeLessThanOrEqual(12);
    });

    it('does not renew a host sign-in with 7 hours left', async () => {
      const token = await hostSignIn();
      await setLeft(token, 7);
      const before = await expiryOf(token);
      const response = await get('/api/sessions', `rpg_session=${token}`);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect((await expiryOf(token)).getTime()).toBe(before.getTime());
    });

    it('does not renew a host sign-in made under an old host credential', async () => {
      const token = await hostSignIn();
      await pool.query('UPDATE credentials SET actor_id=$2 WHERE token_hash=$1', [hash(token), hash('an-old-host-credential-from-before-rotation')]);
      await setLeft(token, 5);
      const before = await expiryOf(token);
      const response = await get('/api/sessions', `rpg_session=${token}`);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect((await expiryOf(token)).getTime()).toBe(before.getTime());
    });

    it('runs no renewal query for a sign-in with 7 hours left', async () => {
      const token = await hostSignIn();
      await setLeft(token, 7);
      await pool.query('CREATE TABLE IF NOT EXISTS credential_update_count(n int NOT NULL)');
      await pool.query('TRUNCATE credential_update_count');
      await pool.query("CREATE OR REPLACE FUNCTION count_credential_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO credential_update_count VALUES (1); RETURN NULL; END $$");
      await pool.query('CREATE TRIGGER credential_update_counter AFTER UPDATE ON credentials FOR EACH STATEMENT EXECUTE FUNCTION count_credential_update()');
      try {
        const response = await get('/api/sessions', `rpg_session=${token}`);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.headers['set-cookie']).toBeUndefined();
        expect((await pool.query('SELECT count(*)::int AS n FROM credential_update_count')).rows[0].n).toBe(0);
      } finally {
        await pool.query('DROP TRIGGER credential_update_counter ON credentials');
        await pool.query('DROP FUNCTION count_credential_update()');
        await pool.query('DROP TABLE credential_update_count');
      }
    });

    it('never renews a tab cookie', async () => {
      const signIn = await post('/api/auth/host', { token: hostToken, tab: true });
      const identityId = signIn.json().identityId as string;
      const token = tokenOf(cookieNamed(signIn, `rpg_tab_${identityId}`)!);
      await setLeft(token, 5);
      const before = await expiryOf(token);
      const response = await get('/api/sessions', `rpg_tab_${identityId}=${token}`, { 'x-rpg-identity': identityId });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect((await expiryOf(token)).getTime()).toBe(before.getTime());
    });

    it('leaves rpg_session alone when the request selects a tab identity, valid or not', async () => {
      const token = await hostSignIn();
      await setLeft(token, 5);
      const before = await expiryOf(token);
      const signIn = await post('/api/auth/host', { token: hostToken, tab: true });
      const identityId = signIn.json().identityId as string;
      const tab = tokenOf(cookieNamed(signIn, `rpg_tab_${identityId}`)!);
      const valid = await get('/api/sessions', `rpg_session=${token}; rpg_tab_${identityId}=${tab}`, { 'x-rpg-identity': identityId });
      expect(valid.statusCode, valid.body).toBe(200);
      expect(valid.headers['set-cookie']).toBeUndefined();
      const invalid = await get('/api/sessions', `rpg_session=${token}`, { 'x-rpg-identity': 'not-an-identity' });
      expect(invalid.statusCode).toBe(401);
      expect(invalid.headers['set-cookie']).toBeUndefined();
      expect((await expiryOf(token)).getTime()).toBe(before.getTime());
    });

    it('never renews a player sign-in', async () => {
      const show = await newShow(hostSession);
      const token = tokenOf(cookieNamed(await redeem(show.invites.find((invite) => invite.role === 'player')!.token), 'rpg_session')!);
      await setLeft(token, 5);
      const before = await expiryOf(token);
      const response = await get(`/api/sessions/${show.sessionId}`, `rpg_session=${token}`);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect((await expiryOf(token)).getTime()).toBe(before.getTime());
    });

    it('never renews on routes under /api/auth/', async () => {
      const token = await hostSignIn();
      await setLeft(token, 5);
      const before = await expiryOf(token);
      const response = await get('/api/auth/me', `rpg_session=${token}`);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect((await expiryOf(token)).getTime()).toBe(before.getTime());
    });

    it('never renews a revoked sign-in', async () => {
      const token = await hostSignIn();
      await setLeft(token, 5);
      await pool.query('UPDATE credentials SET revoked_at=clock_timestamp() WHERE token_hash=$1', [hash(token)]);
      const before = await expiryOf(token);
      const response = await get('/api/sessions', `rpg_session=${token}`);
      expect(response.statusCode).toBe(401);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect((await expiryOf(token)).getTime()).toBe(before.getTime());
    });

    it('renews a producer sign-in but never past the grant', async () => {
      const created = await post('/api/producers', { commandId: randomUUID(), label: 'Renewal producer' }, `rpg_session=${hostSession}`);
      expect(created.statusCode, created.body).toBe(200);
      const { token: link, producer } = created.json() as { token: string; producer: { id: string } };
      const signIn = await post('/api/auth/producer', { token: link });
      expect(signIn.statusCode, signIn.body).toBe(200);
      const token = tokenOf(cookieNamed(signIn, 'rpg_session')!);

      await setLeft(token, 5);
      const renewed = await get('/api/sessions', `rpg_session=${token}`);
      expect(renewed.statusCode, renewed.body).toBe(200);
      expect(maxAgeOf(cookieNamed(renewed, 'rpg_session')!)).toBeGreaterThan(12 * 3600 - 60);
      expect(await hoursLeft(token)).toBeGreaterThan(11.9);

      await pool.query("UPDATE producer_grants SET expires_at=clock_timestamp()+interval '8 hours' WHERE id=$1", [producer.id]);
      const grantExpiry = (await pool.query('SELECT expires_at FROM producer_grants WHERE id=$1', [producer.id])).rows[0].expires_at as Date;
      await setLeft(token, 5);
      const capped = await get('/api/sessions', `rpg_session=${token}`);
      expect(capped.statusCode, capped.body).toBe(200);
      const cookie = cookieNamed(capped, 'rpg_session')!;
      expect(maxAgeOf(cookie)).toBeGreaterThan(8 * 3600 - 60);
      expect(maxAgeOf(cookie)).toBeLessThanOrEqual(8 * 3600);
      expect((await expiryOf(token)).getTime()).toBe(grantExpiry.getTime());

      await pool.query("UPDATE producer_grants SET expires_at=clock_timestamp()+interval '3 hours' WHERE id=$1", [producer.id]);
      await pool.query('UPDATE credentials SET expires_at=(SELECT expires_at FROM producer_grants WHERE id=$2) WHERE token_hash=$1', [hash(token), producer.id]);
      const before = await expiryOf(token);
      const atGrant = await get('/api/sessions', `rpg_session=${token}`);
      expect(atGrant.statusCode, atGrant.body).toBe(200);
      expect(atGrant.headers['set-cookie']).toBeUndefined();
      expect((await expiryOf(token)).getTime()).toBe(before.getTime());
    });
  });

  it('clears rpg_session on logout', async () => {
    const token = await hostSignIn();
    const response = await post('/api/auth/logout', {}, `rpg_session=${token}`);
    expect(response.statusCode, response.body).toBe(200);
    const cookie = cookieNamed(response, 'rpg_session')!;
    expect(cookie).toBeDefined();
    expect(tokenOf(cookie)).toBe('');
    expect((await get('/api/sessions', `rpg_session=${token}`)).statusCode).toBe(401);
  });
});
