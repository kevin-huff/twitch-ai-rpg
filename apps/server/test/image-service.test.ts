import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PICTURE_MODELS, PICTURE_NEGATIVE_PROMPT, type SessionState } from '@rpg/contracts';
import { ProviderError } from '@rpg/providers';
import { buildApp } from '../src/app';
import { createPool, transaction } from '../src/database';
import { FakeImageProvider, type FakeImageOptions } from '../src/fake-images';
import { ImageService, PICTURE_MESSAGES, type ImageReservation, type ImageServiceOptions } from '../src/images';
import { AppError, readState, type Actor } from '../src/repository';
import type { ImageRow } from '../src/picture-views';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'image-service-test-host-credential';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

suite('image service', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  let sessionId: string, ownerId: string, host: Actor;
  const services: ImageService[] = [];

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const post = (url: string, payload: Record<string, unknown>, credential = '') => app.inject({ method: 'POST', url, headers: { origin, ...(credential ? { cookie: credential } : {}) }, payload });
  function service(options: FakeImageOptions | null = {}, extra: Partial<ImageServiceOptions> = {}) {
    const provider = options ? new FakeImageProvider(options) : undefined;
    const images = new ImageService({ pool, provider, assetDir, ...extra });
    services.push(images);
    return { images, provider: provider! };
  }
  const state = () => transaction(pool, client => readState(client, sessionId));
  const rows = async () => (await pool.query<ImageRow>('SELECT * FROM images ORDER BY created_at, id')).rows;
  const load = async (id: string) => (await pool.query<ImageRow>('SELECT * FROM images WHERE id=$1', [id])).rows[0]!;
  async function waitFor(check: () => Promise<boolean> | boolean, what: string) {
    const deadline = Date.now() + 5_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  const statusOf = async (id: string) => (await load(id)).status;
  async function counted(count: number, fields: { sessionId?: string | null; purpose?: string; limitKey?: string } = {}) {
    for (let index = 0; index < count; index++) {
      await pool.query(
        `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, status, prompt, width, height, provider, model, requested_by, created_at)
         VALUES($1,$2,$3,$4,'subject',$5,'making','a counted picture',768,768,'fake','fake-image',$2, clock_timestamp() - interval '10 minutes')`,
        [randomUUID(), ownerId, fields.sessionId ?? null, fields.purpose ?? 'card', fields.limitKey ?? 'elsewhere']);
    }
  }
  const card = (fields: Partial<ImageReservation> = {}): ImageReservation => ({
    ownerId, sessionId: null, builderId: null, purpose: 'card', subjectId: 'card-key', limitKey: `library:${ownerId}:card-key`, attach: false,
    prompt: 'Painterly digital illustration. Head-and-shoulders portrait of one character.', width: 768, height: 768,
    requestedBy: { actor_id: ownerId }, ...fields,
  });
  const reserveScene = (images: ImageService, current: SessionState, mode?: 'request' | 'automatic') =>
    transaction(pool, client => images.reserveScene(client, current, host, mode));
  async function rejection(work: Promise<unknown>) {
    const error = await work.then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(AppError);
    const { status, code, message } = error as AppError;
    return { status, code, message };
  }

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM images');
    assetDir = await mkdtemp(join(tmpdir(), 'rpg-image-service-'));
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

  it('reserves a scene picture inside the caller transaction and makes it after commit', async () => {
    const { images, provider } = service();
    expect(images.enabled).toBe(true);
    const current = await state();
    const id = await reserveScene(images, current);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await load(id!)).toMatchObject({
      owner_id: ownerId, session_id: sessionId, builder_id: null, purpose: 'scene', subject_id: current.session.scene.id,
      limit_key: `scene:${sessionId}`, attach: false, status: 'making', hidden: false, width: 1344, height: 768,
      provider: 'fake', model: 'fake-image', requested_by: ownerId, producer_grant_id: null, started_at: null,
    });
    images.run([id!]);
    await waitFor(async () => await statusOf(id!) === 'ready', 'the scene picture');
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({ requestId: id, width: 1344, height: 768, title: 'Scene picture', negativePrompt: PICTURE_NEGATIVE_PROMPT });
    expect(provider.requests[0]!.prompt).toBe((await load(id!)).prompt);
  });

  it('rolls a reservation back with the transaction that made it', async () => {
    const { images } = service();
    const current = await state();
    await expect(transaction(pool, async (client) => {
      expect(await images.reserveScene(client, current, host)).toBeTruthy();
      throw new Error('the command failed');
    })).rejects.toThrow('the command failed');
    expect(await rows()).toEqual([]);
  });

  it('reserves a portrait for a live non-player character that attaches when ready', async () => {
    const { images, provider } = service();
    const current = await state();
    const npc = current.npcs.find(candidate => candidate.appearance.trim() || candidate.role.trim())!;
    const id = await transaction(pool, client => images.reserveNpcPortrait(client, current, npc.id, host));
    expect(await load(id!)).toMatchObject({ purpose: 'npc', subject_id: npc.id, attach: true, limit_key: `npc:${sessionId}:${npc.id}`, width: 768, height: 768, status: 'making' });
    images.run([id!]);
    await waitFor(async () => await statusOf(id!) === 'ready', 'the portrait');
    expect(provider.requests[0]).toMatchObject({ title: 'Portrait', width: 768, height: 768 });
    expect((await pool.query('SELECT data FROM npcs WHERE session_id=$1 AND id=$2', [sessionId, npc.id])).rows[0].data.portraitId).toBe(id);
  });

  it('makes no portrait for a character with nothing to draw or one that is not in the show', async () => {
    const { images } = service();
    const current = await state();
    const npc = current.npcs[0]!;
    npc.appearance = ' ';
    npc.role = '';
    expect(await transaction(pool, client => images.reserveNpcPortrait(client, current, npc.id, host))).toBeNull();
    expect(await transaction(pool, client => images.reserveNpcPortrait(client, current, npc.id, host, 'request'))).toBeNull();
    expect(await transaction(pool, client => images.reserveNpcPortrait(client, current, 'nobody', host))).toBeNull();
    expect(await rows()).toEqual([]);
  });

  it('records the producer who asked for a picture', async () => {
    const { images } = service();
    const grant = (await pool.query('SELECT id FROM producer_grants LIMIT 1')).rows[0]?.id as string | undefined;
    const id = await transaction(pool, client => images.reserve(client, card({ requestedBy: { actor_id: 'someone-else', producer_grant_id: grant ?? null } }), 'request'));
    expect(await load(id!)).toMatchObject({ requested_by: 'someone-else', producer_grant_id: grant ?? null, session_id: null, purpose: 'card' });
  });

  it('copies the hidden flag from the newest picture of the same scene only', async () => {
    const { images } = service();
    const current = await state();
    const first = await reserveScene(images, current, 'request');
    await pool.query('UPDATE images SET hidden=true WHERE id=$1', [first]);
    const second = await reserveScene(images, current, 'request');
    expect((await load(second!)).hidden).toBe(true);
    current.session.scene.id = 'another-scene';
    const other = await reserveScene(images, current, 'request');
    expect((await load(other!)).hidden).toBe(false);
  });

  it('keeps the caller transaction usable when an automatic reservation fails', async () => {
    const { images } = service();
    const current = await state();
    const result = await transaction(pool, async (client) => {
      await client.query("UPDATE sessions SET title='Kept title' WHERE id=$1", [sessionId]);
      // An empty prompt breaks the table's check, so the insert itself fails inside the savepoint.
      expect(await images.reserve(client, card({ prompt: '' }), 'automatic')).toBeNull();
      expect(await images.reserve(client, card({ sessionId: 'no-such-session', purpose: 'npc' }), 'automatic')).toBeNull();
      const id = await images.reserveScene(client, current, host);
      return { id, title: (await client.query('SELECT title FROM sessions WHERE id=$1', [sessionId])).rows[0].title };
    });
    expect(result.title).toBe('Kept title');
    expect((await rows()).map(row => row.id)).toEqual([result.id]);
  });

  it('lets a failing request reservation fail its caller', async () => {
    const { images } = service();
    await expect(transaction(pool, client => images.reserve(client, card({ prompt: '' }), 'request'))).rejects.toThrow();
    expect(await rows()).toEqual([]);
  });

  it('refuses over the hourly limit, and records why when the picture was automatic', async () => {
    const { images } = service({}, { hourlyLimit: 3 });
    await counted(3);
    const failure = await rejection(transaction(pool, client => images.reserve(client, card(), 'request')));
    expect(failure).toEqual({ status: 429, code: 'picture_limit', message: 'The picture limit for this hour is used up. Try again in 50 minutes.' });
    expect(await rows()).toHaveLength(3);
    const current = await state();
    expect(await reserveScene(images, current)).toBeNull();
    const recorded = (await rows()).filter(row => row.status === 'failed');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ purpose: 'scene', subject_id: current.session.scene.id, message: failure.message, started_at: null });
    expect(recorded[0]!.finished_at).toBeInstanceOf(Date);
    // A limit failure does not count, so the limit is still exactly three.
    await pool.query("UPDATE images SET status='cancelled' WHERE status='making' AND id=(SELECT id FROM images WHERE status='making' LIMIT 1)");
    expect(await transaction(pool, client => images.reserve(client, card(), 'request'))).toBeTruthy();
  });

  it('makes pictures with no per-show, per-character or default hourly cap', async () => {
    const { images } = service();
    const current = await state();
    const npc = current.npcs.find(candidate => candidate.appearance.trim() || candidate.role.trim())!;
    await counted(130);
    await counted(210, { sessionId, purpose: 'scene' });
    await counted(12, { sessionId, purpose: 'npc', limitKey: `npc:${sessionId}:${npc.id}` });
    expect(await reserveScene(images, current, 'request')).toBeTruthy();
    expect(await transaction(pool, client => images.reserveNpcPortrait(client, current, npc.id, host, 'request'))).toBeTruthy();
    expect(await transaction(pool, client => images.reserve(client, card(), 'request'))).toBeTruthy();
  });

  it('switches off cleanly without a picture service', async () => {
    const { images } = service(null);
    expect(images.enabled).toBe(false);
    const current = await state();
    const off = { status: 503, code: 'pictures_off', message: 'Pictures are off on this server.' };
    expect(await rejection(transaction(pool, client => images.reserve(client, card(), 'request')))).toEqual(off);
    expect(await rejection(reserveScene(images, current, 'request'))).toEqual(off);
    expect(await reserveScene(images, current)).toBeNull();
    expect(await transaction(pool, client => images.reserveNpcPortrait(client, current, current.npcs[0]!.id, host))).toBeNull();
    expect(await rejection(images.generateNow(randomUUID()))).toEqual(off);
    images.run([randomUUID()]);
    expect(await rows()).toEqual([]);
    expect(PICTURE_MESSAGES.off).toBe(off.message);
  });

  it('stops the show\'s picture for an earlier scene when a new scene picture starts', async () => {
    const gate = deferred();
    const { images, provider } = service({ hold: () => gate.promise });
    const current = await state();
    const oldId = await reserveScene(images, current);
    const portrait = await transaction(pool, client => images.reserve(client, card(), 'request'));
    images.run([oldId!, portrait!]);
    await waitFor(() => provider.requests.length === 2, 'both pictures to reach the service');
    await pool.query("UPDATE sessions SET scene=jsonb_set(scene, '{id}', to_jsonb('the-next-scene'::text)) WHERE id=$1", [sessionId]);
    current.session.scene.id = 'the-next-scene';
    const newId = await reserveScene(images, current);
    images.run([newId!]);
    await waitFor(async () => await statusOf(oldId!) === 'cancelled', 'the old scene picture to stop');
    expect((await load(oldId!)).message).toBe(PICTURE_MESSAGES.superseded);
    await waitFor(() => provider.requests.length === 3, 'the new scene picture to reach the service');
    gate.resolve();
    await waitFor(async () => await statusOf(newId!) === 'ready' && await statusOf(portrait!) === 'ready', 'the other pictures');
  });

  it('cancels a queued picture for an earlier scene without calling the service', async () => {
    const gate = deferred();
    const { images, provider } = service({ hold: () => gate.promise }, { concurrency: 1 });
    const blocker = await transaction(pool, client => images.reserve(client, card(), 'request'));
    images.run([blocker!]);
    await waitFor(() => provider.requests.length === 1, 'the first picture to hold the only slot');
    const current = await state();
    const oldId = await reserveScene(images, current);
    images.run([oldId!]);
    await new Promise(resolve => setTimeout(resolve, 50));
    current.session.scene.id = 'the-next-scene';
    await pool.query("UPDATE sessions SET scene=jsonb_set(scene, '{id}', to_jsonb('the-next-scene'::text)) WHERE id=$1", [sessionId]);
    const newId = await reserveScene(images, current);
    images.run([newId!]);
    await waitFor(async () => await statusOf(oldId!) === 'cancelled', 'the queued scene picture to stop');
    expect((await load(oldId!)).started_at).toBeNull();
    gate.resolve();
    await waitFor(async () => await statusOf(newId!) === 'ready', 'the new scene picture');
    expect(provider.requests.map(request => request.requestId)).toEqual([blocker, newId]);
  });

  it('waits for a requested picture and returns once it is ready', async () => {
    const { images, provider } = service({ delayMs: 30 });
    const id = await transaction(pool, client => images.reserve(client, card(), 'request'));
    await images.generateNow(id!);
    expect(await load(id!)).toMatchObject({ status: 'ready', content_type: 'image/png' });
    expect(provider.requests).toHaveLength(1);
  });

  it('turns a failed requested picture into a plain error', async () => {
    const { images } = service({ fail: () => new ProviderError('http_error', 'Sogni', 500, 'safety') });
    const id = await transaction(pool, client => images.reserve(client, card(), 'request'));
    expect(await rejection(images.generateNow(id!))).toEqual({ status: 502, code: 'picture_failed', message: PICTURE_MESSAGES.portraitSafety });
    expect(await load(id!)).toMatchObject({ status: 'failed', message: PICTURE_MESSAGES.portraitSafety });

    const busy = service({ fail: () => new ProviderError('http_error', 'Sogni', 429) }).images;
    const second = await transaction(pool, client => busy.reserve(client, card(), 'request'));
    expect(await rejection(busy.generateNow(second!))).toEqual({ status: 503, code: 'pictures_busy', message: PICTURE_MESSAGES.busy });
  });

  it('reports a picture that is no longer being made as a failure', async () => {
    const { images, provider } = service();
    const id = await transaction(pool, client => images.reserve(client, card(), 'request'));
    await pool.query("UPDATE images SET status='cancelled' WHERE id=$1", [id]);
    expect(await rejection(images.generateNow(id!))).toEqual({ status: 502, code: 'picture_failed', message: PICTURE_MESSAGES.cardFailed });
    expect(await rejection(images.generateNow(randomUUID()))).toEqual({ status: 502, code: 'picture_failed', message: PICTURE_MESSAGES.cardFailed });
    expect(provider.requests).toHaveLength(0);
  });

  it('cancels a held picture on close, returns promptly and then refuses new work', async () => {
    const { images, provider } = service({ hold: () => new Promise<void>(() => undefined) });
    const current = await state();
    const sceneId = await reserveScene(images, current);
    const portrait = await transaction(pool, client => images.reserve(client, card(), 'request'));
    images.run([sceneId!]);
    const waiting = images.generateNow(portrait!).then(() => null, (error: unknown) => error);
    await waitFor(() => provider.requests.length === 2, 'both pictures to reach the service');
    const started = Date.now();
    await images.close();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await statusOf(sceneId!)).toBe('cancelled');
    expect(await statusOf(portrait!)).toBe('cancelled');
    expect(await waiting).toBeInstanceOf(AppError);
    const settled = await rows();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await rows()).toEqual(settled);

    expect(await reserveScene(images, current)).toBeNull();
    expect(await rejection(transaction(pool, client => images.reserve(client, card(), 'request')))).toEqual({ status: 503, code: 'pictures_busy', message: PICTURE_MESSAGES.busy });
    expect(await rejection(images.generateNow(portrait!))).toEqual({ status: 503, code: 'pictures_busy', message: PICTURE_MESSAGES.busy });
    images.run([portrait!]);
    expect(provider.requests).toHaveLength(2);
  });

  it('exposes the provider model as the default and none when pictures are off', () => {
    expect(service().images.defaultModel).toBe('fake-image');
    expect(service(null).images.defaultModel).toBeNull();
  });

  it('draws place pictures and portraits with the show\'s saved style and model', async () => {
    const { images, provider } = service();
    const model = PICTURE_MODELS[1]!.id;
    await pool.query('UPDATE sessions SET picture_settings=$2::jsonb WHERE id=$1', [sessionId, JSON.stringify({ style: 'Ink and brass engraving', model })]);
    const current = await state();
    const npc = current.npcs.find(candidate => candidate.appearance.trim() || candidate.role.trim())!;
    const sceneId = await reserveScene(images, current);
    const portraitId = await transaction(pool, client => images.reserveNpcPortrait(client, current, npc.id, host));
    for (const id of [sceneId!, portraitId!]) {
      const row = await load(id);
      expect(row.model).toBe(model);
      expect(row.prompt.startsWith('Ink and brass engraving.')).toBe(true);
    }
    images.run([sceneId!, portraitId!]);
    await waitFor(() => provider.requests.length === 2, 'both pictures');
    for (const request of provider.requests) expect(request.model).toBe(model);
  });

  it('falls back to the provider model and the brief style when nothing is saved', async () => {
    const { images } = service();
    const current = await state();
    current.session.brief = { premise: 'p', genre: 'mystery', tone: 'quiet', objectives: [], playerHooks: [], pacing: { conversationWords: 90, actionWords: 120 }, pictureStyle: 'Gouache poster' };
    const id = await reserveScene(images, current);
    expect(await load(id!)).toMatchObject({ model: 'fake-image' });
    expect((await load(id!)).prompt.startsWith('Gouache poster.')).toBe(true);
    await pool.query('UPDATE sessions SET picture_settings=$2::jsonb WHERE id=$1', [sessionId, JSON.stringify({ style: '', model: 'not-on-the-list' })]);
    const second = await reserveScene(images, current);
    expect(await load(second!)).toMatchObject({ model: 'fake-image' });
    expect((await load(second!)).prompt.startsWith('Gouache poster.')).toBe(true);
  });

  describe('start over', () => {
    async function seed(fields: { status?: string; sceneId?: string; beatId?: string | null; released?: boolean; purpose?: string }) {
      const current = await state();
      const id = randomUUID();
      await pool.query(
        `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, status, prompt, width, height, provider, model, requested_by, beat_id, released_at, file_hash, content_type, byte_length)
         VALUES($1,$2,$3,$4,$5,$6,$7,'a picture',1344,768,'fake','fake-image',$2,$8, CASE WHEN $9::boolean THEN clock_timestamp() END,
           CASE WHEN $7='ready' THEN repeat('a', 64) END, CASE WHEN $7='ready' THEN 'image/png' END, CASE WHEN $7='ready' THEN 100 END)`,
        [id, ownerId, sessionId, fields.purpose ?? 'scene', fields.sceneId ?? current.session.scene.id, `scene:${sessionId}`, fields.status ?? 'making', fields.beatId ?? null, fields.released ?? false]);
      return id;
    }
    const startOver = (images: ImageService, sceneId?: string) =>
      transaction(pool, async client => images.startOver(client, sessionId, sceneId ?? (await state()).session.scene.id));

    it('cancels this scene\'s released pictures still being made and nothing else', async () => {
      const { images } = service();
      const placeId = await seed({});
      const releasedRound = await seed({ beatId: 'round-1', released: true });
      const heldRound = await seed({ beatId: 'round-2' });
      const readyId = await seed({ status: 'ready' });
      const otherScene = await seed({ sceneId: 'another-scene' });
      const portrait = await seed({ purpose: 'npc' });
      await startOver(images);
      for (const id of [placeId, releasedRound]) {
        expect(await load(id)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.startedOver });
        expect((await load(id)).finished_at).toBeInstanceOf(Date);
      }
      for (const [id, status] of [[heldRound, 'making'], [readyId, 'ready'], [otherScene, 'making'], [portrait, 'making']] as const) {
        expect(await load(id)).toMatchObject({ status, message: null });
      }
    });

    it('does nothing with pictures off or after close', async () => {
      const id = await seed({});
      await startOver(service(null).images);
      expect(await statusOf(id)).toBe('making');
      const closed = service().images;
      await closed.close();
      await startOver(closed);
      expect(await statusOf(id)).toBe('making');
    });

    it('stops a running picture only once the transaction commits', async () => {
      const gate = deferred();
      const { images, provider } = service({ hold: () => gate.promise });
      const current = await state();
      const id = await reserveScene(images, current);
      images.run([id!]);
      await waitFor(() => provider.requests.length === 1, 'the picture to reach the service');
      await expect(transaction(pool, async (client) => {
        await images.startOver(client, sessionId, current.session.scene.id);
        expect((await client.query('SELECT status FROM images WHERE id=$1', [id])).rows[0].status).toBe('cancelled');
        throw new Error('the command failed');
      })).rejects.toThrow('the command failed');
      expect(await statusOf(id!)).toBe('making');
      await new Promise(resolve => setTimeout(resolve, 150));
      gate.resolve();
      await waitFor(async () => await statusOf(id!) === 'ready', 'the picture the rollback kept');

      const second = deferred();
      const held = service({ hold: () => second.promise });
      const next = await reserveScene(held.images, current);
      held.images.run([next!]);
      await waitFor(() => held.provider.requests.length === 1, 'the second picture to reach the service');
      const stopped = held.provider.requests[0]!.signal;
      await startOver(held.images, current.session.scene.id);
      await waitFor(() => stopped?.aborted === true, 'the call to be stopped');
      expect(await load(next!)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.startedOver });
      second.resolve();
    });
  });

  it('sends the picture service public details only, with every name removed', async () => {
    const { images, provider } = service();
    const current = await state();
    const sentinel = (field: string) => `SECRET-${field}`;
    current.directorNotes = sentinel('director-notes');
    current.session.brief = { premise: sentinel('premise'), genre: 'mystery', tone: 'quiet', objectives: [sentinel('objective')], playerHooks: [], pacing: { conversationWords: 90, actionWords: 120 }, pictureStyle: 'Ink wash' };
    for (const location of current.locations) location.description = sentinel('location');
    for (const fact of current.facts) fact.text = sentinel('fact');
    for (const character of current.characters) Object.assign(character, { secret: sentinel('secret'), backstory: sentinel('backstory'), connection: sentinel('connection'), flaw: sentinel('flaw'), personality: sentinel('personality') });
    const npc = current.npcs[0]!;
    Object.assign(npc, {
      displayName: 'Mara Quill', aliases: ['The Widow'], role: 'harbor pilot', appearance: 'Mara Quill wears a salt-stained coat; The Widow hides a scar.',
      secrets: [sentinel('npc-secret')], hiddenIdentity: sentinel('identity'), motivation: sentinel('motivation'), goal: sentinel('goal'),
      personality: [sentinel('npc-personality')], limits: [sentinel('limits')], dialogueExamples: [sentinel('dialogue')], mood: sentinel('mood'),
    });
    current.session.scene.title = "Mara's Landing";
    current.session.scene.description = 'Fog rolls over the docks where Quill waits.';
    const names = [...current.characters.map(character => character.displayName), ...current.npcs.flatMap(other => [other.displayName, ...other.aliases])];
    const sceneId = await reserveScene(images, current);
    const portraitId = await transaction(pool, client => images.reserveNpcPortrait(client, current, npc.id, host));
    images.run([sceneId!, portraitId!]);
    await waitFor(() => provider.requests.length === 2, 'both prompts');
    for (const { prompt } of provider.requests) {
      expect(prompt).not.toContain('SECRET-');
      for (const name of names) expect(prompt).not.toContain(name);
      expect(prompt).not.toContain('Quill');
      expect(prompt).toContain('Ink wash');
    }
    const scene = provider.requests.find(request => request.title === 'Scene picture')!.prompt;
    const portrait = provider.requests.find(request => request.title === 'Portrait')!.prompt;
    expect(scene).toContain("someone's Landing");
    expect(scene).toContain('Fog rolls over the docks');
    expect(portrait).toContain('harbor pilot');
    expect(portrait).toContain('salt-stained coat');
  });
});
