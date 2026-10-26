import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOMENT_MODEL, MOMENT_PROMPT_MAX, PICTURE_MODELS, PICTURE_NEGATIVE_PROMPT, imageTypeOf, type AiProvider, type PictureMoment } from '@rpg/contracts';
import { ProviderError } from '@rpg/providers';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeImageProvider, fakeImageBytes, type FakeImageOptions } from '../src/fake-images';
import { FAKE_PICTURE_DESCRIPTION, FakeAiProvider } from '../src/fake-provider';
import { storeImage } from '../src/image-files';
import { failUnstarted, runImageJob, type ImageJobContext } from '../src/image-jobs';
import { ImageSlots } from '../src/image-slots';
import { PICTURE_MESSAGES } from '../src/picture-limits';
import { MOMENT_CLOSING_REFERENCES, MOMENT_CLOSING_WORDS, cleanDescription, descriptionBudget, fallbackDescription, momentPrompt } from '../src/picture-prompts';
import type { ImageRow } from '../src/picture-views';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'image-jobs-test-host-credential';
const PROMPT = 'PROMPT-SENTINEL a quiet harbor at dusk, Painterly digital illustration';

type Fields = Partial<Pick<ImageRow, 'session_id' | 'purpose' | 'subject_id' | 'attach' | 'status' | 'width' | 'height' | 'beat_id' | 'model' | 'moment'>> & { secondsAgo?: number; released?: boolean };
const WORDS_MODEL = PICTURE_MODELS.find(model => model.id !== MOMENT_MODEL)!.id;
const STYLE = 'Bold black-ink comic book art';

suite('background picture job', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  let sessionId: string, ownerId: string, sceneId: string, npcIds: string[];
  let clock: number;

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const post = (url: string, payload: Record<string, unknown>, credential = '') => app.inject({ method: 'POST', url, headers: { origin, ...(credential ? { cookie: credential } : {}) }, payload });
  // Rows are created a second apart so "newest" is explicit.
  async function insert(fields: Fields = {}) {
    const id = randomUUID();
    const purpose = fields.purpose ?? 'scene';
    const row = {
      session_id: sessionId as string | null, subject_id: purpose === 'scene' ? sceneId : npcIds[0]!, attach: purpose === 'npc',
      status: 'making', width: purpose === 'scene' ? 1344 : 768, height: 768, ...fields, purpose,
    };
    const offset = fields.secondsAgo !== undefined ? -fields.secondsAgo : clock++;
    await pool.query(
      `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, attach, status, prompt, width, height, provider, model, requested_by, created_at, beat_id, released_at, moment)
       VALUES($1,$2,$3,$4,$5,'test-limit',$6,$7,$8,$9,$10,'fake',$14,$2, clock_timestamp() + $11 * interval '1 second', $12::text, CASE WHEN $13::boolean THEN clock_timestamp() END, $15::jsonb)`,
      [id, ownerId, row.session_id, purpose, row.subject_id, row.attach, row.status, PROMPT, row.width, row.height, offset, fields.beat_id ?? null, fields.released ?? false,
        fields.model ?? 'fake-image', fields.moment ? JSON.stringify(fields.moment) : null]);
    return id;
  }
  // A ready portrait row; without a file its hash points at nothing on disk.
  async function insertPortrait(withFile = true) {
    const id = randomUUID();
    const bytes = fakeImageBytes({ prompt: id, width: 256, height: 256 });
    const file = withFile ? await storeImage(assetDir, bytes) : { fileHash: 'a'.repeat(64), contentType: 'image/png', byteLength: bytes.byteLength };
    await pool.query(
      `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, attach, status, prompt, width, height, provider, model, requested_by, file_hash, content_type, byte_length, finished_at)
       VALUES($1,$2,$3,'npc',$4,'test-limit',false,'ready','A portrait',768,768,'fake','fake-image',$2,$5,$6,$7,clock_timestamp())`,
      [id, ownerId, sessionId, npcIds[0], file.fileHash, file.contentType, file.byteLength]);
    return id;
  }
  // Each person is { portraitId, imageNumber } as reserved; the names list carries every name, as the reservation writes it.
  function momentOf(cast: { portraitId: string | null; imageNumber: number | null }[], model = WORDS_MODEL): PictureMoment {
    const names = cast.map((_, index) => `Sailor${'ABCDEFGHIJKL'[index]}`);
    return {
      style: STYLE, model,
      scene: { title: 'The Salt Quay', description: 'Wet stone and nets.', place: 'The harbor' },
      lines: [{ kind: 'narration', speaker: null, text: `${names[0] ?? 'Someone'} leaps the gap between the boats.` }],
      cast: cast.map((person, index) => ({
        name: names[index]!, appearance: `A sailor with a ${['red', 'blue', 'green', 'gold', 'grey'][index % 5]} scarf`, role: 'a deckhand', pronouns: 'she/her', ...person,
      })),
      names,
    };
  }
  const settled = (moment: PictureMoment, numbers: (number | null)[]): PictureMoment => ({
    ...moment, cast: moment.cast.map((person, index) => ({ ...person, imageNumber: numbers[index]!, portraitId: numbers[index] === null ? null : person.portraitId })),
  });
  // Beat ids are unique across sessions; the unique index allows one open round per session, so a test makes at most one.
  async function insertBeat(phase: string) {
    const id = randomUUID();
    await pool.query("INSERT INTO beats(id, session_id, kind, phase, data) VALUES($1,$2,'action',$3,'{}')", [id, sessionId, phase]);
    return id;
  }
  const load = async (id: string) => (await pool.query<ImageRow>('SELECT * FROM images WHERE id=$1', [id])).rows[0]!;
  const events = async () => (await pool.query<{ kind: string; actor_id: string; data: Record<string, unknown> }>(
    "SELECT kind, actor_id, data FROM audit_events WHERE session_id=$1 AND kind LIKE ANY(ARRAY['picture.%','portrait.%']) ORDER BY sequence", [sessionId])).rows;
  const versions = async () => ({
    session: (await pool.query('SELECT version FROM sessions WHERE id=$1', [sessionId])).rows[0].version as number,
    npcs: (await pool.query('SELECT id, version FROM npcs WHERE session_id=$1 ORDER BY id', [sessionId])).rows,
  });
  const npcData = async (id: string) => (await pool.query('SELECT data FROM npcs WHERE session_id=$1 AND id=$2', [sessionId, id])).rows[0].data;
  function setup(options: FakeImageOptions = {}, overrides: Partial<ImageJobContext> = {}) {
    const provider = new FakeImageProvider(options);
    const context: ImageJobContext = { pool, provider, assetDir, slots: new ImageSlots(4), ...overrides };
    return { provider, context, run: (id: string, signal = new AbortController().signal) => runImageJob(context, id, signal) };
  }

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
  });
  beforeEach(async () => {
    clock = 0;
    assetDir = await mkdtemp(join(tmpdir(), 'rpg-image-jobs-'));
    const host = cookie(await post('/api/auth/host', { token: hostToken }));
    const created = (await post('/api/sessions', { commandId: randomUUID() }, host)).json();
    sessionId = created.sessionId;
    const row = (await pool.query('SELECT owner_id, scene FROM sessions WHERE id=$1', [sessionId])).rows[0];
    ownerId = row.owner_id; sceneId = row.scene.id;
    npcIds = (await pool.query('SELECT id FROM npcs WHERE session_id=$1 ORDER BY ordinal', [sessionId])).rows.map(npc => npc.id);
    expect(npcIds.length).toBeGreaterThan(1);
  });
  afterEach(async () => { await rm(assetDir, { recursive: true, force: true }); });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  it('makes a scene picture, stores the file and tells everyone without touching the game state', async () => {
    const before = await versions();
    const id = await insert();
    const { provider, run } = setup();
    expect(await run(id)).toEqual({ status: 'ready' });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({ prompt: PROMPT, negativePrompt: PICTURE_NEGATIVE_PROMPT, width: 1344, height: 768, requestId: id, title: 'Scene picture' });
    const row = await load(id);
    expect(row).toMatchObject({ status: 'ready', content_type: 'image/png', workflow_id: `fake-${id}`, message: null });
    expect(row.started_at).toBeInstanceOf(Date);
    expect(row.finished_at).toBeInstanceOf(Date);
    const bytes = await readFile(join(assetDir, 'images', `${row.file_hash}.png`));
    expect(imageTypeOf(bytes)).toBe('image/png');
    expect(bytes.byteLength).toBe(row.byte_length);
    expect(await events()).toEqual([{ kind: 'picture.ready', actor_id: ownerId, data: { imageId: id, purpose: 'scene', subjectId: sceneId } }]);
    expect(await versions()).toEqual(before);
  });

  it('cancels a held picture of an aborted or unreleased published round without calling the service', async () => {
    const aborted = await insert({ beat_id: await insertBeat('aborted') });
    const published = await insert({ beat_id: await insertBeat('published') });
    const { provider, run } = setup();
    for (const id of [aborted, published]) {
      expect(await run(id)).toEqual({ status: 'cancelled', httpStatus: 409, code: 'conflict', message: PICTURE_MESSAGES.actionSuperseded });
      expect(await load(id)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.actionSuperseded, started_at: null });
    }
    expect(provider.requests).toHaveLength(0);
  });

  it('makes a released picture of a published round and a held picture of an open round, titled Action picture', async () => {
    const released = await insert({ beat_id: await insertBeat('published'), released: true });
    const { provider, run } = setup();
    expect(await run(released)).toEqual({ status: 'ready' });
    const held = await insert({ beat_id: await insertBeat('draft_review') });
    expect(await run(held)).toEqual({ status: 'ready' });
    expect(provider.requests.map(request => request.title)).toEqual(['Action picture', 'Action picture']);
    expect(await load(held)).toMatchObject({ status: 'ready', released_at: null });
  });

  it('makes a held picture whose round has no row, and still titles a plain scene picture Scene picture', async () => {
    const held = await insert({ beat_id: 'a-beat-without-a-row' });
    const plain = await insert();
    const { provider, run } = setup();
    expect(await run(held)).toEqual({ status: 'ready' });
    expect(await run(plain)).toEqual({ status: 'ready' });
    expect(provider.requests.map(request => request.title)).toEqual(['Action picture', 'Scene picture']);
  });

  it('skips a row that is no longer being made', async () => {
    const id = await insert({ status: 'failed' });
    const { provider, run } = setup();
    expect(await run(id)).toEqual({ status: 'skipped' });
    expect(await run(randomUUID())).toEqual({ status: 'skipped' });
    expect(provider.requests).toHaveLength(0);
  });

  it('cancels a scene picture without calling the service when the scene has changed', async () => {
    const id = await insert({ subject_id: 'an-older-scene' });
    const { provider, run } = setup();
    expect(await run(id)).toEqual({ status: 'cancelled', httpStatus: 409, code: 'conflict', message: PICTURE_MESSAGES.superseded });
    expect(provider.requests).toHaveLength(0);
    expect(await load(id)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.superseded, started_at: null });
    expect((await load(id)).finished_at).toBeInstanceOf(Date);
  });

  it('cancels a scene picture without calling the service when the session has ended', async () => {
    const id = await insert();
    await pool.query("UPDATE sessions SET status='ended' WHERE id=$1", [sessionId]);
    const { provider, run } = setup();
    expect(await run(id)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.superseded });
    expect(provider.requests).toHaveLength(0);
    expect(await load(id)).toMatchObject({ status: 'cancelled', started_at: null });
  });

  it('attaches a finished portrait to its non-player character without changing any version', async () => {
    const before = await versions();
    const id = await insert({ purpose: 'npc', subject_id: npcIds[0] });
    const { provider, run } = setup();
    expect(await run(id)).toEqual({ status: 'ready' });
    expect(provider.requests[0]).toMatchObject({ width: 768, height: 768, title: 'Portrait', negativePrompt: PICTURE_NEGATIVE_PROMPT });
    expect((await npcData(npcIds[0]!)).portraitId).toBe(id);
    expect((await npcData(npcIds[1]!)).portraitId).toBeUndefined();
    expect(await events()).toEqual([{ kind: 'portrait.ready', actor_id: ownerId, data: { imageId: id, purpose: 'npc', subjectId: npcIds[0] } }]);
    expect(await versions()).toEqual(before);
  });

  it('lets the newest portrait request win even when an older one finishes last', async () => {
    const older = await insert({ purpose: 'npc', subject_id: npcIds[0] });
    const newer = await insert({ purpose: 'npc', subject_id: npcIds[0] });
    const { run } = setup();
    expect(await run(newer)).toEqual({ status: 'ready' });
    expect(await run(older)).toEqual({ status: 'ready' });
    expect((await npcData(npcIds[0]!)).portraitId).toBe(newer);
    expect((await load(older)).status).toBe('ready');
    expect((await events()).map(event => event.data.imageId)).toEqual([newer]);
  });

  it('does not attach a portrait that was removed while it was being made', async () => {
    const id = await insert({ purpose: 'npc', subject_id: npcIds[0] });
    await pool.query('UPDATE images SET attach=false WHERE id=$1', [id]);
    const { run } = setup();
    expect(await run(id)).toEqual({ status: 'ready' });
    expect((await npcData(npcIds[0]!)).portraitId).toBeUndefined();
    expect(await events()).toEqual([]);
  });

  it('cancels a portrait for a character who is no longer in the show without calling the service', async () => {
    const id = await insert({ purpose: 'npc', subject_id: 'a-character-who-left' });
    const { provider, run } = setup();
    expect(await run(id)).toEqual({ status: 'cancelled', httpStatus: 404, code: 'not_found', message: 'That character is not in this session.' });
    expect(provider.requests).toHaveLength(0);
    expect(await load(id)).toMatchObject({ status: 'cancelled', started_at: null });
  });

  it('makes seat and library portraits ready without events or attaching anything', async () => {
    const seat = await insert({ purpose: 'character', subject_id: 'some-character', attach: false });
    const library = await insert({ purpose: 'card', session_id: null, subject_id: 'editor-key', attach: false });
    const { run } = setup();
    expect(await run(seat)).toEqual({ status: 'ready' });
    expect(await run(library)).toEqual({ status: 'ready' });
    expect((await load(library)).status).toBe('ready');
    expect(await events()).toEqual([]);
  });

  it('stores the plain sentence for each kind of failure and tells the director', async () => {
    const scene = await insert();
    const npc = await insert({ purpose: 'npc', subject_id: npcIds[1] });
    const card = await insert({ purpose: 'card', session_id: null, subject_id: 'editor-key', attach: false });
    const failures: Record<string, ProviderError> = {
      [scene]: new ProviderError('invalid_response', 'Sogni', undefined, 'safety'),
      [npc]: new ProviderError('http_error', 'Sogni', 500),
      [card]: new ProviderError('http_error', 'Sogni', 402),
    };
    const { run } = setup({ fail: request => failures[request.requestId] ?? null });
    expect(await run(scene)).toEqual({ status: 'failed', httpStatus: 502, code: 'picture_failed', message: PICTURE_MESSAGES.sceneSafety });
    expect(await run(npc)).toEqual({ status: 'failed', httpStatus: 502, code: 'picture_failed', message: PICTURE_MESSAGES.npcFailed });
    expect(await run(card)).toEqual({ status: 'failed', httpStatus: 502, code: 'picture_failed', message: PICTURE_MESSAGES.credit });
    expect(await load(scene)).toMatchObject({ status: 'failed', message: PICTURE_MESSAGES.sceneSafety, file_hash: null });
    expect((await load(scene)).started_at).toBeInstanceOf(Date);
    expect((await load(scene)).finished_at).toBeInstanceOf(Date);
    expect(await load(npc)).toMatchObject({ status: 'failed', message: PICTURE_MESSAGES.npcFailed });
    expect(await load(card)).toMatchObject({ status: 'failed', message: PICTURE_MESSAGES.credit });
    expect((await npcData(npcIds[1]!)).portraitId).toBeUndefined();
    expect(await events()).toEqual([
      { kind: 'picture.failed', actor_id: ownerId, data: { imageId: scene, purpose: 'scene', subjectId: sceneId } },
      { kind: 'portrait.failed', actor_id: ownerId, data: { imageId: npc, purpose: 'npc', subjectId: npcIds[1] } },
    ]);
  });

  it('answers busy when the picture service is busy', async () => {
    const id = await insert();
    const { run } = setup({ fail: () => new ProviderError('http_error', 'Sogni', 429) });
    expect(await run(id)).toEqual({ status: 'failed', httpStatus: 503, code: 'pictures_busy', message: PICTURE_MESSAGES.busy });
  });

  it('ends cancelled when the job is stopped while the picture is being made', async () => {
    const id = await insert({ purpose: 'card', session_id: null, subject_id: 'editor-key', attach: false });
    let reached!: () => void;
    const atService = new Promise<void>(resolve => { reached = resolve; });
    const { run } = setup({ hold: () => { reached(); return new Promise<void>(() => {}); } });
    const controller = new AbortController();
    const pending = run(id, controller.signal);
    await atService;
    controller.abort();
    expect(await pending).toEqual({ status: 'cancelled', httpStatus: 502, code: 'picture_failed', message: PICTURE_MESSAGES.cardFailed });
    expect(await load(id)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.cardFailed });
  });

  it('reads as superseded when a scene picture is stopped because the scene changed', async () => {
    const id = await insert();
    let reached!: () => void;
    const atService = new Promise<void>(resolve => { reached = resolve; });
    const { run } = setup({ hold: () => { reached(); return new Promise<void>(() => {}); } });
    const controller = new AbortController();
    const pending = run(id, controller.signal);
    await atService;
    await pool.query("UPDATE sessions SET scene=jsonb_set(scene, '{id}', to_jsonb('the-next-scene'::text)) WHERE id=$1", [sessionId]);
    controller.abort();
    expect(await pending).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.superseded });
    expect(await load(id)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.superseded });
  });

  it('ends cancelled without calling the service when stopped while waiting for a slot', async () => {
    const id = await insert();
    const slots = new ImageSlots(1);
    const holder = await slots.acquire('normal');
    const { provider, run } = setup({}, { slots });
    const controller = new AbortController();
    const pending = run(id, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ status: 'cancelled' });
    expect(provider.requests).toHaveLength(0);
    expect(await load(id)).toMatchObject({ status: 'cancelled', started_at: null });
    holder();
  });

  it('waits for a slot with no deadline while the picture is still wanted, and gives the slot back afterwards', async () => {
    const slots = new ImageSlots(1);
    const holder = await slots.acquire('normal');
    const id = await insert({ secondsAgo: 120 });
    const { provider, run } = setup({}, { slots });
    const pending = run(id);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(provider.requests).toHaveLength(0);
    expect(await load(id)).toMatchObject({ status: 'making', started_at: null });
    holder();
    expect(await pending).toEqual({ status: 'ready' });
    expect(provider.requests).toHaveLength(1);
    // The finished job gave its slot back, so a fresh holder gets one at once.
    await expect(slots.acquire('normal')).resolves.toBeTypeOf('function');
  });

  it('gives the slot back after a failure too', async () => {
    const slots = new ImageSlots(1);
    const id = await insert();
    const { run } = setup({ fail: () => new ProviderError('timeout', 'Sogni') }, { slots });
    expect((await run(id)).status).toBe('failed');
    await expect(slots.acquire('normal')).resolves.toBeTypeOf('function');
  });

  it('never writes the prompt into an event', async () => {
    const ready = await insert();
    const failed = await insert({ purpose: 'npc', subject_id: npcIds[0] });
    const { run } = setup({ fail: request => request.requestId === failed ? new ProviderError('http_error', 'Sogni', 500) : null });
    await run(ready);
    await run(failed);
    const stored = await pool.query("SELECT data::text AS data FROM audit_events WHERE session_id=$1", [sessionId]);
    expect(stored.rows.length).toBeGreaterThan(0);
    for (const row of stored.rows) expect(row.data).not.toContain('PROMPT-SENTINEL');
  });
  it('passes the row model and the plain title for a place picture, with no references', async () => {
    const id = await insert({ model: WORDS_MODEL });
    const { provider, run } = setup({}, { ai: new FakeAiProvider() });
    expect(await run(id)).toEqual({ status: 'ready' });
    expect(provider.requests[0]).toMatchObject({ prompt: PROMPT, model: WORDS_MODEL, title: 'Scene picture', negativePrompt: PICTURE_NEGATIVE_PROMPT });
    expect(provider.requests[0]!.references).toBeUndefined();
    expect(provider.uploads).toEqual([]);
  });

  it('uploads the portraits, numbers the ones that uploaded and draws the beat from the story AI description', async () => {
    const portraits = [await insertPortrait(), await insertPortrait(), await insertPortrait()];
    const moment = momentOf([
      { portraitId: portraits[0]!, imageNumber: 1 }, { portraitId: portraits[1]!, imageNumber: 2 },
      { portraitId: null, imageNumber: null }, { portraitId: portraits[2]!, imageNumber: 3 },
    ]);
    const id = await insert({ moment, model: MOMENT_MODEL });
    const ai = new FakeAiProvider();
    const { provider, run } = setup({ failUpload: index => index === 1 }, { ai });
    expect(await run(id)).toEqual({ status: 'ready' });
    expect(provider.uploads).toEqual([{ requestId: id, count: 3 }]);
    const budget = descriptionBudget(STYLE, true);
    expect(ai.pictureRequests).toHaveLength(1);
    expect(ai.pictureRequests[0]!.budget).toBe(budget);
    expect(ai.pictureRequests[0]!.cast.map(person => person.imageNumber)).toEqual([1, null, null, 2]);
    const expected = momentPrompt(STYLE, FAKE_PICTURE_DESCRIPTION, true);
    expect(expected).toContain(FAKE_PICTURE_DESCRIPTION);
    expect(expected.endsWith(MOMENT_CLOSING_REFERENCES)).toBe(true);
    expect(provider.requests).toHaveLength(1);
    const request = provider.requests[0]!;
    expect(request).toMatchObject({ prompt: expected, model: MOMENT_MODEL, title: 'Beat picture', requestId: id });
    expect(request.references).toEqual([{ provider: 'fake', requestId: id, index: 0 }, { provider: 'fake', requestId: id, index: 2 }]);
    const row = await load(id);
    expect(row).toMatchObject({ status: 'ready', prompt: expected, model: MOMENT_MODEL, moment });
    expect(JSON.stringify(row)).not.toContain('"index"');
    expect(await events()).toEqual([{ kind: 'picture.ready', actor_id: ownerId, data: { imageId: id, purpose: 'scene', subjectId: sceneId } }]);
  });

  it('falls back to the moment description with the settled numbers when the story AI fails or answers nothing', async () => {
    const portraits = [await insertPortrait(), await insertPortrait()];
    const moment = momentOf([{ portraitId: portraits[0]!, imageNumber: 1 }, { portraitId: portraits[1]!, imageNumber: 2 }]);
    const fallback = momentPrompt(STYLE, fallbackDescription(settled(moment, [null, 1]), descriptionBudget(STYLE, true)), true);
    expect(fallback).toContain('the person from image 1');
    expect(fallback).not.toContain('image 2');
    const answers: Record<string, AiProvider> = {
      error: { describePicture: () => Promise.reject(new Error('the story AI is down')) } as unknown as AiProvider,
      empty: { describePicture: () => Promise.resolve('  \n ') } as unknown as AiProvider,
      missing: {} as AiProvider,
    };
    for (const [label, ai] of Object.entries(answers)) {
      const id = await insert({ moment, model: MOMENT_MODEL });
      const { provider, run } = setup({ failUpload: index => index === 0 }, { ai });
      expect(await run(id), label).toEqual({ status: 'ready' });
      expect(provider.requests[0], label).toMatchObject({ prompt: fallback, model: MOMENT_MODEL, title: 'Beat picture' });
      expect(provider.requests[0]!.references, label).toEqual([{ provider: 'fake', requestId: id, index: 1 }]);
      expect((await load(id)).prompt, label).toBe(fallback);
    }
  });

  it("takes the show's names out of the story AI description and cuts it to the budget before drawing", async () => {
    const moment = momentOf([{ portraitId: await insertPortrait(), imageNumber: 1 }, { portraitId: null, imageNumber: null }]);
    const reply = `SailorA grabs SailorB by the collar.\nThe person from image 1 shouts. ${'The deck tilts in the storm. '.repeat(400)}`;
    const id = await insert({ moment, model: MOMENT_MODEL });
    const { provider, run } = setup({}, { ai: { describePicture: () => Promise.resolve(reply) } as unknown as AiProvider });
    expect(await run(id)).toEqual({ status: 'ready' });
    const prompt = provider.requests[0]!.prompt;
    expect(prompt).toBe(momentPrompt(STYLE, cleanDescription(reply, moment.names, descriptionBudget(STYLE, true)), true));
    expect(prompt.startsWith(`${STYLE}. Someone grabs someone by the collar. The person from image 1 shouts. The deck tilts`)).toBe(true);
    for (const name of moment.names) expect(prompt).not.toContain(name);
    expect(prompt.length).toBeLessThanOrEqual(MOMENT_PROMPT_MAX);
    expect(prompt.endsWith(`storm. ${MOMENT_CLOSING_REFERENCES}`)).toBe(true);
    expect((await load(id)).prompt).toBe(prompt);
  });

  it('draws from words with the show model when nobody has a usable portrait, and records that model', async () => {
    const missing = await insertPortrait(false);
    const failing = await insertPortrait();
    const moment = momentOf([
      { portraitId: missing, imageNumber: 1 }, { portraitId: randomUUID(), imageNumber: 2 },
      { portraitId: failing, imageNumber: 3 }, { portraitId: null, imageNumber: null },
    ]);
    const id = await insert({ moment, model: MOMENT_MODEL });
    const ai = new FakeAiProvider();
    const { provider, run } = setup({ failUpload: () => true }, { ai });
    expect(await run(id)).toEqual({ status: 'ready' });
    expect(provider.uploads).toEqual([{ requestId: id, count: 1 }]);
    expect(ai.pictureRequests[0]!.cast.map(person => person.imageNumber)).toEqual([null, null, null, null]);
    expect(ai.pictureRequests[0]!.budget).toBe(descriptionBudget(STYLE, false));
    const expected = momentPrompt(STYLE, FAKE_PICTURE_DESCRIPTION, false);
    expect(expected.endsWith(MOMENT_CLOSING_WORDS)).toBe(true);
    expect(provider.requests[0]).toMatchObject({ prompt: expected, model: WORDS_MODEL, title: 'Beat picture', negativePrompt: PICTURE_NEGATIVE_PROMPT });
    expect(provider.requests[0]!.references).toBeUndefined();
    expect(await load(id)).toMatchObject({ status: 'ready', prompt: expected, model: WORDS_MODEL });
  });

  it('draws a person whose portrait file is missing from words and keeps the others numbered', async () => {
    const missing = await insertPortrait(false);
    const present = await insertPortrait();
    const moment = momentOf([{ portraitId: missing, imageNumber: 1 }, { portraitId: present, imageNumber: 2 }]);
    const id = await insert({ moment, model: MOMENT_MODEL });
    const ai = new FakeAiProvider();
    const { provider, run } = setup({}, { ai });
    expect(await run(id)).toEqual({ status: 'ready' });
    expect(provider.uploads).toEqual([{ requestId: id, count: 1 }]);
    expect(ai.pictureRequests[0]!.cast.map(person => person.imageNumber)).toEqual([null, 1]);
    expect(provider.requests[0]!.references).toEqual([{ provider: 'fake', requestId: id, index: 0 }]);
    expect(provider.requests[0]!.model).toBe(MOMENT_MODEL);
  });

  it('skips uploading when nobody in the beat has a portrait', async () => {
    const moment = momentOf([{ portraitId: null, imageNumber: null }]);
    const id = await insert({ moment, model: MOMENT_MODEL });
    const { provider, run } = setup({}, { ai: new FakeAiProvider() });
    expect(await run(id)).toEqual({ status: 'ready' });
    expect(provider.uploads).toEqual([]);
    expect(provider.requests[0]).toMatchObject({ model: WORDS_MODEL, prompt: momentPrompt(STYLE, FAKE_PICTURE_DESCRIPTION, false) });
  });

  it('stores the beat sentences when a beat picture fails, is refused, cannot be read or never started', async () => {
    const moment = momentOf([{ portraitId: null, imageNumber: null }]);
    const failed = await insert({ moment });
    const refused = await insert({ moment });
    const broken = await insert({ moment: { not: 'a moment' } as unknown as PictureMoment });
    const unstarted = await insert({ moment });
    const failures: Record<string, ProviderError> = {
      [failed]: new ProviderError('http_error', 'Sogni', 500),
      [refused]: new ProviderError('invalid_response', 'Sogni', undefined, 'safety'),
    };
    const { provider, context, run } = setup({ fail: request => failures[request.requestId] ?? null }, { ai: new FakeAiProvider() });
    expect(await run(failed)).toEqual({ status: 'failed', httpStatus: 502, code: 'picture_failed', message: PICTURE_MESSAGES.beatFailed });
    expect(await run(refused)).toEqual({ status: 'failed', httpStatus: 502, code: 'picture_failed', message: PICTURE_MESSAGES.beatSafety });
    expect(await run(broken)).toEqual({ status: 'failed', httpStatus: 502, code: 'picture_failed', message: PICTURE_MESSAGES.beatFailed });
    expect(provider.requests.map(request => request.requestId)).toEqual([failed, refused]);
    expect(await load(broken)).toMatchObject({ status: 'failed', message: PICTURE_MESSAGES.beatFailed, started_at: null, prompt: PROMPT });
    await failUnstarted(context, [unstarted]);
    expect(await load(unstarted)).toMatchObject({ status: 'failed', message: PICTURE_MESSAGES.beatFailed });
    expect(await load(failed)).toMatchObject({ status: 'failed', message: PICTURE_MESSAGES.beatFailed });
    expect((await events()).map(event => event.data.imageId)).toEqual([failed, refused, broken, unstarted]);
  });

  it('ends cancelled without calling the service when stopped while the story AI writes', async () => {
    const id = await insert({ moment: momentOf([{ portraitId: await insertPortrait(), imageNumber: 1 }]) });
    let reached!: () => void;
    const atAi = new Promise<void>(resolve => { reached = resolve; });
    const ai = { describePicture: () => { reached(); return new Promise<string>(() => {}); } } as unknown as AiProvider;
    const { provider, run } = setup({}, { ai });
    const controller = new AbortController();
    const pending = run(id, controller.signal);
    await atAi;
    controller.abort();
    expect(await pending).toEqual({ status: 'cancelled', httpStatus: 502, code: 'picture_failed', message: PICTURE_MESSAGES.beatFailed });
    expect(provider.requests).toHaveLength(0);
    expect(await load(id)).toMatchObject({ status: 'cancelled', started_at: null, prompt: PROMPT });
  });

  it('skips a beat picture that someone else finished while its description was written', async () => {
    const id = await insert({ moment: momentOf([{ portraitId: null, imageNumber: null }]) });
    const ai = { describePicture: async () => {
      await pool.query("UPDATE images SET status='cancelled', message=$2, finished_at=clock_timestamp() WHERE id=$1", [id, PICTURE_MESSAGES.startedOver]);
      return FAKE_PICTURE_DESCRIPTION;
    } } as unknown as AiProvider;
    const { provider, run } = setup({}, { ai });
    expect(await run(id)).toEqual({ status: 'skipped' });
    expect(provider.requests).toHaveLength(0);
    expect(await load(id)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.startedOver, prompt: PROMPT });
  });

  it('cancels a beat picture of a scene that changed before the uploads start', async () => {
    const id = await insert({ subject_id: 'an-older-scene', moment: momentOf([{ portraitId: await insertPortrait(), imageNumber: 1 }]) });
    const ai = new FakeAiProvider();
    const { provider, run } = setup({}, { ai });
    expect(await run(id)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.superseded });
    expect(provider.uploads).toEqual([]);
    expect(ai.pictureRequests).toEqual([]);
    expect(provider.requests).toHaveLength(0);
  });
});
