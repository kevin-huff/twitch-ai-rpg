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
  const load = async (id: string) => (await pool.query<ImageRow>('SELECT * FROM images WHERE id=$1', [id])).rows[0]!;
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

  const edited = (moment: PictureMoment, index: number): PictureMoment => ({
    ...moment, cast: moment.cast.map((person, at) => (at === index ? { ...person, lookEdited: true as const } : person)),
  });

  it('ends the prompt with the changed-look closing for a numbered, look-edited person', async () => {
    const portraits = [await insertPortrait(), await insertPortrait()];
    const base = momentOf([{ portraitId: portraits[0]!, imageNumber: 1 }, { portraitId: portraits[1]!, imageNumber: 2 }]);
    const id = await insert({ moment: edited(base, 1), model: MOMENT_MODEL });
    const { provider, run } = setup({}, { ai: new FakeAiProvider() });
    expect(await run(id)).toEqual({ status: 'ready' });
    const expected = momentPrompt(STYLE, FAKE_PICTURE_DESCRIPTION, true, [2]);
    expect(expected).toContain('except the person from image 2, dressed as the words describe instead');
    const prompt = provider.requests[0]!.prompt;
    expect(prompt).toBe(expected);
    expect(prompt.endsWith('Everyone fully clothed. No text, no letters.')).toBe(true);
    expect(prompt.endsWith(MOMENT_CLOSING_REFERENCES)).toBe(false);
    expect(prompt.length).toBeLessThanOrEqual(MOMENT_PROMPT_MAX);
    expect((await load(id)).prompt).toBe(expected);
  });

  it('keeps today\'s closing when no one is look-edited', async () => {
    const portraits = [await insertPortrait(), await insertPortrait()];
    const base = momentOf([{ portraitId: portraits[0]!, imageNumber: 1 }, { portraitId: portraits[1]!, imageNumber: 2 }]);
    const id = await insert({ moment: base, model: MOMENT_MODEL });
    const { provider, run } = setup({}, { ai: new FakeAiProvider() });
    expect(await run(id)).toEqual({ status: 'ready' });
    const prompt = provider.requests[0]!.prompt;
    expect(prompt.endsWith(MOMENT_CLOSING_REFERENCES)).toBe(true);
    expect(prompt).toBe(momentPrompt(STYLE, FAKE_PICTURE_DESCRIPTION, true));
  });

  it('gives the unflagged prompt when the look-edited person\'s portrait fails to upload', async () => {
    const portraits = [await insertPortrait(), await insertPortrait()];
    const base = momentOf([{ portraitId: portraits[0]!, imageNumber: 1 }, { portraitId: portraits[1]!, imageNumber: 2 }]);
    const run1 = async (moment: PictureMoment) => {
      const id = await insert({ moment, model: MOMENT_MODEL });
      const { provider, run } = setup({ failUpload: index => index === 1 }, { ai: new FakeAiProvider() });
      expect(await run(id)).toEqual({ status: 'ready' });
      return provider.requests[0]!.prompt;
    };
    const flagged = await run1(edited(base, 1));
    const plain = await run1(base);
    expect(flagged).toBe(plain);
    expect(flagged.endsWith(MOMENT_CLOSING_REFERENCES)).toBe(true);
  });
});
