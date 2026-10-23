import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, hash } from '../src/app';
import { createPool } from '../src/database';

const origin = 'http://localhost:3000';
const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite('host authentication and browser origin boundary', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken: 'test-host-credential-at-least-32-characters', origin });
  });
  afterAll(async () => { await app?.close(); });

  it('refuses unauthenticated session creation', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { commandId: crypto.randomUUID() } });
    expect(response.statusCode).toBe(401);
  });

  it('rejects cross-origin and incorrect host credentials', async () => {
    const external = await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin: 'https://untrusted.example' }, payload: { token: 'test-host-credential-at-least-32-characters' } });
    expect(external.statusCode).toBe(403);
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: 'incorrect' } });
    expect(wrong.statusCode).toBe(401);
  });

  it('exchanges host credentials for an opaque HTTP-only cookie', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: 'test-host-credential-at-least-32-characters' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('SameSite=Strict');
    expect(response.headers['set-cookie']).not.toContain('test-host-credential');
    expect(response.json()).toEqual({ role: 'host' });
  });
  it('rejects expired and revoked cookies without exposing credentials', async () => {
    const pool = createPool(databaseUrl!);
    try {
      const login = () => app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: 'test-host-credential-at-least-32-characters' } });
      const first = await login();
      const firstCookie = String(first.headers['set-cookie']).split(';')[0]!;
      const rawToken = firstCookie.slice(firstCookie.indexOf('=') + 1);
      const stored = (await pool.query('SELECT token_hash FROM credentials WHERE token_hash=$1', [hash(rawToken)])).rows[0];
      expect(stored.token_hash).not.toBe(rawToken);
      await pool.query(`UPDATE credentials SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, [hash(rawToken)]);
      expect((await app.inject({ method: 'GET', url: '/api/sessions', headers: { cookie: firstCookie } })).statusCode).toBe(401);
      const second = await login();
      const secondCookie = String(second.headers['set-cookie']).split(';')[0]!;
      expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin, cookie: secondCookie } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/sessions', headers: { cookie: secondCookie } })).statusCode).toBe(401);
    } finally { await pool.end(); }
  });
});
