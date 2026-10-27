import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { GallerySlugSchema, type GalleryAction } from '@rpg/contracts';
import { createPool, migrate, transaction } from '../src/database';
import { GALLERY_MESSAGES, GalleryService, galleryListUrl, galleryUrl, isLocalOrigin, newGallerySlug } from '../src/galleries';
import type { Actor } from '../src/repository';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'https://stories.example.com';

describe('gallery link helpers', () => {
  it('makes valid, distinct slugs', () => {
    const a = newGallerySlug(), b = newGallerySlug();
    expect(GallerySlugSchema.safeParse(a).success).toBe(true);
    expect(a).not.toBe(b);
  });
  it('builds links with or without a trailing slash on the origin', () => {
    expect(galleryUrl('https://x.test/', 'abc')).toBe('https://x.test/gallery/abc/');
    expect(galleryUrl('https://x.test', 'abc')).toBe('https://x.test/gallery/abc/');
    expect(galleryListUrl('https://x.test/')).toBe('https://x.test/gallery/');
  });
  it('spots local origins', () => {
    for (const local of ['http://localhost:3000', 'http://127.0.0.1:3100', 'http://0.0.0.0:3000', 'http://[::1]:3000', 'not a url']) expect(isLocalOrigin(local), local).toBe(true);
    for (const remote of ['https://example.com', 'https://stories.example.com:8443']) expect(isLocalOrigin(remote), remote).toBe(false);
  });
});

suite('gallery service actions and status', () => {
  let pool: ReturnType<typeof createPool>;
  let service: GalleryService;
  const sessionIds: string[] = [];

  async function newSession(status = 'ended') {
    const id = randomUUID();
    sessionIds.push(id);
    await pool.query(`INSERT INTO sessions(id,owner_id,title,scene,status) VALUES($1,$2,'Gallery actions','{}'::jsonb,$3)`, [id, 'owner-' + id, status]);
    return { id, actor: { actor_id: 'owner-' + id, role: 'host', session_id: null, character_id: null } as Actor };
  }
  const apply = (session: { id: string; actor: Actor }, action: GalleryAction['action']) =>
    transaction(pool, client => service.apply(client, session.actor, session.id, action));
  const row = async (id: string) => (await pool.query('SELECT * FROM galleries WHERE session_id=$1', [id])).rows[0];
  const status = (id: string, sessionStatus = 'ended') => transaction(pool, client => service.status(client, id, sessionStatus));
  const rejection = async (run: Promise<unknown>) => (await run.then(() => null, (error: unknown) => error)) as { status?: number; message?: string } | null;
  async function insertImage(sessionId: string, purpose: string, state: string) {
    const ready = state === 'ready';
    await pool.query(
      `INSERT INTO images(id,owner_id,session_id,purpose,subject_id,limit_key,status,prompt,width,height,provider,model,requested_by,file_hash,content_type,byte_length)
       VALUES($1,$2,$3,$4,'subject',$5,$6,'a picture',768,768,'fake','fake-image',$2,$7,$8,$9)`,
      [randomUUID(), 'owner-' + sessionId, sessionId, purpose, `gallery-actions:${randomUUID()}`, state, ready ? 'c'.repeat(64) : null, ready ? 'image/png' : null, ready ? 10 : null]);
  }

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    await migrate(pool);
    service = new GalleryService({ pool, assetDir: '/nonexistent-gallery-actions', origin });
  });
  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM outbox WHERE session_id = ANY($1::text[])', [sessionIds]);
    await pool.query('DELETE FROM audit_events WHERE session_id = ANY($1::text[])', [sessionIds]);
    await pool.query('DELETE FROM images WHERE session_id = ANY($1::text[])', [sessionIds]);
    await pool.query('DELETE FROM galleries WHERE session_id = ANY($1::text[])', [sessionIds]);
    await pool.query('DELETE FROM sessions WHERE id = ANY($1::text[])', [sessionIds]);
    await pool.end();
  });

  it('refuses on before the show has ended', async () => {
    const session = await newSession('live');
    const error = await rejection(apply(session, 'on'));
    expect(error).toMatchObject({ status: 409, message: GALLERY_MESSAGES.notEnded });
    expect(await row(session.id)).toBeUndefined();
    expect((await pool.query('SELECT 1 FROM audit_events WHERE session_id=$1', [session.id])).rowCount).toBe(0);
  });

  it('turns on after the end, and a second on keeps the slug', async () => {
    const session = await newSession();
    expect(await apply(session, 'on')).toEqual({ kind: 'refresh' });
    const first = await row(session.id);
    expect(GallerySlugSchema.safeParse(first.slug).success).toBe(true);
    expect(first).toMatchObject({ listed: false, pictures: 0, written_at: null, message: null });
    expect(await apply(session, 'on')).toEqual({ kind: 'refresh' });
    expect((await row(session.id)).slug).toBe(first.slug);
  });

  it('lists and unlists', async () => {
    const session = await newSession();
    await apply(session, 'on');
    expect(await apply(session, 'list')).toEqual({ kind: 'list' });
    expect((await row(session.id)).listed).toBe(true);
    expect(await apply(session, 'unlist')).toEqual({ kind: 'list' });
    expect((await row(session.id)).listed).toBe(false);
  });

  it('makes a new link, clearing the write state and returning the old slug', async () => {
    const session = await newSession();
    await apply(session, 'on');
    const before = await row(session.id);
    await pool.query(`UPDATE galleries SET written_at=now(), message='old trouble', listed=true, pictures=3 WHERE session_id=$1`, [session.id]);
    expect(await apply(session, 'new_link')).toEqual({ kind: 'replace', oldSlug: before.slug });
    const after = await row(session.id);
    expect(after.slug).not.toBe(before.slug);
    expect(GallerySlugSchema.safeParse(after.slug).success).toBe(true);
    expect(after).toMatchObject({ written_at: null, message: null, listed: true, pictures: 3 });
  });

  it('rewrites by asking for a refresh', async () => {
    const session = await newSession();
    await apply(session, 'on');
    expect(await apply(session, 'rewrite')).toEqual({ kind: 'refresh' });
  });

  it('turns off by deleting the row and returning its slug', async () => {
    const session = await newSession();
    await apply(session, 'on');
    const before = await row(session.id);
    expect(await apply(session, 'off')).toEqual({ kind: 'remove', slug: before.slug });
    expect(await row(session.id)).toBeUndefined();
  });

  it('refuses every action but on when the gallery is off', async () => {
    const session = await newSession();
    for (const action of ['off', 'new_link', 'list', 'unlist', 'rewrite'] as const) {
      expect(await rejection(apply(session, action)), action).toMatchObject({ status: 409, message: GALLERY_MESSAGES.off });
    }
    expect((await pool.query('SELECT 1 FROM audit_events WHERE session_id=$1', [session.id])).rowCount).toBe(0);
  });

  it('records one event per action, with an outbox row and no slug', async () => {
    const session = await newSession();
    const steps: Array<[GalleryAction['action'], string]> = [
      ['on', 'gallery.on'], ['list', 'gallery.listed'], ['unlist', 'gallery.unlisted'], ['rewrite', 'gallery.rewritten'], ['new_link', 'gallery.new_link'], ['off', 'gallery.off'],
    ];
    const slugs = new Set<string>();
    for (const [action, kind] of steps) {
      const current = await row(session.id);
      if (current) slugs.add(current.slug);
      const work = await apply(session, action);
      if (work.kind === 'remove') slugs.add(work.slug);
      if (work.kind === 'replace') slugs.add(work.oldSlug);
      const events = (await pool.query('SELECT * FROM audit_events WHERE session_id=$1 AND kind=$2', [session.id, kind])).rows;
      expect(events, kind).toHaveLength(1);
      expect(events[0]).toMatchObject({ actor_id: session.actor.actor_id, data: {} });
      expect((await pool.query('SELECT 1 FROM outbox WHERE event_id=$1', [events[0].id])).rowCount, kind).toBe(1);
    }
    const slugAfter = (await pool.query('SELECT 1 FROM audit_events WHERE session_id=$1', [session.id])).rowCount;
    expect(slugAfter).toBe(steps.length);
    const all = JSON.stringify((await pool.query('SELECT data FROM audit_events WHERE session_id=$1', [session.id])).rows);
    for (const slug of slugs) expect(all).not.toContain(slug);
  });

  it('keeps the producer grant on the event', async () => {
    const session = await newSession();
    const grantId = randomUUID();
    const owner = session.actor.actor_id;
    await pool.query(`INSERT INTO producer_grants(id,owner_id,label,token_hash,expires_at) VALUES($1,$2,'Gallery test',$3,now()+interval '1 hour')`, [grantId, owner, randomUUID()]);
    const actor = { ...session.actor, producer_grant_id: grantId };
    await transaction(pool, client => service.apply(client, actor, session.id, 'on'));
    const event = (await pool.query('SELECT producer_grant_id FROM audit_events WHERE session_id=$1', [session.id])).rows[0];
    expect(event.producer_grant_id).toBe(grantId);
    await pool.query('DELETE FROM outbox WHERE session_id=$1', [session.id]);
    await pool.query('DELETE FROM audit_events WHERE session_id=$1', [session.id]);
    await pool.query('DELETE FROM producer_grants WHERE id=$1', [grantId]);
  });

  describe('status', () => {
    it('is closed until the show ends, even with a row', async () => {
      const session = await newSession('live');
      expect(await status(session.id, 'live')).toMatchObject({ state: 'closed', url: null, listed: false, pictures: 0, writtenAt: null, message: null });
    });
    it('is off with no row, with the list link', async () => {
      const session = await newSession();
      expect(await status(session.id)).toEqual({
        state: 'off', listed: false, url: null, listUrl: 'https://stories.example.com/gallery/', pictures: 0, pending: 0, writtenAt: null, message: null, local: false,
      });
    });
    it('is on with the private link and the row fields', async () => {
      const session = await newSession();
      await apply(session, 'on');
      await apply(session, 'list');
      const stamp = new Date('2026-10-25T20:14:00.000Z');
      await pool.query(`UPDATE galleries SET pictures=7, written_at=$2, message='It broke' WHERE session_id=$1`, [session.id, stamp]);
      const slug = (await row(session.id)).slug;
      expect(await status(session.id)).toEqual({
        state: 'on', listed: true, url: `https://stories.example.com/gallery/${slug}/`, listUrl: 'https://stories.example.com/gallery/',
        pictures: 7, pending: 0, writtenAt: '2026-10-25T20:14:00.000Z', message: 'It broke', local: false,
      });
    });
    it('counts only making scene and npc pictures as pending', async () => {
      const session = await newSession();
      await insertImage(session.id, 'scene', 'making');
      await insertImage(session.id, 'scene', 'making');
      await insertImage(session.id, 'npc', 'making');
      await insertImage(session.id, 'scene', 'ready');
      await insertImage(session.id, 'scene', 'failed');
      await insertImage(session.id, 'scene', 'cancelled');
      await insertImage(session.id, 'character', 'making');
      const other = await newSession();
      await insertImage(other.id, 'scene', 'making');
      expect((await status(session.id)).pending).toBe(3);
    });
    it('marks local origins', async () => {
      const session = await newSession();
      for (const [url, local] of [['http://localhost:3000', true], ['http://127.0.0.1:3100', true], ['http://0.0.0.0:3000', true], ['https://example.com', false]] as const) {
        const local_ = new GalleryService({ pool, assetDir: '/nonexistent-gallery-actions', origin: url });
        const result = await transaction(pool, client => local_.status(client, session.id, 'ended'));
        expect(result.local, url).toBe(local);
        expect(result.listUrl).toBe(`${url}/gallery/`);
      }
    });
  });
});
