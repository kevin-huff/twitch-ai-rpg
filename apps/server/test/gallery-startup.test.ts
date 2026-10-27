import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GalleryAction } from '@rpg/contracts';
import { createLedgerState } from '@rpg/test-fixtures';
import { createPool, migrate, transaction } from '../src/database';
import { fakeImageBytes } from '../src/fake-images';
import { GalleryService, newGallerySlug } from '../src/galleries';
import { readGalleryPageVersion } from '../src/gallery-files';
import { GALLERY_PAGE_VERSION } from '../src/gallery-html';
import { storeImage } from '../src/image-files';
import { saveState, type Actor } from '../src/repository';

const control = vi.hoisted(() => ({ runs: 0, gate: null as Promise<void> | null, started: [] as (() => void)[] }));

vi.mock('../src/gallery-files', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/gallery-files')>();
  return {
    ...actual,
    writeGalleryFolder: (async (...args: Parameters<typeof actual.writeGalleryFolder>) => {
      control.runs += 1;
      for (const notify of control.started.splice(0)) notify();
      if (control.gate) await control.gate;
      return actual.writeGalleryFolder(...args);
    }) as typeof actual.writeGalleryFolder,
  };
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'https://stories.example.com';

let releaseHeld: (() => void) | null = null;

function hold() {
  let release!: () => void;
  control.gate = new Promise<void>(resolve => { release = resolve; });
  releaseHeld = () => { control.gate = null; releaseHeld = null; release(); };
  return releaseHeld;
}

const nextRun = () => new Promise<void>(resolve => { control.started.push(resolve); });

suite('gallery service start-up and close', () => {
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  let service: GalleryService;
  const sessionIds: string[] = [];
  const extraDirs: string[] = [];

  async function addPicture(sessionId: string, owner: string, sceneId: string, prompt: string, minute = 0) {
    const stored = await storeImage(assetDir, fakeImageBytes({ prompt: `${prompt} for ${sessionId}`, width: 768, height: 512 }));
    const pictureId = randomUUID();
    await pool.query(
      `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, status, prompt, width, height, provider, model,
         requested_by, file_hash, content_type, byte_length, created_at)
       VALUES($1,$2,$3,'scene',$4,'gallery-startup-test','ready',$5,768,512,'fake','fake-image',$2,$6,$7,$8,$9)`,
      [pictureId, owner, sessionId, sceneId, prompt, stored.fileHash, stored.contentType, stored.byteLength, new Date(Date.UTC(2026, 9, 25, 2, minute))]);
    return pictureId;
  }

  async function newShow(status = 'ended') {
    const id = `gallery-startup-${randomUUID()}`;
    const owner = `owner-${id}`;
    sessionIds.push(id);
    const state = createLedgerState(id, randomUUID);
    state.session.status = status as typeof state.session.status;
    state.session.title = `Refresh show ${sessionIds.length}`;
    await pool.query('INSERT INTO sessions(id, owner_id, title, scene, status) VALUES($1,$2,$3,$4,$5)', [id, owner, state.session.title, state.session.scene, status]);
    const client = await pool.connect();
    try { await saveState(client, state); } finally { client.release(); }
    const pictureId = await addPicture(id, owner, state.session.scene.id, 'A lantern-lit harbor');
    return { id, owner, sceneId: state.session.scene.id, pictureId, actor: { actor_id: owner, role: 'host', session_id: null, character_id: null } as Actor };
  }

  const apply = (show: { id: string; actor: Actor }, action: GalleryAction['action'], target = service) =>
    transaction(pool, client => target.apply(client, show.actor, show.id, action));
  const act = async (show: { id: string; actor: Actor }, action: GalleryAction['action'], target = service) => {
    const work = await apply(show, action, target);
    await target.afterCommit(show.id, work);
    return work;
  };
  const row = async (id: string) => (await pool.query('SELECT * FROM galleries WHERE session_id=$1', [id])).rows[0];
  const writtenEvents = async (id: string) => Number((await pool.query(
    "SELECT count(*) AS count FROM audit_events WHERE session_id=$1 AND kind='gallery.written'", [id])).rows[0].count);
  const folder = (slug: string, dir = assetDir) => join(dir, 'galleries', slug);
  const freshDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gallery-startup-dir-'));
    extraDirs.push(dir);
    return dir;
  };
  const until = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 200; i += 1) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('condition not met');
  };

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    await migrate(pool);
    assetDir = await mkdtemp(join(tmpdir(), 'gallery-startup-'));
    service = new GalleryService({ pool, assetDir, origin });
  });

  afterEach(() => {
    releaseHeld?.();
    control.started.splice(0);
  });

  afterAll(async () => {
    await service?.close();
    if (pool) {
      await pool.query('DELETE FROM galleries WHERE session_id = ANY($1::text[])', [sessionIds]);
      await pool.query('DELETE FROM images WHERE session_id = ANY($1::text[])', [sessionIds]);
      await pool.query('DELETE FROM outbox WHERE session_id = ANY($1::text[])', [sessionIds]);
      await pool.query('DELETE FROM audit_events WHERE session_id = ANY($1::text[])', [sessionIds]);
      for (const table of ['characters', 'npcs', 'tracks', 'facts']) await pool.query(`DELETE FROM ${table} WHERE session_id = ANY($1::text[])`, [sessionIds]);
      await pool.query('DELETE FROM sessions WHERE id = ANY($1::text[])', [sessionIds]);
      await pool.end();
    }
    for (const dir of [assetDir, ...extraDirs]) if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('start removes an orphan slug folder and keeps the folder of a live gallery row', async () => {
    const dir = await freshDir();
    const show = await newShow();
    const liveSlug = newGallerySlug();
    const orphan = newGallerySlug();
    await pool.query('INSERT INTO galleries(session_id, slug) VALUES($1,$2)', [show.id, liveSlug]);
    await mkdir(join(folder(liveSlug, dir), 'p'), { recursive: true });
    await writeFile(join(folder(liveSlug, dir), 'keep.txt'), 'live');
    await mkdir(join(folder(orphan, dir), 'p'), { recursive: true });
    await writeFile(join(folder(orphan, dir), 'index.html'), 'old');
    await mkdir(join(dir, 'galleries', 'not-a-slug'), { recursive: true });
    const starter = new GalleryService({ pool, assetDir: dir, origin });
    await expect(starter.start()).resolves.toBeUndefined();
    expect(existsSync(folder(orphan, dir))).toBe(false);
    expect(existsSync(join(folder(liveSlug, dir), 'keep.txt'))).toBe(true);
    expect(existsSync(join(dir, 'galleries', 'not-a-slug'))).toBe(true);
    await starter.close();
  });

  it('start removes old temp files but keeps fresh ones', async () => {
    const dir = await freshDir();
    await mkdir(join(dir, 'galleries'), { recursive: true });
    const old = join(dir, 'galleries', '.old.tmp');
    const fresh = join(dir, 'galleries', '.fresh.tmp');
    await writeFile(old, 'x');
    await writeFile(fresh, 'x');
    const longAgo = new Date(Date.now() - 3_600_000);
    await utimes(old, longAgo, longAgo);
    const starter = new GalleryService({ pool, assetDir: dir, origin });
    await starter.start();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    await starter.close();
  });

  it('start rewrites finished galleries in its own folder once after the page version changes, and no others', async () => {
    const dir = await freshDir();
    const here = await newShow();
    const elsewhere = await newShow();
    const writer = new GalleryService({ pool, assetDir: dir, origin });
    await act(here, 'on', writer);
    await act(elsewhere, 'on');
    await writer.close();
    expect(await readGalleryPageVersion(dir)).toBeNull();
    const [hereBefore, elsewhereBefore] = [await writtenEvents(here.id), await writtenEvents(elsewhere.id)];

    const first = new GalleryService({ pool, assetDir: dir, origin });
    await first.start();
    await until(async () => (await readGalleryPageVersion(dir)) === GALLERY_PAGE_VERSION);
    expect(await writtenEvents(here.id)).toBe(hereBefore + 1);
    expect(await writtenEvents(elsewhere.id)).toBe(elsewhereBefore);
    await first.close();

    const second = new GalleryService({ pool, assetDir: dir, origin });
    await second.start();
    await second.close();
    expect(await writtenEvents(here.id)).toBe(hereBefore + 1);
  });

  it('start rewrites a gallery that was never finished, in the background', async () => {
    const dir = await freshDir();
    const show = await newShow();
    const slug = newGallerySlug();
    await pool.query('INSERT INTO galleries(session_id, slug) VALUES($1,$2)', [show.id, slug]);
    await mkdir(folder(slug, dir), { recursive: true });
    expect(existsSync(join(folder(slug, dir), 'index.html'))).toBe(false);
    const release = hold();
    const started = nextRun();
    const starter = new GalleryService({ pool, assetDir: dir, origin });
    // The gated write cannot finish, yet start() must come back: the per-row refresh is not awaited.
    await expect(starter.start()).resolves.toBeUndefined();
    await started;
    expect(existsSync(join(folder(slug, dir), 'index.html'))).toBe(false);
    release();
    await until(async () => (await row(show.id)).written_at instanceof Date);
    expect(existsSync(join(folder(slug, dir), 'index.html'))).toBe(true);
    await starter.close();
  });

  it('a removal queued behind a slow write still deletes the folder when close is called', async () => {
    const dir = await freshDir();
    const show = await newShow();
    const closing = new GalleryService({ pool, assetDir: dir, origin });
    await apply(show, 'on', closing);
    const { slug } = await row(show.id);
    const release = hold();
    const started = nextRun();
    const refreshing = closing.refresh(show.id);
    await started;
    const work = await apply(show, 'off', closing);
    expect(work).toEqual({ kind: 'remove', slug });
    const removing = closing.afterCommit(show.id, work);
    const closed = closing.close();
    release();
    await Promise.all([refreshing, removing, closed]);
    expect(existsSync(folder(slug, dir))).toBe(false);
  });

  it('close resolves within the limit even when a queued job never finishes', async () => {
    const dir = await freshDir();
    const show = await newShow();
    const closing = new GalleryService({ pool, assetDir: dir, origin });
    await apply(show, 'on', closing);
    const release = hold();
    const started = nextRun();
    const refreshing = closing.refresh(show.id);
    await started;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let done = false;
      const closed = closing.close().then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await closed;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    release();
    await refreshing;
  });
});
