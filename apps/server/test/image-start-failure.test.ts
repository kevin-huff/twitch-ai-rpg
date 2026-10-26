import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { buildApp } from '../src/app';
import { createPool, transaction } from '../src/database';
import { FakeImageProvider } from '../src/fake-images';
import { runImageJob, type ImageJobContext } from '../src/image-jobs';
import { ImageSlots } from '../src/image-slots';
import { ImageService, PICTURE_MESSAGES } from '../src/images';
import { readState, type Actor } from '../src/repository';
import type { ImageRow } from '../src/picture-views';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'image-start-failure-test-host-credential';

suite('picture start failures', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  let sessionId: string, ownerId: string, host: Actor;
  const services: ImageService[] = [];

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const post = (url: string, payload: Record<string, unknown>, credential = '') => app.inject({ method: 'POST', url, headers: { origin, ...(credential ? { cookie: credential } : {}) }, payload });
  const state = () => transaction(pool, client => readState(client, sessionId));
  const load = async (id: string) => (await pool.query<ImageRow>('SELECT * FROM images WHERE id=$1', [id])).rows[0]!;
  const events = async () => (await pool.query<{ kind: string; data: Record<string, unknown> }>(
    "SELECT kind, data FROM audit_events WHERE session_id=$1 AND kind LIKE 'picture.%' ORDER BY sequence", [sessionId])).rows;
  // The database answers every query normally except the first one, which fails like a dropped connection.
  function hiccupOnce(): Pool {
    let failed = false;
    return new Proxy(pool, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== 'query') return typeof value === 'function' ? value.bind(target) : value;
        return (...args: unknown[]) => {
          if (!failed) { failed = true; return Promise.reject(new Error('connection reset')); }
          return (value as (...inner: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }
  async function reserveFor(current: Awaited<ReturnType<typeof state>>) {
    const images = new ImageService({ pool, provider: new FakeImageProvider(), assetDir });
    services.push(images);
    return (await transaction(pool, client => images.reserveScene(client, current, host)))!;
  }
  async function waitFor(check: () => Promise<boolean>, what: string) {
    const deadline = Date.now() + 5_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM images');
    assetDir = await mkdtemp(join(tmpdir(), 'rpg-image-start-failure-'));
    const credential = cookie(await post('/api/auth/host', { token: hostToken }));
    sessionId = (await post('/api/sessions', { commandId: randomUUID() }, credential)).json().sessionId;
    ownerId = (await pool.query('SELECT owner_id FROM sessions WHERE id=$1', [sessionId])).rows[0].owner_id;
    host = { actor_id: ownerId, role: 'host', session_id: null, character_id: null };
  });
  afterEach(async () => {
    while (services.length) await services.pop()!.close();
    await rm(assetDir, { recursive: true, force: true });
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  it('fails the row when the job cannot read it, with the normal message and event', async () => {
    const id = await reserveFor(await state());
    const provider = new FakeImageProvider();
    const context: ImageJobContext = { pool: hiccupOnce(), provider, assetDir, slots: new ImageSlots(4) };
    expect(await runImageJob(context, id, new AbortController().signal)).toEqual({ status: 'skipped' });
    expect(provider.requests).toHaveLength(0);
    const row = await load(id);
    expect(row).toMatchObject({ status: 'failed', message: PICTURE_MESSAGES.sceneFailed });
    expect(row.finished_at).toBeInstanceOf(Date);
    expect(await events()).toEqual([{ kind: 'picture.failed', data: { imageId: id, purpose: 'scene', subjectId: row.subject_id } }]);
  });

  it('fails the row when run() cannot look up its ids, and does not throw', async () => {
    const id = await reserveFor(await state());
    const provider = new FakeImageProvider();
    const images = new ImageService({ pool: hiccupOnce(), provider, assetDir });
    services.push(images);
    expect(() => images.run([id])).not.toThrow();
    await waitFor(async () => (await load(id)).status === 'failed', 'the row to fail');
    expect(await load(id)).toMatchObject({ status: 'failed', message: PICTURE_MESSAGES.sceneFailed });
    expect(provider.requests).toHaveLength(0);
    expect(await events()).toEqual([{ kind: 'picture.failed', data: { imageId: id, purpose: 'scene', subjectId: (await load(id)).subject_id } }]);
  });

  it('fails the row when generateNow cannot look it up, and still rejects', async () => {
    const id = await reserveFor(await state());
    const provider = new FakeImageProvider();
    const images = new ImageService({ pool: hiccupOnce(), provider, assetDir });
    services.push(images);
    await expect(images.generateNow(id)).rejects.toThrow('connection reset');
    expect(await load(id)).toMatchObject({ status: 'failed', message: PICTURE_MESSAGES.sceneFailed });
    expect(provider.requests).toHaveLength(0);
  });

  it('leaves a row that already started alone', async () => {
    const id = await reserveFor(await state());
    await pool.query('UPDATE images SET started_at=clock_timestamp() WHERE id=$1', [id]);
    const provider = new FakeImageProvider();
    const images = new ImageService({ pool: hiccupOnce(), provider, assetDir });
    services.push(images);
    images.run([id]);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect((await load(id)).status).toBe('making');
  });

  it('leaves the placeholder place out of the scene prompt', async () => {
    const current = await state();
    const place = current.locations.find(location => location.id === current.session.scene.locationId)!;
    Object.assign(place, { title: 'Current location', description: '  ' });
    const id = await reserveFor(current);
    expect((await load(id)).prompt).not.toContain('The place:');
    Object.assign(place, { title: 'The Salt Quay', description: 'Wet stone and nets.' });
    const named = await reserveFor(current);
    expect((await load(named)).prompt).toContain('The place: The Salt Quay');
  });
});
