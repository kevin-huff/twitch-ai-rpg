import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderError } from '@rpg/providers';
import { createLedgerState } from '@rpg/test-fixtures';
import type { Beat, ScriptSegment, SessionState } from '@rpg/contracts';
import { createPool, migrate, transaction } from '../src/database';
import { FakeImageProvider } from '../src/fake-images';
import { ImageService } from '../src/images';
import { readState, saveState, type Actor } from '../src/repository';
import type { ImageRow } from '../src/picture-views';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite('gallery image service hooks', () => {
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  const services: ImageService[] = [];
  const sessionIds: string[] = [];

  function service(options: { onReady?: (sessionId: string) => void; failing?: boolean } = {}) {
    const images = new ImageService({
      pool, assetDir, onReady: options.onReady,
      provider: new FakeImageProvider({ fail: () => (options.failing ? new ProviderError('http_error', 'Sogni') : null) }),
    });
    services.push(images);
    return images;
  }

  async function makeSession() {
    const id = randomUUID();
    const ownerId = randomUUID();
    sessionIds.push(id);
    await pool.query("INSERT INTO sessions(id,owner_id,title,scene,status) VALUES($1,$2,'Hooks','{}'::jsonb,'live')", [id, ownerId]);
    await transaction(pool, client => saveState(client, createLedgerState(id, randomUUID)));
    const host: Actor = { actor_id: ownerId, role: 'host', session_id: null, character_id: null };
    const state = await transaction(pool, client => readState(client, id));
    return { id, host, state };
  }

  async function publish(sessionId: string): Promise<string> {
    const id = `beat-published-${randomUUID()}`;
    const segment: ScriptSegment = { id: randomUUID(), kind: 'narration', text: 'Rain on the windows.', speaker: null, recipientCharacterIds: [], delivery: 'neutral', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false };
    const data = {
      id, sessionId, kind: 'conversation', phase: 'published', revision: 1, inputEpoch: 0, sourceStateRevision: 0, selectedSubmissionIds: [], lockedSubmissions: [],
      contracts: [], stakesApproved: true, classification: 'conversation', inputSnapshotHash: null, resolution: null, draft: null, draftRevision: 1,
      approvedContinuity: [], generation: 1, lastError: null,
    } as unknown as Beat;
    await pool.query("INSERT INTO beats(id,session_id,kind,phase,data) VALUES($1,$2,'conversation','published',$3)", [id, sessionId, data]);
    await pool.query('INSERT INTO published_beats(id,session_id,beat_number,data) VALUES($1,$2,1,$3)', [id, sessionId, {
      id, kind: 'conversation', beatNumber: 1, actionRoundNumber: 0, stateRevision: 0, publishedAt: new Date().toISOString(), segments: [segment], rolls: [], outcomes: [], textOnly: true,
    }]);
    return id;
  }

  const load = async (id: string) => (await pool.query<ImageRow>('SELECT * FROM images WHERE id=$1', [id])).rows[0]!;
  const reserveScene = (images: ImageService, session: Awaited<ReturnType<typeof makeSession>>) =>
    transaction(pool, client => images.reserveScene(client, session.state as SessionState, session.host));

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    await migrate(pool);
    assetDir = await mkdtemp(join(tmpdir(), 'rpg-gallery-hooks-'));
  });
  afterAll(async () => {
    while (services.length) await services.pop()!.close();
    if (pool) {
      await pool.query('DELETE FROM images WHERE session_id=ANY($1::text[])', [sessionIds]);
      await pool.query('DELETE FROM published_beats WHERE session_id=ANY($1::text[])', [sessionIds]);
      await pool.query('DELETE FROM beats WHERE session_id=ANY($1::text[])', [sessionIds]);
      for (const table of ['outbox', 'characters', 'npcs', 'tracks', 'facts', 'audit_events']) await pool.query(`DELETE FROM ${table} WHERE session_id=ANY($1::text[])`, [sessionIds]);
      await pool.query('DELETE FROM sessions WHERE id=ANY($1::text[])', [sessionIds]);
      await pool.end();
    }
    if (assetDir) await rm(assetDir, { recursive: true, force: true });
  });

  it('stores shows_beat_id for a beat picture and leaves it null for a scene picture', async () => {
    const session = await makeSession();
    const images = service();
    const beatId = await publish(session.id);
    const beatPicture = await transaction(pool, client => images.reserveBeatPicture(client, session.state as SessionState, beatId, session.host));
    const scenePicture = await reserveScene(images, session);
    expect((await load(beatPicture!)).shows_beat_id).toBe(beatId);
    expect((await load(scenePicture!)).shows_beat_id).toBeNull();
  });

  it('calls onReady once with the session id when a scene picture finishes', async () => {
    const session = await makeSession();
    const onReady = vi.fn();
    const images = service({ onReady });
    const id = (await reserveScene(images, session))!;
    images.run([id]);
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(onReady).toHaveBeenCalledWith(session.id);
    expect((await load(id)).status).toBe('ready');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('never calls onReady when the provider fails', async () => {
    const session = await makeSession();
    const onReady = vi.fn();
    const images = service({ onReady, failing: true });
    const id = (await reserveScene(images, session))!;
    images.run([id]);
    await vi.waitFor(async () => expect((await load(id)).status).toBe('failed'), { timeout: 10_000 });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(onReady).not.toHaveBeenCalled();
  });

  it('leaves the picture ready when onReady throws or rejects', async () => {
    for (const hook of [() => { throw new Error('boom'); }, () => Promise.reject(new Error('boom'))]) {
      const session = await makeSession();
      const onReady = vi.fn(hook as unknown as (sessionId: string) => void);
      const images = service({ onReady });
      const id = (await reserveScene(images, session))!;
      images.run([id]);
      await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      await vi.waitFor(async () => expect((await load(id)).status).toBe('ready'), { timeout: 10_000 });
    }
  });
});
