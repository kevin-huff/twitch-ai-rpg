import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOMENT_MODEL, PICTURE_MODELS, PictureMomentSchema, SCENE_PICTURE_SIZE, type Beat, type ScriptSegment, type SessionState } from '@rpg/contracts';
import { createLedgerState } from '@rpg/test-fixtures';
import { buildApp } from '../src/app';
import { createPool, transaction } from '../src/database';
import { FakeImageProvider } from '../src/fake-images';
import { ImageService } from '../src/images';
import { AppError, readState, type Actor } from '../src/repository';
import type { ImageRow } from '../src/picture-views';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'beat-picture-reservation-test-host-credential';
const NARRATION = 'Rain hammers the club windows while the ledger sits open on the bar.';
const SPOKEN = 'Nobody touches that ledger.';

suite('beat picture reservation', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  let sessionId: string, ownerId: string, host: Actor;
  const services: ImageService[] = [];

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const post = (url: string, payload: Record<string, unknown>, credential = '') => app.inject({ method: 'POST', url, headers: { origin, ...(credential ? { cookie: credential } : {}) }, payload });
  function service(withProvider = true) {
    const images = new ImageService({ pool, provider: withProvider ? new FakeImageProvider() : undefined, assetDir });
    services.push(images);
    return images;
  }
  const state = () => transaction(pool, client => readState(client, sessionId));
  const load = async (id: string) => (await pool.query<ImageRow>('SELECT * FROM images WHERE id=$1', [id])).rows[0]!;
  const reserve = (images: ImageService, current: SessionState, beatId: string) =>
    transaction(pool, client => images.reserveBeatPicture(client, current, beatId, host));

  function segment(kind: ScriptSegment['kind'], text: string, speaker: { entityId: string; displayName: string } | null = null): ScriptSegment {
    return { id: randomUUID(), kind, text, speaker, recipientCharacterIds: [], delivery: 'neutral', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false };
  }

  // The session's state with the fixture's four players added; the first three have a ready portrait and the fourth has none.
  async function withCast() {
    const current = await state();
    const players = createLedgerState(sessionId, () => randomUUID()).characters.map(character => ({ ...character }));
    for (const player of players.slice(0, 3)) {
      const portraitId = randomUUID();
      await pool.query(
        `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, status, prompt, width, height, provider, model, requested_by, file_hash, content_type, byte_length)
         VALUES($1,$2,$3,'character',$4,$5,'ready','a portrait',768,768,'fake','fake-image',$2,repeat('b', 64),'image/png',10)`,
        [portraitId, ownerId, sessionId, player.id, `character:${sessionId}:${player.id}`]);
      Object.assign(player, { portraitId });
    }
    current.characters.push(...players as unknown as SessionState['characters']);
    return { current, players };
  }

  async function publish(segments: ScriptSegment[], beatNumber = 1) {
    const id = `beat-published-${randomUUID()}`;
    const data = {
      id, sessionId, kind: 'conversation', phase: 'published', revision: 1, inputEpoch: 0, sourceStateRevision: 0, selectedSubmissionIds: [], lockedSubmissions: [],
      contracts: [], stakesApproved: true, classification: 'conversation', inputSnapshotHash: null, resolution: null, draft: null, draftRevision: 1,
      approvedContinuity: [], generation: 1, lastError: null,
    } as unknown as Beat;
    await pool.query("INSERT INTO beats(id,session_id,kind,phase,data) VALUES($1,$2,'conversation','published',$3)", [id, sessionId, data]);
    await pool.query('INSERT INTO published_beats(id,session_id,beat_number,data) VALUES($1,$2,$3,$4)', [id, sessionId, beatNumber, {
      id, kind: 'conversation', beatNumber, actionRoundNumber: 0, stateRevision: 0, publishedAt: new Date().toISOString(), segments, rolls: [], outcomes: [], textOnly: true,
    }]);
    return id;
  }

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM images');
    assetDir = await mkdtemp(join(tmpdir(), 'rpg-beat-picture-'));
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

  it('reserves a scene picture with no round tag, the cast from the published script and image numbers', async () => {
    const images = service();
    const { current, players } = await withCast();
    const [rook, lark, quill, pip] = players;
    const beatId = await publish([
      segment('narration', NARRATION),
      segment('player_dialogue', SPOKEN, { entityId: lark!.id, displayName: 'Lark' }),
      segment('player_dialogue', 'Fine by me.', { entityId: pip!.id, displayName: 'Pip' }),
      segment('player_dialogue', 'Agreed.', { entityId: rook!.id, displayName: 'Rook' }),
      segment('system', 'A hidden system note.'),
    ]);
    const id = await reserve(images, current, beatId);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const row = await load(id!);
    expect(row).toMatchObject({
      owner_id: ownerId, session_id: sessionId, purpose: 'scene', subject_id: current.session.scene.id, beat_id: null, released_at: null,
      limit_key: `scene:${sessionId}`, attach: false, status: 'making', hidden: false, requested_by: ownerId, started_at: null, model: MOMENT_MODEL,
      width: SCENE_PICTURE_SIZE.width, height: SCENE_PICTURE_SIZE.height,
    });
    const moment = PictureMomentSchema.parse(row.moment);
    expect(moment.cast.map(person => [person.name, person.imageNumber])).toEqual([['Lark', 1], ['Pip', null], ['Rook', 2]]);
    expect(moment.cast.map(person => person.portraitId)).toEqual([(lark as unknown as { portraitId: string }).portraitId, null, (rook as unknown as { portraitId: string }).portraitId]);
    expect(moment.lines.map(line => line.kind)).toEqual(['narration', 'player_dialogue', 'player_dialogue', 'player_dialogue']);
    expect(moment.cast.map(person => person.name)).not.toContain(quill!.displayName);
    expect(row.prompt).toContain('the person from image 2,');
    expect(row.prompt).not.toContain('image 3');
    expect(row.prompt).toContain('Rain hammers the club windows');
    expect(row.prompt).toMatch(/Everyone fully clothed\. No text, no letters\.$/);
  });

  it('draws from words with the show model when nobody in the beat has a ready portrait', async () => {
    const images = service();
    const current = await state();
    const chosen = PICTURE_MODELS[PICTURE_MODELS.length - 1]!.id;
    await pool.query('UPDATE sessions SET picture_settings=$2::jsonb WHERE id=$1', [sessionId, JSON.stringify({ style: 'Ink wash', model: chosen })]);
    const row = await load((await reserve(images, current, await publish([segment('narration', NARRATION)])))!);
    expect(row).toMatchObject({ model: chosen, beat_id: null });
    expect(row.moment).toMatchObject({ style: 'Ink wash', model: chosen, cast: [] });
    expect(row.prompt).toMatch(/^Ink wash\. /);
    expect(row.prompt).toMatch(/ Everyone fully clothed\. No text\.$/);
  });

  it('inherits the hidden flag of the scene', async () => {
    const images = service();
    const current = await state();
    const scene = await transaction(pool, client => images.reserveScene(client, current, host));
    await pool.query('UPDATE images SET hidden=true WHERE id=$1', [scene]);
    const id = await reserve(images, current, await publish([segment('narration', NARRATION)]));
    expect((await load(id!)).hidden).toBe(true);
  });

  it('answers 409 for a beat that is unknown, unpublished or in another session, and stores nothing', async () => {
    const images = service();
    const current = await state();
    const unpublished = `beat-never-published-${randomUUID()}`;
    await pool.query("INSERT INTO beats(id,session_id,kind,phase,data) VALUES($1,$2,'conversation','draft_review','{}')", [unpublished, sessionId]);
    const other = (await post('/api/sessions', { commandId: randomUUID() }, cookie(await post('/api/auth/host', { token: hostToken })))).json().sessionId;
    const foreign = `beat-in-another-session-${randomUUID()}`;
    await pool.query("INSERT INTO beats(id,session_id,kind,phase,data) VALUES($1,$2,'conversation','published','{}')", [foreign, other]);
    await pool.query('INSERT INTO published_beats(id,session_id,beat_number,data) VALUES($1,$2,1,$3)', [foreign, other, { segments: [] }]);
    for (const beatId of ['no-such-beat', unpublished, foreign]) {
      const error = await reserve(images, current, beatId).catch(caught => caught);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ status: 409, code: 'conflict', message: 'No beat has been published in this scene yet.' });
    }
    expect((await pool.query('SELECT count(*)::int AS count FROM images')).rows[0].count).toBe(0);
  });

  it('answers 503 when pictures are off', async () => {
    const current = await state();
    const error = await reserve(service(false), current, await publish([segment('narration', NARRATION)])).catch(caught => caught);
    expect(error).toMatchObject({ status: 503, code: 'pictures_off' });
  });
});
