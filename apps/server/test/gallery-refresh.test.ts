import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GalleryAction } from '@rpg/contracts';
import { createLedgerState } from '@rpg/test-fixtures';
import { createPool, migrate, transaction } from '../src/database';
import { fakeImageBytes } from '../src/fake-images';
import { GalleryService, newGallerySlug } from '../src/galleries';
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

suite('gallery service file work', () => {
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
       VALUES($1,$2,$3,'scene',$4,'gallery-refresh-test','ready',$5,768,512,'fake','fake-image',$2,$6,$7,$8,$9)`,
      [pictureId, owner, sessionId, sceneId, prompt, stored.fileHash, stored.contentType, stored.byteLength, new Date(Date.UTC(2026, 9, 25, 2, minute))]);
    return pictureId;
  }

  async function newShow(status = 'ended') {
    const id = `gallery-refresh-${randomUUID()}`;
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
  const folder = (slug: string, dir = assetDir) => join(dir, 'galleries', slug);

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    await migrate(pool);
    assetDir = await mkdtemp(join(tmpdir(), 'gallery-refresh-'));
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

  it('writes the page and the picture after on, and records the write', async () => {
    const show = await newShow();
    await act(show, 'on');
    const written = await row(show.id);
    const html = await readFile(join(folder(written.slug), 'index.html'), 'utf8');
    expect(html).toContain(`/gallery/${written.slug}/p/${show.pictureId}.png`);
    expect(existsSync(join(folder(written.slug), 'p', `${show.pictureId}.png`))).toBe(true);
    expect(written.pictures).toBe(1);
    expect(written.written_at).toBeInstanceOf(Date);
    expect(written.message).toBeNull();
  });

  it('puts a listed, written show on the public list and leaves an unlisted one off', async () => {
    const listed = await newShow();
    const unlisted = await newShow();
    await act(listed, 'on');
    await act(unlisted, 'on');
    await act(listed, 'list');
    const listedSlug = (await row(listed.id)).slug;
    const unlistedSlug = (await row(unlisted.id)).slug;
    const list = await readFile(join(assetDir, 'galleries', 'index.html'), 'utf8');
    expect(list).toContain(`href="/gallery/${listedSlug}/"`);
    expect(list).toContain(`/gallery/${listedSlug}/p/${listed.pictureId}.png`);
    expect(list).not.toContain(unlistedSlug);

    await addPicture(listed.id, listed.owner, listed.sceneId, 'A second harbor', 5);
    await service.refresh(listed.id);
    expect((await row(listed.id)).pictures).toBe(2);
    const relisted = await readFile(join(assetDir, 'galleries', 'index.html'), 'utf8');
    const card = relisted.slice(relisted.indexOf(`href="/gallery/${listedSlug}/"`));
    expect(card.slice(0, card.indexOf('</li>'))).toContain('2 pictures');
  });

  it('stores a failed write, still resolves, and clears the message on the next good write', async () => {
    const show = await newShow();
    await act(show, 'on');
    const { slug } = await row(show.id);
    await rm(folder(slug), { recursive: true, force: true });
    await writeFile(folder(slug), 'not a folder');
    await expect(service.refresh(show.id)).resolves.toBeUndefined();
    const failed = await row(show.id);
    expect(failed.message).toMatch(/^The gallery could not be written: /);
    expect(failed.message.length).toBeLessThanOrEqual(300);
    await rm(folder(slug), { force: true });
    await act(show, 'rewrite');
    const fixed = await row(show.id);
    expect(fixed.message).toBeNull();
    expect(existsSync(join(folder(slug), 'index.html'))).toBe(true);
  });

  it('runs exactly twice when three refreshes are asked for during one slow run', async () => {
    const show = await newShow();
    await apply(show, 'on');
    const before = control.runs;
    const release = hold();
    const started = nextRun();
    const first = service.refresh(show.id);
    await started;
    const second = service.refresh(show.id);
    const third = service.refresh(show.id);
    const fourth = service.refresh(show.id);
    expect(second).toBe(third);
    expect(third).toBe(fourth);
    release();
    await Promise.all([first, second, third, fourth]);
    expect(control.runs - before).toBe(2);
    expect((await row(show.id)).written_at).toBeInstanceOf(Date);
  });

  it('removes the folder when off is issued during a slow refresh', async () => {
    const show = await newShow();
    await act(show, 'on');
    const { slug } = await row(show.id);
    const release = hold();
    const started = nextRun();
    const refreshing = service.refresh(show.id);
    await started;
    const work = await apply(show, 'off');
    expect(work).toEqual({ kind: 'remove', slug });
    const removing = service.afterCommit(show.id, work);
    release();
    await Promise.all([refreshing, removing]);
    expect(existsSync(folder(slug))).toBe(false);
    expect(await row(show.id)).toBeUndefined();
  });

  it('writes the new folder and removes the old one on new_link', async () => {
    const show = await newShow();
    await act(show, 'on');
    const oldSlug = (await row(show.id)).slug;
    expect(existsSync(join(folder(oldSlug), 'index.html'))).toBe(true);
    const release = hold();
    const started = nextRun();
    const refreshing = service.refresh(show.id);
    await started;
    const work = await apply(show, 'new_link');
    expect(work).toEqual({ kind: 'replace', oldSlug });
    const replacing = service.afterCommit(show.id, work);
    release();
    await Promise.all([refreshing, replacing]);
    const fresh = await row(show.id);
    expect(fresh.slug).not.toBe(oldSlug);
    expect(existsSync(join(folder(fresh.slug), 'index.html'))).toBe(true);
    expect(existsSync(join(folder(fresh.slug), 'p', `${show.pictureId}.png`))).toBe(true);
    expect(existsSync(folder(oldSlug))).toBe(false);
    expect(fresh.written_at).toBeInstanceOf(Date);
  });

  it('refreshIfOn ignores a show that has not ended or has no gallery row', async () => {
    const live = await newShow('live');
    const liveSlug = newGallerySlug();
    await pool.query('INSERT INTO galleries(session_id, slug) VALUES($1,$2)', [live.id, liveSlug]);
    const off = await newShow();
    const before = control.runs;
    await service.refreshIfOn(live.id);
    await service.refreshIfOn(off.id);
    await service.refreshIfOn(`missing-${randomUUID()}`);
    expect(control.runs).toBe(before);
    expect(existsSync(folder(liveSlug))).toBe(false);
    expect((await row(live.id)).written_at).toBeNull();

    await apply(off, 'on');
    await service.refreshIfOn(off.id);
    expect(control.runs).toBe(before + 1);
    expect((await row(off.id)).written_at).toBeInstanceOf(Date);
  });

  it('start writes the shared files and the public list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gallery-refresh-start-'));
    extraDirs.push(dir);
    const starter = new GalleryService({ pool, assetDir: dir, origin });
    expect(existsSync(join(dir, 'galleries'))).toBe(false);
    await expect(starter.start()).resolves.toBeUndefined();
    for (const name of ['gallery.css', 'viewer.js', 'missing.html', 'index.html']) expect(existsSync(join(dir, 'galleries', name)), name).toBe(true);
    expect(await readFile(join(dir, 'galleries', 'index.html'), 'utf8')).toContain('Story Table galleries');
    await starter.close();
  });

  it('start never throws when the folder cannot be made', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gallery-refresh-blocked-'));
    extraDirs.push(dir);
    await writeFile(join(dir, 'galleries'), 'not a folder');
    const blocked = new GalleryService({ pool, assetDir: dir, origin });
    await expect(blocked.start()).resolves.toBeUndefined();
    await blocked.close();
  });

  it('does nothing after close', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gallery-refresh-closed-'));
    extraDirs.push(dir);
    const closing = new GalleryService({ pool, assetDir: dir, origin });
    const show = await newShow();
    await apply(show, 'on', closing);
    await closing.close();
    const before = control.runs;
    await closing.refresh(show.id);
    await closing.refreshIfOn(show.id);
    await closing.afterCommit(show.id, { kind: 'refresh' });
    await closing.afterCommit(show.id, { kind: 'list' });
    await closing.start();
    expect(control.runs).toBe(before);
    expect(existsSync(join(dir, 'galleries'))).toBe(false);
    expect((await row(show.id)).written_at).toBeNull();
  });

  it('holds no database client while gallery files are written', async () => {
    const show = await newShow();
    await apply(show, 'on');
    const release = hold();
    const started = nextRun();
    const refreshing = service.refresh(show.id);
    await started;
    expect(pool.totalCount - pool.idleCount).toBe(0);
    release();
    await refreshing;
  });

  it('makes the gallery root again after a failed attempt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gallery-refresh-retry-'));
    extraDirs.push(dir);
    await writeFile(join(dir, 'galleries'), 'not a folder');
    const retrying = new GalleryService({ pool, assetDir: dir, origin });
    const show = await newShow();
    await act(show, 'on', retrying);
    expect((await row(show.id)).message).toMatch(/^The gallery could not be written: /);
    await rm(join(dir, 'galleries'), { force: true });
    await act(show, 'rewrite', retrying);
    expect(existsSync(join(dir, 'galleries', 'gallery.css'))).toBe(true);
    expect((await row(show.id)).message).toBeNull();
    await retrying.close();
  });
});
