import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageContentType } from '@rpg/contracts';
import { fakeImageBytes } from '../src/fake-images';
import { storeImage } from '../src/image-files';
import { GALLERY_CSS, GALLERY_SCRIPT, galleryMissingPage } from '../src/gallery-html';
import {
  ensureGalleryRoot, listGallerySlugFolders, readGalleryPageVersion, removeGalleryFolder, removeOrphanGalleryFolders, removeStaleTempFiles,
  writeGalleryFolder, writeGalleryList, writeGalleryPageVersion, type GalleryFileSource,
} from '../src/gallery-files';

const SLUG = 'A'.repeat(43);
const OTHER_SLUG = 'B'.repeat(43);

describe('gallery files', () => {
  let assetDir: string;
  beforeEach(async () => { assetDir = await mkdtemp(join(tmpdir(), 'gallery-files-')); });
  afterEach(async () => { await rm(assetDir, { recursive: true, force: true }); });

  const root = () => join(assetDir, 'galleries');
  const exists = (path: string) => stat(path).then(() => true, () => false);
  const dotFiles = async (directory: string) => (await readdir(directory, { recursive: true })).filter(name => name.split('/').some(part => part.startsWith('.')));

  async function picture(id: string, prompt = id, extra: Partial<GalleryFileSource> = {}): Promise<GalleryFileSource> {
    const stored = await storeImage(assetDir, fakeImageBytes({ prompt, width: 64, height: 64 }));
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[stored.contentType as ImageContentType];
    return { id, file: `${id}.${ext}`, fileHash: stored.fileHash, contentType: stored.contentType, ...extra };
  }
  const failWith = (code: string) => async () => { throw Object.assign(new Error(code), { code }); };

  it('writes the root files with the right content and leaves no dot files', async () => {
    await ensureGalleryRoot(assetDir);
    expect(await readFile(join(root(), 'gallery.css'), 'utf8')).toBe(GALLERY_CSS);
    expect(await readFile(join(root(), 'viewer.js'), 'utf8')).toBe(GALLERY_SCRIPT);
    expect(await readFile(join(root(), 'missing.html'), 'utf8')).toBe(galleryMissingPage());
    expect(await dotFiles(root())).toEqual([]);
    await ensureGalleryRoot(assetDir);
    expect((await readdir(root())).sort()).toEqual(['gallery.css', 'missing.html', 'viewer.js']);
  });

  it('shares the store file inode by default', async () => {
    const pic = await picture('one');
    const placed = await writeGalleryFolder(assetDir, SLUG, [pic], () => '<p>x</p>');
    expect(placed).toEqual([pic]);
    const stored = await stat(join(assetDir, 'images', `${pic.fileHash}.${pic.file.split('.')[1]}`));
    const shared = await stat(join(root(), SLUG, 'p', pic.file));
    expect(shared.ino).toBe(stored.ino);
    expect(shared.dev).toBe(stored.dev);
  });

  it.each(['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK'])('copies the picture when linking fails with %s', async (code) => {
    const pic = await picture('copy');
    const placed = await writeGalleryFolder(assetDir, SLUG, [pic], () => 'page', failWith(code));
    expect(placed).toEqual([pic]);
    const target = join(root(), SLUG, 'p', pic.file);
    const stored = join(assetDir, 'images', `${pic.fileHash}.${pic.file.split('.')[1]}`);
    expect(Buffer.compare(await readFile(target), await readFile(stored))).toBe(0);
    expect((await stat(target)).ino).not.toBe((await stat(stored)).ino);
    expect(await dotFiles(root())).toEqual([]);
  });

  it('propagates other link errors', async () => {
    const pic = await picture('denied');
    await expect(writeGalleryFolder(assetDir, SLUG, [pic], () => 'page', failWith('EACCES'))).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('skips a missing source and leaves it out of render', async () => {
    const pic = await picture('here');
    const missing: GalleryFileSource = { id: 'gone', file: 'gone.jpg', fileHash: 'f'.repeat(64), contentType: 'image/jpeg' };
    let seen: GalleryFileSource[] = [];
    const placed = await writeGalleryFolder(assetDir, SLUG, [missing, pic], (list) => { seen = list; return 'page'; });
    expect(placed).toEqual([pic]);
    expect(seen).toEqual([pic]);
    expect(await readdir(join(root(), SLUG, 'p'))).toEqual([pic.file]);
  });

  it('skips a missing source when copying too', async () => {
    const missing: GalleryFileSource = { id: 'gone', file: 'gone.png', fileHash: 'e'.repeat(64), contentType: 'image/png' };
    const placed = await writeGalleryFolder(assetDir, SLUG, [missing], () => 'page', failWith('EXDEV'));
    expect(placed).toEqual([]);
    expect(await dotFiles(root())).toEqual([]);
  });

  it('writes the rendered page and replaces the old one without temp files', async () => {
    const pic = await picture('page');
    await writeGalleryFolder(assetDir, SLUG, [pic], () => '<p>first</p>');
    await writeGalleryFolder(assetDir, SLUG, [pic], () => '<p>second</p>');
    expect(await readFile(join(root(), SLUG, 'index.html'), 'utf8')).toBe('<p>second</p>');
    expect(await dotFiles(root())).toEqual([]);
  });

  it('removes unused files from p/ on a later write', async () => {
    const a = await picture('a', 'prompt a');
    const b = await picture('b', 'prompt b');
    await writeGalleryFolder(assetDir, SLUG, [a, b], () => 'page');
    await writeFile(join(root(), SLUG, 'p', '.stale.tmp'), 'x');
    await writeGalleryFolder(assetDir, SLUG, [a], () => 'page');
    expect(await readdir(join(root(), SLUG, 'p'), { })).toEqual([a.file]);
  });

  it('keeps an already placed file', async () => {
    const pic = await picture('kept');
    await writeGalleryFolder(assetDir, SLUG, [pic], () => 'page');
    const before = await stat(join(root(), SLUG, 'p', pic.file));
    let calls = 0;
    const placed = await writeGalleryFolder(assetDir, SLUG, [pic], () => 'page', async () => { calls += 1; });
    expect(placed).toEqual([pic]);
    expect(calls).toBe(0);
    expect((await stat(join(root(), SLUG, 'p', pic.file))).ino).toBe(before.ino);
  });

  it('skips a bad file name', async () => {
    const good = await picture('good');
    const bad = { ...good, id: 'bad', file: '../escape.jpg' };
    const dotted = { ...good, id: 'dot', file: '.hidden.jpg' };
    const wrongType = { ...good, id: 'txt', file: 'x.gif' };
    const placed = await writeGalleryFolder(assetDir, SLUG, [bad, dotted, wrongType, good], () => 'page');
    expect(placed).toEqual([good]);
    expect(await readdir(join(root(), SLUG, 'p'))).toEqual([good.file]);
    expect(await exists(join(root(), SLUG, 'escape.jpg'))).toBe(false);
  });

  it.each(['../x', '', 'C'.repeat(42)])('refuses the slug %j before touching the disk', async (slug) => {
    await expect(writeGalleryFolder(assetDir, slug, [], () => 'page')).rejects.toThrow();
    await expect(removeGalleryFolder(assetDir, slug)).rejects.toThrow();
    expect(await exists(root())).toBe(false);
    expect(await exists(join(assetDir, 'x'))).toBe(false);
  });

  it('removes a gallery folder and leaves the others', async () => {
    const pic = await picture('rm');
    await writeGalleryFolder(assetDir, SLUG, [pic], () => 'a');
    await writeGalleryFolder(assetDir, OTHER_SLUG, [pic], () => 'b');
    await removeGalleryFolder(assetDir, SLUG);
    expect(await exists(join(root(), SLUG))).toBe(false);
    expect(await readFile(join(root(), OTHER_SLUG, 'index.html'), 'utf8')).toBe('b');
    await removeGalleryFolder(assetDir, SLUG);
    expect(await exists(join(assetDir, 'images', `${pic.fileHash}.${pic.file.split('.')[1]}`))).toBe(true);
  });

  it('writes the public list at galleries/index.html', async () => {
    await writeGalleryList(assetDir, '<p>list one</p>');
    await writeGalleryList(assetDir, '<p>list two</p>');
    expect(await readFile(join(root(), 'index.html'), 'utf8')).toBe('<p>list two</p>');
    expect(await dotFiles(root())).toEqual([]);
  });

  it('reads back the page version it wrote, and null when there is none or it is unreadable', async () => {
    expect(await readGalleryPageVersion(assetDir)).toBeNull();
    await writeGalleryPageVersion(assetDir, 3);
    expect(await readGalleryPageVersion(assetDir)).toBe(3);
    expect(await readFile(join(root(), '.page-version'), 'utf8')).toBe('3\n');
    await writeFile(join(root(), '.page-version'), 'not a number');
    expect(await readGalleryPageVersion(assetDir)).toBeNull();
  });

  describe('sweep helpers', () => {
    const ROOT_FILES = ['index.html', 'gallery.css', 'viewer.js', 'missing.html'];
    const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
    const age = async (path: string, ms: number) => { const when = new Date(NOW - ms); await utimes(path, when, when); };

    async function seedRoot() {
      await mkdir(root(), { recursive: true });
      for (const name of ROOT_FILES) await writeFile(join(root(), name), name);
    }

    it('returns nothing and removes nothing when the root is missing', async () => {
      expect(await listGallerySlugFolders(assetDir)).toEqual([]);
      await removeOrphanGalleryFolders(assetDir, [SLUG], new Set());
      await removeStaleTempFiles(assetDir, 600_000, NOW);
      expect(await exists(root())).toBe(false);
    });

    it('lists only real slug folders', async () => {
      await seedRoot();
      await mkdir(join(root(), SLUG, 'p'), { recursive: true });
      await mkdir(join(root(), OTHER_SLUG));
      await mkdir(join(root(), 'not-a-slug'));
      await mkdir(join(root(), 'C'.repeat(42)));
      await writeFile(join(root(), 'D'.repeat(43)), 'a file named like a slug');
      expect(await listGallerySlugFolders(assetDir)).toEqual([SLUG, OTHER_SLUG].sort());
    });

    it('removes an orphan slug folder and keeps a live one', async () => {
      await seedRoot();
      await mkdir(join(root(), SLUG, 'p'), { recursive: true });
      await writeFile(join(root(), SLUG, 'index.html'), 'orphan');
      await mkdir(join(root(), OTHER_SLUG, 'p'), { recursive: true });
      await writeFile(join(root(), OTHER_SLUG, 'index.html'), 'live');
      await removeOrphanGalleryFolders(assetDir, await listGallerySlugFolders(assetDir), new Set([OTHER_SLUG]));
      expect(await exists(join(root(), SLUG))).toBe(false);
      expect(await readFile(join(root(), OTHER_SLUG, 'index.html'), 'utf8')).toBe('live');
    });

    it('keeps non-slug names and the four root files even when they are passed as candidates', async () => {
      await seedRoot();
      await mkdir(join(root(), 'not-a-slug'));
      await mkdir(join(root(), 'C'.repeat(42)));
      await removeOrphanGalleryFolders(assetDir, [...ROOT_FILES, 'not-a-slug', 'C'.repeat(42), '..', '../x', ''], new Set());
      for (const name of ROOT_FILES) expect(await readFile(join(root(), name), 'utf8')).toBe(name);
      expect(await exists(join(root(), 'not-a-slug'))).toBe(true);
      expect(await exists(join(root(), 'C'.repeat(42)))).toBe(true);
      expect(await exists(assetDir)).toBe(true);
    });

    it('skips a candidate that is a file or no longer exists', async () => {
      await seedRoot();
      await writeFile(join(root(), SLUG), 'a file named like a slug');
      await removeOrphanGalleryFolders(assetDir, [SLUG, OTHER_SLUG], new Set());
      expect(await readFile(join(root(), SLUG), 'utf8')).toBe('a file named like a slug');
    });

    it('removes temp files older than ten minutes at the root, in a slug folder and in its p folder', async () => {
      await seedRoot();
      const folder = join(root(), SLUG);
      const pictures = join(folder, 'p');
      await mkdir(pictures, { recursive: true });
      const stale = [join(root(), '.index.html.1.tmp'), join(folder, '.index.html.2.tmp'), join(pictures, '.3.tmp')];
      const fresh = [join(root(), '.fresh.tmp'), join(folder, '.fresh.tmp'), join(pictures, '.fresh.tmp')];
      const kept = [join(root(), 'old.tmp'), join(folder, '.old.txt'), join(pictures, 'old.tmp'), join(pictures, 'a.jpg')];
      for (const path of [...stale, ...fresh, ...kept]) await writeFile(path, 'x');
      for (const path of [...stale, ...kept]) await age(path, 600_001);
      for (const path of fresh) await age(path, 599_000);
      for (const name of ROOT_FILES) await age(join(root(), name), 3_600_000);
      await mkdir(join(root(), '.dir.tmp'));
      await age(join(root(), '.dir.tmp'), 3_600_000);
      await removeStaleTempFiles(assetDir, 600_000, NOW);
      for (const path of stale) expect(await exists(path)).toBe(false);
      for (const path of [...fresh, ...kept]) expect(await exists(path)).toBe(true);
      for (const name of ROOT_FILES) expect(await exists(join(root(), name))).toBe(true);
      expect(await exists(join(root(), '.dir.tmp'))).toBe(true);
    });

    it('decides temp-file age from the now and olderThanMs arguments', async () => {
      await mkdir(root(), { recursive: true });
      const path = join(root(), '.page.tmp');
      await writeFile(path, 'x');
      await age(path, 5_000);
      await removeStaleTempFiles(assetDir, 10_000, NOW);
      expect(await exists(path)).toBe(true);
      await removeStaleTempFiles(assetDir, 10_000, NOW + 6_000);
      expect(await exists(path)).toBe(false);
    });

    it('never lists, removes or sweeps through a symlink named like a slug', async () => {
      await seedRoot();
      const outside = await mkdtemp(join(tmpdir(), 'gallery-files-outside-'));
      try {
        await mkdir(join(outside, 'p'));
        await writeFile(join(outside, 'index.html'), 'outside');
        await writeFile(join(outside, '.old.tmp'), 'x');
        await writeFile(join(outside, 'p', '.old.tmp'), 'x');
        await age(join(outside, '.old.tmp'), 3_600_000);
        await age(join(outside, 'p', '.old.tmp'), 3_600_000);
        const linkSlug = 'L'.repeat(43);
        const link = join(root(), linkSlug);
        await symlink(outside, link, 'dir');
        expect(await listGallerySlugFolders(assetDir)).toEqual([]);
        await removeOrphanGalleryFolders(assetDir, [linkSlug], new Set());
        await removeStaleTempFiles(assetDir, 600_000, NOW);
        expect((await lstat(link)).isSymbolicLink()).toBe(true);
        expect(await readFile(join(outside, 'index.html'), 'utf8')).toBe('outside');
        expect(await exists(join(outside, '.old.tmp'))).toBe(true);
        expect(await exists(join(outside, 'p', '.old.tmp'))).toBe(true);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('does not remove a temp-named symlink or sweep a symlinked p folder', async () => {
      await seedRoot();
      const outside = await mkdtemp(join(tmpdir(), 'gallery-files-outside-'));
      try {
        const target = join(outside, '.target.tmp');
        await writeFile(target, 'x');
        await age(target, 3_600_000);
        await mkdir(join(root(), SLUG));
        await symlink(outside, join(root(), SLUG, 'p'), 'dir');
        await symlink(target, join(root(), '.link.tmp'));
        await removeStaleTempFiles(assetDir, 600_000, NOW);
        expect((await lstat(join(root(), '.link.tmp'))).isSymbolicLink()).toBe(true);
        expect(await exists(target)).toBe(true);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});
