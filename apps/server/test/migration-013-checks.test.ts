import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'migration-013-checks-test-host-credential';
const CHECK_VIOLATION = '23514';

type Fields = { purpose: string; session_id: string | null; moment: string | null; prompt: string };

suite('migration 013 picture checks', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let sessionId: string, ownerId: string, sceneId: string;

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const post = (url: string, payload: Record<string, unknown>, credential = '') => app.inject({ method: 'POST', url, headers: { origin, ...(credential ? { cookie: credential } : {}) }, payload });
  const valid = (): Fields => ({ purpose: 'scene', session_id: sessionId, moment: null, prompt: 'A quiet harbor.' });
  const insert = (fields: Fields) => pool.query(
    `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, attach, status, prompt, width, height, provider, model, requested_by, moment)
     VALUES($1,$2,$3,$4,$5,'test-limit',false,'making',$6,768,768,'fake','fake-image',$2,$7::jsonb)`,
    [randomUUID(), ownerId, fields.session_id, fields.purpose, sceneId, fields.prompt, fields.moment]);
  const refusal = async (run: Promise<unknown>) => {
    const error = await run.then(() => null, (caught: unknown) => caught as { code?: string });
    expect(error?.code).toBe(CHECK_VIOLATION);
  };

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM images');
    const host = cookie(await post('/api/auth/host', { token: hostToken }));
    sessionId = (await post('/api/sessions', { commandId: randomUUID() }, host)).json().sessionId;
    const row = (await pool.query('SELECT owner_id, scene FROM sessions WHERE id=$1', [sessionId])).rows[0];
    ownerId = row.owner_id; sceneId = row.scene.id;
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  it('accepts null columns and an object moment on a scene picture', async () => {
    await insert(valid());
    await insert({ ...valid(), moment: '{"style":"x"}' });
    await pool.query('UPDATE sessions SET picture_settings=NULL WHERE id=$1', [sessionId]);
    await pool.query(`UPDATE sessions SET picture_settings='{"style":"","model":null}'::jsonb WHERE id=$1`, [sessionId]);
    expect((await pool.query('SELECT count(*)::int AS n FROM images WHERE moment IS NOT NULL')).rows[0].n).toBe(1);
  });

  it('refuses a moment on a portrait picture', () => refusal(insert({ ...valid(), purpose: 'npc', moment: '{"style":"x"}' })));
  it('refuses a moment on a scene picture with no session', () => refusal(insert({ ...valid(), session_id: null, moment: '{"style":"x"}' })));
  it('refuses a moment that is not an object', () => refusal(insert({ ...valid(), moment: '[1]' })));
  it('refuses picture settings that are not an object', () => refusal(pool.query(`UPDATE sessions SET picture_settings='"text"'::jsonb WHERE id=$1`, [sessionId])));
  it('accepts a long prompt', async () => {
    await insert({ ...valid(), prompt: 'a'.repeat(3500) });
    expect((await pool.query('SELECT count(*)::int AS n FROM images')).rows[0].n).toBe(1);
  });
  it('refuses an empty prompt', () => refusal(insert({ ...valid(), prompt: '' })));
});
