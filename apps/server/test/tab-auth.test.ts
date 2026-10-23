import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io } from 'socket.io-client';
import { createPool } from '../src/database';
import { buildApp } from '../src/app';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'multi-identity-test-host-credential';

suite('independent browser-tab credentials', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let jar: Map<string, string>;
  let sessionId: string;
  let characters: Array<{ id: string; secret: string }>;
  let invites: Array<{ role: string; characterId: string | null; token: string }>;
  const cookies = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  function remember(response: { headers: Record<string, unknown> }) {
    const values = response.headers['set-cookie'];
    for (const value of Array.isArray(values) ? values : values ? [values] : []) {
      const pair = String(value).split(';')[0]!;
      const split = pair.indexOf('=');
      jar.set(pair.slice(0, split), pair.slice(split + 1));
    }
  }
  async function request(url: string, payload?: Record<string, unknown>, identityId?: string, additional: Record<string, string> = {}) {
    const result = await app.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, cookie: cookies(), ...(identityId === undefined ? {} : { 'x-rpg-identity': identityId }), ...additional }, ...(payload === undefined ? {} : { payload }) });
    remember(result);
    return result;
  }
  async function tabHost() {
    const result = await request('/api/auth/host', { token: hostToken, tab: true });
    expect(result.statusCode, result.body).toBe(200);
    const identityId = result.json().identityId as string;
    expect(identityId).toMatch(/^[a-f0-9]{32}$/);
    expect(String(result.headers['set-cookie'])).toContain(`rpg_tab_${identityId}=`);
    expect(String(result.headers['set-cookie'])).not.toContain('rpg_session=');
    return identityId;
  }
  async function testSeat(characterId: string, hostIdentity: string) {
    const result = await request(`/api/sessions/${sessionId}/test-seat`, { characterId }, hostIdentity);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ sessionId, role: 'player', characterId });
    expect(result.json().identityId).toMatch(/^[a-f0-9]{32}$/);
    return result.json().identityId as string;
  }
  beforeEach(async () => {
    jar = new Map();
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    expect((await request('/api/auth/host', { token: hostToken })).statusCode).toBe(200);
    const created = (await request('/api/sessions', { commandId: crypto.randomUUID() })).json();
    sessionId = created.sessionId; invites = created.invites;
    characters = (await request(`/api/sessions/${sessionId}`)).json().characterDetails;
  });
  afterEach(async () => { await app.close(); });

  it('retains a host, two player seats, and a stage in one cookie jar without changing the legacy identity', async () => {
    const legacy = jar.get('rpg_session');
    const hostIdentity = await tabHost();
    const first = await testSeat(characters[0]!.id, hostIdentity);
    const second = await testSeat(characters[1]!.id, hostIdentity);
    const redeemed = await request('/api/auth/redeem', { token: invites.find((invite) => invite.role === 'stage')!.token, tab: true });
    expect(redeemed.statusCode).toBe(200);
    const stage = redeemed.json().identityId;
    expect(jar.get('rpg_session')).toBe(legacy);
    expect(new Set([hostIdentity, first, second, stage]).size).toBe(4);
    expect((await request(`/api/sessions/${sessionId}`, undefined, hostIdentity)).json().role).toBe('director');
    const firstSnapshot = (await request(`/api/sessions/${sessionId}`, undefined, first)).json();
    const secondSnapshot = (await request(`/api/sessions/${sessionId}?identity=${second}`)).json();
    expect(firstSnapshot.ownCharacter.id).toBe(characters[0]!.id);
    expect(secondSnapshot.ownCharacter.id).toBe(characters[1]!.id);
    expect(JSON.stringify(firstSnapshot)).not.toContain(characters[1]!.secret);
    expect((await request(`/api/sessions/${sessionId}`, undefined, stage)).json().role).toBe('stage');
    expect((await request(`/api/sessions/${sessionId}`)).json().role).toBe('director');
    const originalInvite = invites.find((invite) => invite.characterId === characters[0]!.id)!;
    expect((await request('/api/auth/redeem', { token: originalInvite.token, tab: true })).statusCode).toBe(200);
  });

  it('fails closed for malformed, missing-cookie, conflicting, or duplicate identity selectors', async () => {
    for (const selector of ['not-an-identity', '', 'f'.repeat(32)]) {
      expect((await request(`/api/sessions/${sessionId}`, undefined, selector)).statusCode).toBe(401);
    }
    expect((await request(`/api/sessions/${sessionId}?identity=${'a'.repeat(32)}`, undefined, 'b'.repeat(32))).statusCode).toBe(401);
    expect((await request(`/api/sessions/${sessionId}?identity=${'a'.repeat(32)}&identity=${'b'.repeat(32)}`)).statusCode).toBe(401);
  });

  it('restricts test seats to the owning host and characters in that session', async () => {
    const hostIdentity = await tabHost();
    const playerIdentity = await testSeat(characters[0]!.id, hostIdentity);
    expect((await request(`/api/sessions/${sessionId}/test-seat`, { characterId: characters[1]!.id }, playerIdentity)).statusCode).toBe(403);
    expect((await request(`/api/sessions/${sessionId}/test-seat`, { characterId: characters[1]!.id, role: 'host' }, hostIdentity)).statusCode).toBe(400);
    const other = (await request('/api/sessions', { commandId: crypto.randomUUID() }, hostIdentity)).json();
    const otherCharacter = (await request(`/api/sessions/${other.sessionId}`, undefined, hostIdentity)).json().characters[0].id;
    expect((await request(`/api/sessions/${sessionId}/test-seat`, { characterId: otherCharacter }, hostIdentity)).statusCode).toBe(404);
    const pool = createPool(databaseUrl!);
    try { await pool.query('UPDATE sessions SET owner_id=$2 WHERE id=$1', [other.sessionId, 'another-host']); }
    finally { await pool.end(); }
    expect((await request(`/api/sessions/${other.sessionId}/test-seat`, { characterId: otherCharacter }, hostIdentity)).statusCode).toBe(404);
  });

  it('revokes and clears only the selected tab credential on logout', async () => {
    const hostIdentity = await tabHost();
    const playerIdentity = await testSeat(characters[0]!.id, hostIdentity);
    const originalCookie = jar.get(`rpg_tab_${playerIdentity}`)!;
    const result = await request('/api/auth/logout', {}, playerIdentity);
    expect(result.statusCode).toBe(200);
    expect(String(result.headers['set-cookie'])).toContain(`rpg_tab_${playerIdentity}=`);
    expect(String(result.headers['set-cookie'])).not.toContain('rpg_session=');
    jar.set(`rpg_tab_${playerIdentity}`, originalCookie);
    expect((await request(`/api/sessions/${sessionId}`, undefined, playerIdentity)).statusCode).toBe(401);
    expect((await request(`/api/sessions/${sessionId}`, undefined, hostIdentity)).json().role).toBe('director');
    expect((await request(`/api/sessions/${sessionId}`)).json().role).toBe('director');
  });

  it('rejects a selected logout when its cookie contains an unrecognized credential', async () => {
    const hostIdentity = await tabHost();
    const missing = 'c'.repeat(32);
    jar.set(`rpg_tab_${missing}`, 'unrecognized-credential');
    const response = await request('/api/auth/logout', {}, missing);
    expect(response.statusCode).toBe(401);
    expect((await request(`/api/sessions/${sessionId}`, undefined, hostIdentity)).json().role).toBe('director');
  });

  it('selects the same credential for native audio URLs and never falls back to the host', async () => {
    const hostIdentity = await tabHost();
    const playerIdentity = await testSeat(characters[0]!.id, hostIdentity);
    const own = await request(`/api/sessions/${sessionId}?identity=${playerIdentity}`);
    expect(own.json().role).toBe('player');
    jar.delete(`rpg_tab_${playerIdentity}`);
    expect((await request(`/api/sessions/${sessionId}?identity=${playerIdentity}`)).statusCode).toBe(401);
  });

  it('fails closed for socket identity selection and revokes only that socket on logout', async () => {
    const hostIdentity = await tabHost();
    const playerIdentity = await testSeat(characters[0]!.id, hostIdentity);
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const connect = (identityId: string, cookie = cookies(), selectorHeader?: string) => io(base, { transports: ['polling'], auth: { sessionId, identityId }, extraHeaders: { cookie, ...(selectorHeader === undefined ? {} : { 'x-rpg-identity': selectorHeader }) }, reconnection: false, timeout: 1500 });
    const awaitConnect = (client: ReturnType<typeof connect>) => new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    const hostSocket = connect(hostIdentity);
    const playerSocket = connect(playerIdentity);
    const invalid = connect('invalid');
    const conflicting = connect(hostIdentity, cookies(), playerIdentity);
    const missing = connect(playerIdentity, `rpg_session=${jar.get('rpg_session')}; rpg_tab_${hostIdentity}=${jar.get(`rpg_tab_${hostIdentity}`)}`);
    try {
      const [, , invalidRejected, missingRejected, conflictingRejected] = await Promise.all([awaitConnect(hostSocket), awaitConnect(playerSocket), awaitConnect(invalid).then(() => false, () => true), awaitConnect(missing).then(() => false, () => true), awaitConnect(conflicting).then(() => false, () => true)]);
      expect(invalidRejected).toBe(true);
      expect(missingRejected).toBe(true);
      expect(conflictingRejected).toBe(true);
      const disconnected = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The revoked socket remained connected.')), 2000);
        playerSocket.once('disconnect', () => { clearTimeout(timer); resolve(); });
      });
      await request('/api/auth/logout', {}, playerIdentity);
      await disconnected;
      expect(hostSocket.connected).toBe(true);
    } finally { for (const client of [hostSocket, playerSocket, invalid, missing, conflicting]) client.disconnect(); }
  });
});
