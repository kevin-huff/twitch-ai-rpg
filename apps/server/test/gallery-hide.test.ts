import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DirectorSnapshot } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeImageProvider } from '../src/fake-images';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';

suite('picture changes after the show refresh the gallery', () => {
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const sessionIds: string[] = [];

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    assetDir = await mkdtemp(join(tmpdir(), 'rpg-gallery-hide-'));
  });
  afterAll(async () => {
    await app?.close().catch(() => undefined);
    if (sessionIds.length) await pool.query('DELETE FROM galleries WHERE session_id = ANY($1)', [sessionIds]);
    await pool?.end();
    if (assetDir) await rm(assetDir, { recursive: true, force: true });
  });

  it('rewrites the page after Hide, Show and Remove portrait once the show has ended', async () => {
    const provider = new FakeImageProvider();
    const hostToken = `gallery-hide-host-${randomUUID()}`;
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, assetDir, images: provider });
    const login = await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const call = (url: string, payload?: Record<string, unknown>) => app!.inject({
      method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, cookie }, ...(payload === undefined ? {} : { payload }),
    });
    const created = await call('/api/sessions', { commandId: randomUUID(), title: `Hide ${randomUUID()}` });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().sessionId as string;
    sessionIds.push(id);
    const director = async () => (await call(`/api/sessions/${id}?view=director`)).json() as DirectorSnapshot;
    const setStatus = async (status: string) => {
      const response = await call(`/api/sessions/${id}/commands`, { commandId: randomUUID(), type: 'set_status', status, expectedStateRevision: (await director()).session.stateRevision });
      expect(response.statusCode, response.body).toBe(200);
    };

    await setStatus('live');
    await vi.waitFor(async () => {
      const row = (await pool.query("SELECT status FROM images WHERE session_id=$1 AND purpose='scene'", [id])).rows[0];
      expect(row?.status).toBe('ready');
    }, { timeout: 8000 });
    const npc = (await director()).npcs[0]!;
    const asked = await call(`/api/sessions/${id}/npcs/${npc.id}/portrait`, {});
    expect(asked.statusCode, asked.body).toBe(202);
    const portraitId = asked.json().imageId as string;
    await vi.waitFor(async () => expect((await director()).npcs.find(entry => entry.id === npc.id)?.portraitId).toBe(portraitId), { timeout: 8000 });
    await setStatus('ended');
    const on = await call(`/api/sessions/${id}/gallery`, { action: 'on' });
    expect(on.statusCode, on.body).toBe(200);
    const slug = (await pool.query('SELECT slug FROM galleries WHERE session_id=$1', [id])).rows[0].slug as string;
    const page = () => readFile(join(assetDir, 'galleries', slug, 'index.html'), 'utf8');
    await vi.waitFor(async () => expect(await page()).toContain('/p/'), { timeout: 8000 });
    expect(await page()).not.toContain('Hidden');

    const hide = await call(`/api/sessions/${id}/scene-picture/hide`, {});
    expect(hide.statusCode, hide.body).toBe(200);
    expect(await page()).toContain('Hidden');

    const show = await call(`/api/sessions/${id}/scene-picture/show`, {});
    expect(show.statusCode, show.body).toBe(200);
    expect(await page()).not.toContain('Hidden');

    expect(await page()).not.toContain('More portraits');
    const removed = await call(`/api/sessions/${id}/npcs/${npc.id}/portrait/remove`, {});
    expect(removed.statusCode, removed.body).toBe(200);
    expect(await page()).toContain('More portraits');
  });
});
