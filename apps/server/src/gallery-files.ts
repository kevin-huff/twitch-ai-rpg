import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { GallerySlugSchema, type ImageContentType } from '@rpg/contracts';
import { GALLERY_CSS, GALLERY_SCRIPT, galleryMissingPage } from './gallery-html';
import { imageFilePath } from './image-files';

export interface GalleryFileSource { id: string; file: string; fileHash: string; contentType: ImageContentType }

const PICTURE_FILE = /^[A-Za-z0-9_-]+\.(jpg|png|webp)$/;
const LINK_FALLBACK_CODES = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK']);

const rootOf = (assetDir: string) => join(assetDir, 'galleries');

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

async function writeAtomic(directory: string, name: string, content: string): Promise<void> {
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, join(directory, name));
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try { return (await fs.stat(path)).isFile(); }
  catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error; }
}

async function placeFile(source: string, target: string, link: (from: string, to: string) => Promise<void>): Promise<boolean> {
  try {
    await link(source, target);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return false;
    if (code === 'EEXIST') return true;
    if (!code || !LINK_FALLBACK_CODES.has(code)) throw error;
  }
  const temporary = join(target, '..', `.${randomUUID()}.tmp`);
  try {
    await fs.copyFile(source, temporary, constants.COPYFILE_EXCL);
    await fs.rename(temporary, target);
    return true;
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

export async function ensureGalleryRoot(assetDir: string): Promise<void> {
  const root = rootOf(assetDir);
  await fs.mkdir(root, { recursive: true });
  await writeAtomic(root, 'gallery.css', GALLERY_CSS);
  await writeAtomic(root, 'viewer.js', GALLERY_SCRIPT);
  await writeAtomic(root, 'missing.html', galleryMissingPage());
}

export async function writeGalleryFolder<T extends GalleryFileSource>(
  assetDir: string,
  slug: string,
  pictures: readonly T[],
  render: (placed: T[]) => string,
  link: (from: string, to: string) => Promise<void> = fs.link,
): Promise<T[]> {
  const safeSlug = GallerySlugSchema.parse(slug);
  const folder = join(rootOf(assetDir), safeSlug);
  const pictureDir = join(folder, 'p');
  await fs.mkdir(pictureDir, { recursive: true });
  const placed: T[] = [];
  for (const picture of pictures) {
    if (!PICTURE_FILE.test(picture.file)) continue;
    const target = join(pictureDir, picture.file);
    if (await exists(target)) { placed.push(picture); continue; }
    const source = imageFilePath(assetDir, { file_hash: picture.fileHash, content_type: picture.contentType });
    if (await placeFile(source, target, link)) placed.push(picture);
  }
  await writeAtomic(folder, 'index.html', render(placed));
  const keep = new Set(placed.map((picture) => picture.file));
  for (const entry of await fs.readdir(pictureDir)) {
    if (!keep.has(entry)) await fs.rm(join(pictureDir, entry), { recursive: true, force: true });
  }
  return placed;
}

export async function removeGalleryFolder(assetDir: string, slug: string): Promise<void> {
  const safeSlug = GallerySlugSchema.parse(slug);
  await fs.rm(join(rootOf(assetDir), safeSlug), { recursive: true, force: true });
}

export async function writeGalleryList(assetDir: string, html: string): Promise<void> {
  const root = rootOf(assetDir);
  await fs.mkdir(root, { recursive: true });
  await writeAtomic(root, 'index.html', html);
}

const isTempFileName = (name: string) => name.startsWith('.') && name.endsWith('.tmp');
const isSlugName = (name: string) => GallerySlugSchema.safeParse(name).success;

async function lstatOrNull(path: string) {
  try { return await fs.lstat(path); }
  catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error; }
}

async function isRealDirectory(path: string): Promise<boolean> {
  return (await lstatOrNull(path))?.isDirectory() ?? false;
}

async function readdirOrEmpty(path: string): Promise<string[]> {
  try { return await fs.readdir(path); }
  catch (error) { if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return []; throw error; }
}

// A dot file, so the static server never shows it: the page version every gallery in this folder was last written with.
const PAGE_VERSION_FILE = '.page-version';

export async function readGalleryPageVersion(assetDir: string): Promise<number | null> {
  try {
    const version = Number((await fs.readFile(join(rootOf(assetDir), PAGE_VERSION_FILE), 'utf8')).trim());
    return Number.isInteger(version) ? version : null;
  } catch {
    return null;
  }
}

export async function writeGalleryPageVersion(assetDir: string, version: number): Promise<void> {
  const root = rootOf(assetDir);
  await fs.mkdir(root, { recursive: true });
  await writeAtomic(root, PAGE_VERSION_FILE, `${version}\n`);
}

export async function listGallerySlugFolders(assetDir: string): Promise<string[]> {
  const root = rootOf(assetDir);
  if (!(await isRealDirectory(root))) return [];
  const folders: string[] = [];
  for (const name of (await readdirOrEmpty(root)).sort()) {
    if (isSlugName(name) && await isRealDirectory(join(root, name))) folders.push(name);
  }
  return folders;
}

export async function removeOrphanGalleryFolders(assetDir: string, candidates: readonly string[], live: ReadonlySet<string>): Promise<void> {
  const root = rootOf(assetDir);
  if (!(await isRealDirectory(root))) return;
  for (const name of candidates) {
    if (live.has(name) || !isSlugName(name)) continue;
    const folder = join(root, name);
    if (await isRealDirectory(folder)) await fs.rm(folder, { recursive: true, force: true });
  }
}

export async function removeStaleTempFiles(assetDir: string, olderThanMs = 600_000, now = Date.now()): Promise<void> {
  const root = rootOf(assetDir);
  if (!(await isRealDirectory(root))) return;
  const directories = [root];
  for (const slug of await listGallerySlugFolders(assetDir)) {
    directories.push(join(root, slug));
    if (await isRealDirectory(join(root, slug, 'p'))) directories.push(join(root, slug, 'p'));
  }
  const cutoff = now - olderThanMs;
  for (const directory of directories) {
    for (const name of await readdirOrEmpty(directory)) {
      if (!isTempFileName(name)) continue;
      const path = join(directory, name);
      const info = await lstatOrNull(path);
      if (info?.isFile() && info.mtimeMs < cutoff) await fs.rm(path, { force: true });
    }
  }
}
