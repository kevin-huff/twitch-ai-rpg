import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_IMAGE_BYTES, imageTypeOf, type ImageContentType } from '@rpg/contracts';

const EXTENSIONS: Record<ImageContentType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const BAD_IMAGE = 'The picture file is not a supported image.';

export async function storeImage(assetDir: string, bytes: Uint8Array): Promise<{ fileHash: string; contentType: ImageContentType; byteLength: number }> {
  const contentType = imageTypeOf(bytes);
  if (!contentType || !bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(BAD_IMAGE);
  const fileHash = createHash('sha256').update(bytes).digest('hex');
  const directory = join(assetDir, 'images');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${fileHash}.${EXTENSIONS[contentType]}`);
  let saved;
  try { saved = await stat(path); }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
  if (!saved) {
    const temporary = join(directory, `${fileHash}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
      try { await link(temporary, path); }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error; }
    } finally { await unlink(temporary).catch(() => {}); }
    saved = await stat(path);
  }
  if (!saved.isFile() || saved.size !== bytes.byteLength) throw new Error(BAD_IMAGE);
  return { fileHash, contentType, byteLength: saved.size };
}

export function imageExtension(contentType: ImageContentType): 'jpg' | 'png' | 'webp' {
  return EXTENSIONS[contentType] as 'jpg' | 'png' | 'webp';
}

export function imageFilePath(assetDir: string, row: { file_hash: string; content_type: ImageContentType }): string {
  return join(assetDir, 'images', `${row.file_hash}.${imageExtension(row.content_type)}`);
}

export async function readImageFile(assetDir: string, row: { file_hash: string; content_type: ImageContentType }): Promise<Buffer> {
  return readFile(imageFilePath(assetDir, row));
}
