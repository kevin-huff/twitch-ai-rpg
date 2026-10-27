import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionListEntrySchema, type DirectorSnapshot, type GalleryStatus, type SessionListEntry } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { GalleryService } from '../src/galleries';
import { FakeImageProvider } from '../src/fake-images';
import { GALLERY_CSP } from '../src/gallery-routes';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';

type App = Awaited<ReturnType<typeof buildApp>>;

suite('gallery wiring in the app', () => {
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  const open: App[] = [];
  const sessionIds: string[] = [];
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;

  async function boot(provider: FakeImageProvider | null = new FakeImageProvider(), dir: string | null = assetDir) {
    const hostToken = `gallery-wiring-host-${randomUUID()}`;
    const app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, ...(dir === null ? {} : { assetDir: dir }), ...(provider ? { images: provider } : {}) });
    open.push(app);
    const host = cookie(await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } }));
    const request = (url: string, payload?: Record<string, unknown>) => app.inject({
      method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, cookie: host }, ...(payload === undefined ? {} : { payload }),
    });
    const create = async (title: string) => {
      const response = await request('/api/sessions', { commandId: randomUUID(), title });
      expect(response.statusCode, response.body).toBe(200);
      const id = response.json().sessionId as string;
      sessionIds.push(id);
      return id;
    };
    const director = async (id: string) => (await request(`/api/sessions/${id}?view=director`)).json() as DirectorSnapshot;
    const send = async (id: string, payload: Record<string, unknown>) => {
      const response = await request(`/api/sessions/${id}/commands`, { commandId: randomUUID(), ...payload });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().snapshot as DirectorSnapshot;
    };
    const setStatus = async (id: string, status: string) => send(id, { type: 'set_status', status, expectedStateRevision: (await director(id)).session.stateRevision });
    const gallery = async (id: string, action: string) => {
      const response = await request(`/api/sessions/${id}/gallery`, { action });
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as GalleryStatus;
    };
    const sessions = async () => (await request('/api/sessions')).json() as SessionListEntry[];
    return { app, request, create, director, send, setStatus, gallery, sessions };
  }

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    assetDir = await mkdtemp(join(tmpdir(), 'rpg-gallery-wiring-'));
  });
  afterAll(async () => {
    for (const app of open) await app.close().catch(() => undefined);
    if (sessionIds.length) await pool.query('DELETE FROM galleries WHERE session_id = ANY($1)', [sessionIds]);
    await pool?.end();
    if (assetDir) await rm(assetDir, { recursive: true, force: true });
  });

  it('writes the shared files at start and serves the public list with its security headers', async () => {
    const h = await boot();
    for (const file of ['gallery.css', 'viewer.js', 'missing.html', 'index.html']) {
      expect(existsSync(join(assetDir, 'galleries', file)), file).toBe(true);
    }
    const list = await h.app.inject({ method: 'GET', url: '/gallery/' });
    expect(list.statusCode).toBe(200);
    expect(list.headers['content-security-policy']).toBe(GALLERY_CSP);
  });

  it('never starts the gallery service when the app is built without an asset folder', async () => {
    const start = vi.spyOn(GalleryService.prototype, 'start');
    try {
      await boot(null, null);
      expect(start).not.toHaveBeenCalled();
      await boot();
      expect(start).toHaveBeenCalledTimes(1);
    } finally { start.mockRestore(); }
  });

  it('reports the gallery in director snapshots and command responses, and leaves it out of the stage view', async () => {
    const h = await boot();
    const id = await h.create(`Wiring status ${randomUUID()}`);
    const live = await h.setStatus(id, 'live');
    expect(live.gallery?.state).toBe('closed');
    expect((await h.director(id)).gallery?.state).toBe('closed');

    const ended = await h.setStatus(id, 'ended');
    expect(ended.gallery).toMatchObject({ state: 'off', listed: false, url: null, pictures: 0 });
    expect((await h.director(id)).gallery?.state).toBe('off');

    const stage = (await h.request(`/api/sessions/${id}?view=stage`)).json() as Record<string, unknown>;
    expect(stage.role).toBe('stage');
    expect('gallery' in stage).toBe(false);

    const on = await h.gallery(id, 'on');
    expect(on.state).toBe('on');
    expect(on.url).toMatch(/^http:\/\/localhost:3000\/gallery\/[A-Za-z0-9_-]{43}\/$/);
    expect((await h.director(id)).gallery?.state).toBe('on');
  });

  it('lists sessions with their gallery state', async () => {
    const h = await boot();
    const id = await h.create(`Wiring list ${randomUUID()}`);
    const entry = async () => {
      const rows = await h.sessions();
      for (const row of rows) SessionListEntrySchema.parse(row);
      return rows.find(row => row.id === id)!;
    };
    expect(await entry()).toEqual({ id, title: expect.any(String), status: 'lobby', gallery: null });
    await h.setStatus(id, 'ended');
    const on = await h.gallery(id, 'on');
    expect((await entry()).gallery).toEqual({ listed: false, url: on.url });
    await h.gallery(id, 'list');
    expect((await entry()).gallery).toEqual({ listed: true, url: on.url });
  });

  it('adds a picture that finishes after the gallery is on', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const provider = new FakeImageProvider({ hold: () => held });
    const h = await boot(provider);
    const id = await h.create(`Wiring late ${randomUUID()}`);
    await h.setStatus(id, 'live');
    await vi.waitFor(() => expect(provider.requests.length).toBe(1), { timeout: 8000 });
    await h.setStatus(id, 'ended');
    const on = await h.gallery(id, 'on');
    expect(on.pending).toBe(1);
    expect(on.pictures).toBe(0);

    release();
    await vi.waitFor(async () => {
      const row = (await pool.query('SELECT pictures FROM galleries WHERE session_id=$1', [id])).rows[0];
      expect(row?.pictures).toBe(1);
    }, { timeout: 8000 });
    const slug = (await pool.query('SELECT slug FROM galleries WHERE session_id=$1', [id])).rows[0].slug as string;
    const picture = (await pool.query("SELECT id, content_type FROM images WHERE session_id=$1 AND status='ready'", [id])).rows[0];
    const html = await readFile(join(assetDir, 'galleries', slug, 'index.html'), 'utf8');
    expect(html).toContain(`/gallery/${slug}/p/${picture.id}.png`);
    expect((await h.director(id)).gallery).toMatchObject({ state: 'on', pictures: 1, pending: 0 });
  });

  it('serves each kind of gallery file with its own Cache-Control through the app', async () => {
    const h = await boot();
    const id = await h.create(`Wiring cache ${randomUUID()}`);
    await h.setStatus(id, 'live');
    await vi.waitFor(async () => {
      const row = (await pool.query("SELECT count(*)::int AS n FROM images WHERE session_id=$1 AND status='ready'", [id])).rows[0];
      expect(row.n).toBe(1);
    }, { timeout: 8000 });
    await h.setStatus(id, 'ended');
    await h.gallery(id, 'on');
    await vi.waitFor(async () => {
      const row = (await pool.query('SELECT pictures FROM galleries WHERE session_id=$1', [id])).rows[0];
      expect(row?.pictures).toBe(1);
    }, { timeout: 8000 });
    const slug = (await pool.query('SELECT slug FROM galleries WHERE session_id=$1', [id])).rows[0].slug as string;
    const picture = (await pool.query("SELECT id FROM images WHERE session_id=$1 AND status='ready'", [id])).rows[0];
    const get = (url: string) => h.app.inject({ method: 'GET', url });

    const page = await get(`/gallery/${slug}/`);
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('public, max-age=60');
    const image = await get(`/gallery/${slug}/p/${picture.id}.png`);
    expect(image.statusCode).toBe(200);
    expect(image.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    for (const file of ['gallery.css', 'viewer.js']) {
      const shared = await get(`/gallery/${file}`);
      expect(shared.statusCode, file).toBe(200);
      expect(shared.headers['cache-control'], file).toBe('public, max-age=300');
    }
    const missing = await get(`/gallery/${slug}/p/nothing.png`);
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['cache-control']).toBe('no-store');
  });
});
