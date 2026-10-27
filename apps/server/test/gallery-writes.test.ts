import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rm, mkdtemp, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GalleryAction } from '@rpg/contracts';
import { createLedgerState } from '@rpg/test-fixtures';
import { createPool, migrate, transaction } from '../src/database';
import { fakeImageBytes } from '../src/fake-images';
import { GalleryService } from '../src/galleries';
import { storeImage } from '../src/image-files';
import { saveState, type Actor } from '../src/repository';

const control = vi.hoisted(() => ({ fail: false }));

vi.mock('../src/gallery-files', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/gallery-files')>();
  return {
    ...actual,
    writeGalleryFolder: (async (...args: Parameters<typeof actual.writeGalleryFolder>) => {
      if (control.fail) throw Object.assign(new Error('forced failure'), { code: 'ENOSPC' });
      return actual.writeGalleryFolder(...args);
    }) as typeof actual.writeGalleryFolder,
  };
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'https://stories.example.com';

suite('gallery write path', () => {
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  let service: GalleryService;
  const sessionIds: string[] = [];

  async function addPicture(sessionId: string, owner: string, sceneId: string, prompt: string, minute: number) {
    const stored = await storeImage(assetDir, fakeImageBytes({ prompt: `${prompt} for ${sessionId}`, width: 768, height: 512 }));
    const pictureId = randomUUID();
    await pool.query(
      `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, status, prompt, width, height, provider, model,
         requested_by, file_hash, content_type, byte_length, created_at)
       VALUES($1,$2,$3,'scene',$4,'gallery-writes-test','ready',$5,768,512,'fake','fake-image',$2,$6,$7,$8,$9)`,
      [pictureId, owner, sessionId, sceneId, prompt, stored.fileHash, stored.contentType, stored.byteLength, new Date(Date.UTC(2026, 9, 25, 2, minute))]);
    return pictureId;
  }

  async function newShow() {
    const id = `gallery-writes-${randomUUID()}`;
    const owner = `owner-${id}`;
    sessionIds.push(id);
    const state = createLedgerState(id, randomUUID);
    state.session.status = 'ended';
    state.session.title = `Writes show ${sessionIds.length}`;
    await pool.query('INSERT INTO sessions(id, owner_id, title, scene, status) VALUES($1,$2,$3,$4,$5)', [id, owner, state.session.title, state.session.scene, 'ended']);
    const client = await pool.connect();
    try { await saveState(client, state); } finally { client.release(); }
    const sceneId = state.session.scene.id;
    const firstId = await addPicture(id, owner, sceneId, 'A lantern-lit harbor', 0);
    return { id, owner, sceneId, firstId, actor: { actor_id: owner, role: 'host', session_id: null, character_id: null } as Actor };
  }

  const act = async (show: { id: string; actor: Actor }, action: GalleryAction['action']) => {
    const work = await transaction(pool, client => service.apply(client, show.actor, show.id, action));
    await service.afterCommit(show.id, work);
  };
  const row = async (id: string) => (await pool.query('SELECT * FROM galleries WHERE session_id=$1', [id])).rows[0];
  const writtenEvents = async (id: string) =>
    (await pool.query('SELECT id, actor_id, data FROM audit_events WHERE session_id=$1 AND kind=$2 ORDER BY sequence', [id, 'gallery.written'])).rows;
  const listPage = () => readFile(join(assetDir, 'galleries', 'index.html'), 'utf8');

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    await migrate(pool);
    assetDir = await mkdtemp(join(tmpdir(), 'gallery-writes-'));
    service = new GalleryService({ pool, assetDir, origin });
  });

  afterEach(() => { control.fail = false; });

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
    if (assetDir) await rm(assetDir, { recursive: true, force: true });
  });

  it('records a gallery.written event and outbox row for a late picture, and the snapshot status shows the new count', async () => {
    const show = await newShow();
    await act(show, 'on');
    const afterOn = await writtenEvents(show.id);
    expect(afterOn).toHaveLength(1);
    expect(afterOn[0]!.data).toEqual({ pictures: 1, failed: false });

    await addPicture(show.id, show.owner, show.sceneId, 'A late second harbor', 5);
    await service.refreshIfOn(show.id);

    const events = await writtenEvents(show.id);
    expect(events).toHaveLength(2);
    const latest = events[1]!;
    expect(latest.actor_id).toBe(show.owner);
    expect(latest.data).toEqual({ pictures: 2, failed: false });
    const outbox = await pool.query('SELECT revision FROM outbox WHERE event_id=$1', [latest.id]);
    expect(outbox.rowCount).toBe(1);

    const status = await transaction(pool, client => service.status(client, show.id, 'ended'));
    expect(status.pictures).toBe(2);
    expect(status.message).toBeNull();
  });

  it('records one failed event for a failed write and records nothing when there is no gallery row', async () => {
    const show = await newShow();
    await act(show, 'on');
    control.fail = true;
    await service.refresh(show.id);
    const events = await writtenEvents(show.id);
    expect(events).toHaveLength(2);
    expect(events[1]!.data).toEqual({ pictures: 1, failed: true });
    expect((await row(show.id)).message).toBe("The gallery could not be written: the server's disk is full.");

    const off = await newShow();
    await service.refresh(off.id);
    expect(await writtenEvents(off.id)).toHaveLength(0);
  });

  it('leaves the old link off the list after New link followed by a failed write', async () => {
    const show = await newShow();
    await act(show, 'on');
    await act(show, 'list');
    const oldSlug = (await row(show.id)).slug;
    expect(await listPage()).toContain(`href="/gallery/${oldSlug}/"`);

    control.fail = true;
    await act(show, 'new_link');
    const fresh = await row(show.id);
    expect(fresh.slug).not.toBe(oldSlug);
    expect(fresh.written_at).toBeNull();
    expect(fresh.message).toMatch(/^The gallery could not be written: /);
    const list = await listPage();
    expect(list).not.toContain(oldSlug);
    expect(list).not.toContain(fresh.slug);
  });

  it('uses the next placed picture as the list card cover when the first one is missing from p', async () => {
    const show = await newShow();
    const secondId = await addPicture(show.id, show.owner, show.sceneId, 'A second harbor', 5);
    await act(show, 'on');
    await act(show, 'list');
    const { slug } = await row(show.id);
    expect(await listPage()).toContain(`/gallery/${slug}/p/${show.firstId}.png`);

    await unlink(join(assetDir, 'galleries', slug, 'p', `${show.firstId}.png`));
    await act(show, 'list');
    const list = await listPage();
    const card = list.slice(list.indexOf(`href="/gallery/${slug}/"`));
    const cardHtml = card.slice(0, card.indexOf('</li>'));
    expect(cardHtml).toContain(`/gallery/${slug}/p/${secondId}.png`);
    expect(cardHtml).not.toContain(show.firstId);
  });
});
