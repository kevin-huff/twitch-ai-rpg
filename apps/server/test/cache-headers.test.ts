import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app';
import { FakeImageProvider } from '../src/fake-images';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';

suite('cache headers', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken: `cache-test-host-${randomUUID()}`, origin, serveStatic: false });
  });
  afterEach(async () => { await app?.close(); });

  it('keeps API responses uncacheable', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not mark a missing asset as immutable', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/missing.js' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('caches a stored picture for good and keeps a missing one uncacheable', async () => {
    const hostToken = `cache-image-host-${randomUUID()}`;
    const assetDir = await mkdtemp(join(tmpdir(), 'rpg-cache-images-'));
    const pictures = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, assetDir, images: new FakeImageProvider() });
    try {
      const signedIn = await pictures.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } });
      const headers = { origin, cookie: String(signedIn.headers['set-cookie']).split(';')[0]! };
      const made = await pictures.inject({
        method: 'POST', url: '/api/library/portraits', headers,
        payload: { subject: 'card', subjectKey: 'cache-card', details: { appearance: 'A tall figure in a grey coat.' } },
      });
      expect(made.statusCode, made.body).toBe(200);
      const response = await pictures.inject({ method: 'GET', url: `/api/library/images/${made.json().imageId}`, headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, max-age=31536000, immutable');
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.rawPayload.subarray(1, 4).toString('ascii')).toBe('PNG');

      const missing = await pictures.inject({ method: 'GET', url: `/api/library/images/${randomUUID()}`, headers });
      expect(missing.statusCode).toBe(404);
      expect(missing.headers['cache-control']).toBe('no-store');
    } finally {
      await pictures.close();
      await rm(assetDir, { recursive: true, force: true });
    }
  });
});
