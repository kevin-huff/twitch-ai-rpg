import { randomBytes, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { GalleryAction, GalleryStatus } from '@rpg/contracts';
import { recordEvent } from './commands';
import { transaction } from './database';
import {
  ensureGalleryRoot, listGallerySlugFolders, readGalleryPageVersion, removeGalleryFolder, removeOrphanGalleryFolders, removeStaleTempFiles,
  writeGalleryFolder, writeGalleryList, writeGalleryPageVersion,
} from './gallery-files';
import { GALLERY_PAGE_VERSION, galleryListPage, galleryPage } from './gallery-html';
import { galleryPictures, onlyPlaced, type GalleryListEntry, type GalleryView, type GalleryWork } from './gallery-model';
import { GalleryQueue } from './gallery-queue';
import { loadGalleryView } from './gallery-view';
import { AppError, type Actor } from './repository';

export interface GalleryServiceOptions { pool: Pool; assetDir: string; origin: string; timeZone?: string }

export const GALLERY_MESSAGES = {
  notEnded: 'The gallery opens once the show has ended.',
  off: 'The gallery is off. Turn it on first.',
} as const;

const trimOrigin = (origin: string) => origin.replace(/\/+$/, '');

export function newGallerySlug(): string {
  return randomBytes(32).toString('base64url');
}

export function galleryUrl(origin: string, slug: string): string {
  return `${trimOrigin(origin)}/gallery/${slug}/`;
}

export function galleryListUrl(origin: string): string {
  return `${trimOrigin(origin)}/gallery/`;
}

export function isLocalOrigin(origin: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return true;
  }
  return hostname === 'localhost' || hostname.startsWith('127.') || hostname === '0.0.0.0' || hostname === '[::1]';
}

const EVENT_KINDS: Record<GalleryAction['action'], string> = {
  on: 'gallery.on',
  off: 'gallery.off',
  new_link: 'gallery.new_link',
  list: 'gallery.listed',
  unlist: 'gallery.unlisted',
  rewrite: 'gallery.rewritten',
};

const CLOSE_WAIT_MS = 10_000;
const LIST_KEY = '*list';
const READ_ONLY = 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY';

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

export function failureMessage(error: unknown): string {
  const code = errorCode(error);
  let reason: string;
  if (code === 'ENOSPC') reason = "the server's disk is full.";
  else if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') reason = "the server isn't allowed to write to its picture folder.";
  else reason = code ? `something went wrong on the server (${code}).` : 'something went wrong on the server.';
  return `The gallery could not be written: ${reason}`.slice(0, 300);
}

async function placedIds(assetDir: string, slug: string): Promise<Set<string>> {
  try {
    const names = await readdir(join(assetDir, 'galleries', slug, 'p'));
    return new Set(names.map(name => name.slice(0, name.length - extname(name).length)));
  } catch {
    return new Set();
  }
}

export class GalleryService {
  protected readonly pool: Pool;
  protected readonly assetDir: string;
  protected readonly origin: string;
  protected readonly timeZone: string | undefined;
  private readonly queue = new GalleryQueue();
  private closed = false;
  private rootReady: Promise<void> | null = null;

  constructor(options: GalleryServiceOptions) {
    this.pool = options.pool;
    this.assetDir = options.assetDir;
    this.origin = options.origin;
    this.timeZone = options.timeZone;
  }

  async status(client: PoolClient, sessionId: string, sessionStatus: string): Promise<GalleryStatus> {
    const row = (await client.query<{ slug: string; listed: boolean; pictures: number; message: string | null; written_at: Date | null }>(
      'SELECT slug, listed, pictures, message, written_at FROM galleries WHERE session_id=$1', [sessionId])).rows[0];
    const pending = Number((await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM images WHERE session_id=$1 AND status='making' AND purpose IN ('scene','npc')`, [sessionId])).rows[0]!.count);
    const state = sessionStatus !== 'ended' ? 'closed' : row ? 'on' : 'off';
    return {
      state,
      listed: row?.listed ?? false,
      url: state === 'on' ? galleryUrl(this.origin, row!.slug) : null,
      listUrl: galleryListUrl(this.origin),
      pictures: row?.pictures ?? 0,
      pending,
      writtenAt: row?.written_at ? new Date(row.written_at).toISOString() : null,
      message: row?.message ?? null,
      local: isLocalOrigin(this.origin),
    };
  }

  async apply(client: PoolClient, actor: Actor, sessionId: string, action: GalleryAction['action']): Promise<GalleryWork> {
    const session = (await client.query<{ status: string; version: number }>('SELECT status, version FROM sessions WHERE id=$1', [sessionId])).rows[0];
    if (!session) throw new AppError(404, 'not_found', 'Session was not found.');
    const off = (): never => { throw new AppError(409, 'conflict', GALLERY_MESSAGES.off); };
    const record = () => recordEvent(client, sessionId, actor, randomUUID(), EVENT_KINDS[action], session.version, {});

    if (action === 'on') {
      if (session.status !== 'ended') throw new AppError(409, 'conflict', GALLERY_MESSAGES.notEnded);
      await client.query('INSERT INTO galleries(session_id, slug) VALUES($1,$2) ON CONFLICT (session_id) DO NOTHING', [sessionId, newGallerySlug()]);
      await record();
      return { kind: 'refresh' };
    }
    if (action === 'off') {
      const removed = await client.query<{ slug: string }>('DELETE FROM galleries WHERE session_id=$1 RETURNING slug', [sessionId]);
      if (!removed.rowCount) return off();
      await record();
      return { kind: 'remove', slug: removed.rows[0]!.slug };
    }
    if (action === 'new_link') {
      const previous = (await client.query<{ slug: string }>('SELECT slug FROM galleries WHERE session_id=$1 FOR UPDATE', [sessionId])).rows[0];
      if (!previous) return off();
      await client.query('UPDATE galleries SET slug=$2, written_at=NULL, message=NULL WHERE session_id=$1', [sessionId, newGallerySlug()]);
      await record();
      return { kind: 'replace', oldSlug: previous.slug };
    }
    if (action === 'list' || action === 'unlist') {
      const updated = await client.query('UPDATE galleries SET listed=$2 WHERE session_id=$1', [sessionId, action === 'list']);
      if (!updated.rowCount) return off();
      await record();
      return { kind: 'list' };
    }
    const exists = await client.query('SELECT 1 FROM galleries WHERE session_id=$1', [sessionId]);
    if (!exists.rowCount) return off();
    await record();
    return { kind: 'refresh' };
  }

  async start(): Promise<void> {
    if (this.closed) return;
    try { await this.ensureRoot(); } catch { return; }
    const sessionIds: string[] = [];
    let redesigned = false;
    try {
      // Listing the folders before reading the rows keeps a gallery turned on during the sweep from being swept.
      const candidates = await listGallerySlugFolders(this.assetDir);
      const rows = (await this.pool.query<{ session_id: string; slug: string; written_at: Date | null; message: string | null }>(
        'SELECT session_id, slug, written_at, message FROM galleries')).rows;
      await removeOrphanGalleryFolders(this.assetDir, candidates, new Set(rows.map(row => row.slug)));
      await removeStaleTempFiles(this.assetDir);
      // Rewrite a gallery the server stopped in the middle of writing, and, once after the page design changes, every gallery in this folder.
      // A finished gallery with no folder here is left alone, so an app on another asset folder never rewrites it from its own picture store.
      redesigned = await readGalleryPageVersion(this.assetDir) !== GALLERY_PAGE_VERSION;
      const here = new Set(candidates);
      for (const row of rows) {
        if ((row.written_at === null && row.message === null) || (redesigned && here.has(row.slug))) sessionIds.push(row.session_id);
      }
    } catch {
      // A failed sweep leaves the folders for the next start.
    }
    const rewrites = sessionIds.map(sessionId => this.refresh(sessionId));
    // Rewrites cut short by close() leave the old version in place, so the next start tries again.
    if (redesigned) {
      void Promise.all(rewrites).then(() => (this.closed ? undefined : writeGalleryPageVersion(this.assetDir, GALLERY_PAGE_VERSION))).catch(() => {});
    }
    await this.rewriteList();
  }

  refresh(sessionId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.queue.coalesce(sessionId, () => this.writeShow(sessionId));
  }

  async refreshIfOn(sessionId: string): Promise<void> {
    if (this.closed) return;
    try {
      const row = (await this.pool.query<{ status: string }>(
        'SELECT s.status FROM sessions s JOIN galleries g ON g.session_id = s.id WHERE s.id=$1', [sessionId])).rows[0];
      if (row?.status === 'ended') await this.refresh(sessionId);
    } catch {
      // The next action or finished picture tries again.
    }
  }

  async afterCommit(sessionId: string, work: GalleryWork): Promise<void> {
    if (this.closed) return;
    try {
      if (work.kind === 'refresh') await this.refresh(sessionId);
      else if (work.kind === 'list') await this.rewriteList();
      else if (work.kind === 'remove') {
        await this.queue.run(sessionId, () => this.removeFolder(work.slug));
        await this.rewriteList();
      } else {
        await this.refresh(sessionId);
        await this.queue.run(sessionId, () => this.removeFolder(work.oldSlug));
      }
    } catch {
      // Queue promises never reject; nothing reaches the caller.
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>(resolve => { timer = setTimeout(resolve, CLOSE_WAIT_MS); timer.unref?.(); });
    await Promise.race([this.queue.idle(), limit]);
    clearTimeout(timer);
  }

  private ensureRoot(): Promise<void> {
    if (!this.rootReady) {
      this.rootReady = ensureGalleryRoot(this.assetDir).catch((error: unknown) => {
        this.rootReady = null;
        throw error;
      });
    }
    return this.rootReady;
  }

  private async removeFolder(slug: string): Promise<void> {
    await removeGalleryFolder(this.assetDir, slug);
  }

  private async writeShow(sessionId: string): Promise<void> {
    if (this.closed) return;
    let outcome: { pictures: number; failed: boolean } | null = null;
    try {
      await this.ensureRoot();
      const read = await transaction(this.pool, async client => {
        await client.query(READ_ONLY);
        const row = (await client.query<{ slug: string }>('SELECT slug FROM galleries WHERE session_id=$1', [sessionId])).rows[0];
        if (!row) return null;
        return { slug: row.slug, view: await loadGalleryView(client, sessionId) };
      });
      if (!read) return;
      const { slug, view } = read;
      const placed = await writeGalleryFolder(this.assetDir, slug, galleryPictures(view),
        pictures => galleryPage(onlyPlaced(view, new Set(pictures.map(picture => picture.id))), { origin: this.origin, slug, timeZone: this.timeZone }));
      const updated = await this.pool.query<{ pictures: number }>(
        'UPDATE galleries SET pictures=$3, written_at=clock_timestamp(), message=NULL WHERE session_id=$1 AND slug=$2 RETURNING pictures',
        [sessionId, slug, placed.length]);
      if (updated.rowCount) outcome = { pictures: updated.rows[0]!.pictures, failed: false };
    } catch (error) {
      const updated = await this.pool.query<{ pictures: number }>(
        'UPDATE galleries SET message=$2 WHERE session_id=$1 RETURNING pictures', [sessionId, failureMessage(error)]).catch(() => null);
      if (updated?.rowCount) outcome = { pictures: updated.rows[0]!.pictures, failed: true };
    }
    if (outcome) await this.recordWritten(sessionId, outcome);
    await this.rewriteList();
  }

  private async recordWritten(sessionId: string, data: { pictures: number; failed: boolean }): Promise<void> {
    try {
      await transaction(this.pool, async client => {
        const session = (await client.query<{ owner_id: string; version: number }>(
          'SELECT owner_id, version FROM sessions WHERE id=$1 FOR UPDATE', [sessionId])).rows[0];
        if (!session) return;
        await recordEvent(client, sessionId, session.owner_id, randomUUID(), 'gallery.written', session.version, data);
      });
    } catch {
      // The write itself already happened; a missing event never fails it.
    }
  }

  private rewriteList(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.queue.coalesce(LIST_KEY, () => this.writeList());
  }

  private async writeList(): Promise<void> {
    if (this.closed) return;
    try {
      await this.ensureRoot();
      const rows = (await this.pool.query<{ session_id: string; slug: string; pictures: number }>(
        'SELECT session_id, slug, pictures FROM galleries WHERE listed AND written_at IS NOT NULL')).rows;
      const entries: GalleryListEntry[] = [];
      for (const row of rows) {
        let view: GalleryView;
        try {
          view = await transaction(this.pool, async client => {
            await client.query(READ_ONLY);
            return loadGalleryView(client, row.session_id);
          });
        } catch {
          continue;
        }
        const cover = onlyPlaced(view, await placedIds(this.assetDir, row.slug)).cover;
        entries.push({ slug: row.slug, title: view.title, endedAt: view.endedAt, pictures: row.pictures, cover });
      }
      await writeGalleryList(this.assetDir, galleryListPage(entries, { origin: this.origin, timeZone: this.timeZone }));
    } catch {
      // A failed list write leaves the previous list in place; the next change rewrites it.
    }
  }
}
