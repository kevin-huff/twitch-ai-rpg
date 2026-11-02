import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool, migrate } from '../src/database';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const CHECK_VIOLATION = '23514';

suite('migration 017 picture shelf checks', () => {
  let pool: ReturnType<typeof createPool>;
  const sessionIds: string[] = [];
  const newSession = async () => {
    const id = randomUUID();
    sessionIds.push(id);
    await pool.query(`INSERT INTO sessions(id,owner_id,title,scene,status) VALUES($1,$2,'Shelf check','{}'::jsonb,'ended')`, [id, randomUUID()]);
    return id;
  };
  const insertImage = async (sessionId: string, fields: { purpose?: string; beatId?: string | null; shelfOnly?: boolean } = {}) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, status, prompt, width, height, provider, model, requested_by, beat_id, shelf_only)
       VALUES($1,'owner',$2,$3,'subject','limit','making','a prompt',768,768,'fake','m','host',$4,$5)`,
      [id, sessionId, fields.purpose ?? 'scene', fields.beatId ?? null, fields.shelfOnly ?? false]);
    return id;
  };
  const code = async (run: Promise<unknown>) => ((await run.then(() => null, (e: unknown) => e)) as { code?: string } | null)?.code;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    await migrate(pool);
  });
  afterAll(async () => {
    if (pool) {
      await pool.query('UPDATE sessions SET pinned_image_id = NULL WHERE id = ANY($1::text[])', [sessionIds]);
      await pool.query('DELETE FROM images WHERE session_id = ANY($1::text[])', [sessionIds]);
      await pool.query('DELETE FROM sessions WHERE id = ANY($1::text[])', [sessionIds]);
      await pool.end();
    }
  });

  it('starts every session unpinned and every picture on the stream path', async () => {
    const sessionId = await newSession();
    const imageId = await insertImage(sessionId);
    expect((await pool.query('SELECT pinned_image_id FROM sessions WHERE id=$1', [sessionId])).rows[0].pinned_image_id).toBeNull();
    expect((await pool.query('SELECT shelf_only FROM images WHERE id=$1', [imageId])).rows[0].shelf_only).toBe(false);
  });
  it('allows a shelf-only scene picture with no beat', async () => {
    expect(await code(insertImage(await newSession(), { shelfOnly: true }))).toBeUndefined();
  });
  it('refuses shelf_only on an npc row', async () => {
    expect(await code(insertImage(await newSession(), { purpose: 'npc', shelfOnly: true }))).toBe(CHECK_VIOLATION);
  });
  it('refuses shelf_only on a round-tagged scene row', async () => {
    expect(await code(insertImage(await newSession(), { beatId: 'beat-1', shelfOnly: true }))).toBe(CHECK_VIOLATION);
  });
  it('clears the pin when the pinned picture is deleted', async () => {
    const sessionId = await newSession();
    const imageId = await insertImage(sessionId);
    await pool.query('UPDATE sessions SET pinned_image_id=$1 WHERE id=$2', [imageId, sessionId]);
    expect((await pool.query('SELECT pinned_image_id FROM sessions WHERE id=$1', [sessionId])).rows[0].pinned_image_id).toBe(imageId);
    await pool.query('DELETE FROM images WHERE id=$1', [imageId]);
    expect((await pool.query('SELECT pinned_image_id FROM sessions WHERE id=$1', [sessionId])).rows[0].pinned_image_id).toBeNull();
  });
});
