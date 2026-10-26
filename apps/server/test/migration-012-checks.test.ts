import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'migration-012-checks-test-host-credential';
const CHECK_VIOLATION = '23514';

type Fields = { purpose: string; session_id: string | null; beat_id: string | null; released_at: Date | null };

suite('migration 012 picture checks', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let sessionId: string, ownerId: string, sceneId: string;

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const post = (url: string, payload: Record<string, unknown>, credential = '') => app.inject({ method: 'POST', url, headers: { origin, ...(credential ? { cookie: credential } : {}) }, payload });
  const valid = (): Fields => ({ purpose: 'scene', session_id: sessionId, beat_id: 'beat-action-1', released_at: null });
  const insert = (fields: Fields) => pool.query(
    `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, attach, status, prompt, width, height, provider, model, requested_by, beat_id, released_at)
     VALUES($1,$2,$3,$4,$5,'test-limit',false,'making','A quiet harbor.',768,768,'fake','fake-image',$2,$6,$7)`,
    [randomUUID(), ownerId, fields.session_id, fields.purpose, sceneId, fields.beat_id, fields.released_at]);
  const refusal = async (fields: Fields) => {
    const error = await insert(fields).then(() => null, (caught: unknown) => caught as { code?: string });
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

  it('accepts an action picture held for its round and one released with it', async () => {
    await insert(valid());
    await insert({ ...valid(), released_at: new Date() });
    await insert({ ...valid(), beat_id: null });
    expect((await pool.query('SELECT count(*)::int AS n FROM images')).rows[0].n).toBe(3);
  });

  it('refuses a round on a picture that is not a scene picture', () => refusal({ ...valid(), purpose: 'npc' }));
  it('refuses a round on a scene picture with no session', () => refusal({ ...valid(), session_id: null }));
  it('refuses a release time on a picture with no round', () => refusal({ ...valid(), beat_id: null, released_at: new Date() }));
  it('refuses an empty round id', () => refusal({ ...valid(), beat_id: '' }));
});
