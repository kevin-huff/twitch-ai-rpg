import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createPool, migrate } from '../src/database';
import { imageExtension, imageFilePath } from '../src/image-files';

describe('picture store paths', () => {
  it('maps content types to extensions', () => {
    expect(imageExtension('image/jpeg')).toBe('jpg');
    expect(imageExtension('image/png')).toBe('png');
    expect(imageExtension('image/webp')).toBe('webp');
  });
  it('builds the stored file path', () => {
    expect(imageFilePath('/assets', { file_hash: 'abc', content_type: 'image/webp' })).toBe(join('/assets', 'images', 'abc.webp'));
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const CHECK_VIOLATION = '23514', UNIQUE_VIOLATION = '23505', FOREIGN_KEY_VIOLATION = '23503';

suite('migration 014 gallery checks', () => {
  let pool: ReturnType<typeof createPool>;
  const sessionIds: string[] = [];
  const slug = () => randomBytes(32).toString('base64url');
  const newSession = async () => {
    const id = randomUUID();
    sessionIds.push(id);
    await pool.query(`INSERT INTO sessions(id,owner_id,title,scene,status) VALUES($1,$2,'Gallery check','{}'::jsonb,'ended')`, [id, randomUUID()]);
    return id;
  };
  const insert = (sessionId: string, fields: { slug?: string; pictures?: number; message?: string | null } = {}) =>
    pool.query('INSERT INTO galleries(session_id, slug, pictures, message) VALUES($1,$2,$3,$4)', [sessionId, fields.slug ?? slug(), fields.pictures ?? 0, fields.message ?? null]);
  const code = async (run: Promise<unknown>) => ((await run.then(() => null, (e: unknown) => e)) as { code?: string } | null)?.code;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    await migrate(pool);
  });
  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM galleries WHERE session_id = ANY($1::text[])', [sessionIds]);
      await pool.query('DELETE FROM sessions WHERE id = ANY($1::text[])', [sessionIds]);
      await pool.end();
    }
  });

  it('defaults a valid row', async () => {
    const id = await newSession();
    await insert(id);
    const row = (await pool.query('SELECT listed, pictures, created_at, written_at, message FROM galleries WHERE session_id=$1', [id])).rows[0];
    expect(row.listed).toBe(false);
    expect(row.pictures).toBe(0);
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.written_at).toBeNull();
    expect(row.message).toBeNull();
  });
  it('refuses a slug of the wrong length', async () => {
    expect(await code(insert(await newSession(), { slug: slug().slice(0, 42) }))).toBe(CHECK_VIOLATION);
  });
  it('refuses a slug with a slash', async () => {
    expect(await code(insert(await newSession(), { slug: `${slug().slice(0, 42)}/` }))).toBe(CHECK_VIOLATION);
  });
  it('refuses a duplicate slug', async () => {
    const shared = slug();
    await insert(await newSession(), { slug: shared });
    expect(await code(insert(await newSession(), { slug: shared }))).toBe(UNIQUE_VIOLATION);
  });
  it('refuses a second row for one session', async () => {
    const id = await newSession();
    await insert(id);
    expect(await code(insert(id))).toBe(UNIQUE_VIOLATION);
  });
  it('refuses a negative picture count', async () => {
    expect(await code(insert(await newSession(), { pictures: -1 }))).toBe(CHECK_VIOLATION);
  });
  it('refuses a message over 300 characters and accepts 300', async () => {
    expect(await code(insert(await newSession(), { message: 'x'.repeat(301) }))).toBe(CHECK_VIOLATION);
    expect(await code(insert(await newSession(), { message: 'x'.repeat(300) }))).toBeUndefined();
  });
  it('refuses an unknown session', async () => {
    expect(await code(insert(randomUUID()))).toBe(FOREIGN_KEY_VIOLATION);
  });
  it('adds a nullable shows_beat_id text column to images', async () => {
    const row = (await pool.query(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name='images' AND column_name='shows_beat_id'`)).rows[0];
    expect(row).toEqual({ data_type: 'text', is_nullable: 'YES' });
  });
});
