import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOMENT_MODEL, PICTURE_MODELS, PictureMomentSchema, type AiDraft, type Beat, type SessionState } from '@rpg/contracts';
import { createLedgerState } from '@rpg/test-fixtures';
import { buildApp } from '../src/app';
import { createPool, transaction } from '../src/database';
import { FakeImageProvider, type FakeImageOptions } from '../src/fake-images';
import { ImageService, PICTURE_MESSAGES, type ImageServiceOptions } from '../src/images';
import { readState, type Actor } from '../src/repository';
import type { ImageRow } from '../src/picture-views';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'action-pictures-test-host-credential';
const NARRATION = 'The cellar door bursts open and dust falls from the beams.';
const DIALOGUE = 'Nobody leaves this cellar tonight.';

suite('action pictures', () => {
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
  const draft = (narration = NARRATION, speakerNpcId = 'npc-guard'): AiDraft => ({
    segments: [
      ...(narration ? [{ kind: 'narration' as const, text: narration, recipientCharacterIds: [], delivery: 'neutral' as const }] : []),
      { kind: 'npc_dialogue', speakerNpcId, text: DIALOGUE, recipientCharacterIds: [], delivery: 'urgent' },
    ],
    continuity: [], directorSummary: '',
  });
  const beat = (fields: Partial<Beat> = {}): Beat => ({
    id: 'beat-action-1', sessionId, kind: 'action', phase: 'draft_review', revision: 1, inputEpoch: 0, sourceStateRevision: 0,
    selectedSubmissionIds: [], lockedSubmissions: [], contracts: [], stakesApproved: true, classification: 'action',
    inputSnapshotHash: null, resolution: null, draft: draft(), draftRevision: 1, approvedContinuity: [], generation: 1, lastError: null,
    ...fields,
  });
  const reserveAction = (images: ImageService, current: SessionState, round: Beat) =>
    transaction(pool, client => images.reserveActionPicture(client, current, round, host));
  const release = (images: ImageService, beatId = 'beat-action-1') =>
    transaction(pool, client => images.releaseActionPicture(client, sessionId, beatId));

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM images');
    assetDir = await mkdtemp(join(tmpdir(), 'rpg-action-pictures-'));
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

  it('reserves a held scene picture for the round, drawn from the narration only', async () => {
    const { images } = service();
    const current = await state();
    const id = await reserveAction(images, current, beat({ draft: draft(NARRATION, current.npcs[0]?.id ?? 'npc-guard') }));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const row = await load(id!);
    expect(row).toMatchObject({
      owner_id: ownerId, session_id: sessionId, purpose: 'scene', subject_id: current.session.scene.id, beat_id: 'beat-action-1',
      released_at: null, limit_key: `scene:${sessionId}`, attach: false, status: 'making', hidden: false, width: 1344, height: 768,
      requested_by: ownerId, started_at: null,
    });
    expect(row.prompt).toContain('A single dramatic moment in a story');
    expect(row.prompt).toContain('dust falls from the beams.');
    expect(row.prompt).not.toContain(DIALOGUE);
    expect(row.prompt).toMatch(/ Everyone fully clothed\. No text\.$/);
  });

  // The session's own state with the fixture's four players added, each with a ready portrait unless named in `without`.
  async function withCast(without: string[] = []) {
    const current = await state();
    const players = createLedgerState(sessionId, () => randomUUID()).characters.map(character => ({ ...character }));
    const portraits = new Map<string, string>();
    for (const player of players) {
      if (without.includes(player.displayName)) continue;
      const portraitId = randomUUID();
      await pool.query(
        `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, status, prompt, width, height, provider, model, requested_by, file_hash, content_type, byte_length)
         VALUES($1,$2,$3,'character',$4,$5,'ready','a portrait',768,768,'fake','fake-image',$2,repeat('b', 64),'image/png',10)`,
        [portraitId, ownerId, sessionId, player.id, `character:${sessionId}:${player.id}`]);
      Object.assign(player, { portraitId });
      portraits.set(player.displayName, portraitId);
    }
    current.characters.push(...players as unknown as SessionState['characters']);
    const said = (player: (typeof players)[number]) => ({
      id: randomUUID(), sessionId, characterId: player.id, beatId: 'beat-action-1', revision: 1, kind: 'say', text: `${player.displayName} speaks up.`,
      recipientNpcIds: [], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: false, status: 'locked',
    }) as unknown as Beat['lockedSubmissions'][number];
    return { current, portraits, lockedSubmissions: players.slice(0, 3).map(said) };
  }

  it('stores the moment with the fallback prompt for the round in review', async () => {
    const { images } = service();
    const { current, lockedSubmissions } = await withCast(['Lark']);
    const id = await reserveAction(images, current, beat({ lockedSubmissions }));
    const row = await load(id!);
    const moment = PictureMomentSchema.parse(row.moment);
    expect(moment.scene.title).toBe(current.session.scene.title);
    expect(moment.lines.map(line => line.kind)).toContain('narration');
    expect(moment.cast.map(person => person.name)).toEqual(['Rook', 'Lark', 'Quill']);
    expect(moment.cast.map(person => person.imageNumber)).toEqual([1, null, 2]);
    expect(moment.cast[1]!.portraitId).toBeNull();
    expect(row.prompt).toContain('the person from image 1,');
    expect(row.prompt).toContain('the person from image 2,');
    expect(row.prompt).not.toContain('image 3');
    expect(row.prompt).toMatch(/Everyone fully clothed\. No text, no letters\.$/);
    expect(row.prompt).not.toContain(DIALOGUE);
  });

  it('draws with FLUX 3 Klein when a cast member has a ready portrait, and with the show model otherwise', async () => {
    const { images } = service();
    const { current, lockedSubmissions } = await withCast();
    const withPortraits = await reserveAction(images, current, beat({ lockedSubmissions }));
    expect((await load(withPortraits!)).model).toBe(MOMENT_MODEL);
    const nobody = await reserveAction(images, await state(), beat());
    const row = await load(nobody!);
    expect(row.model).toBe('fake-image');
    expect(row.moment!.cast).toEqual([]);
    expect(row.prompt).toMatch(/ Everyone fully clothed\. No text\.$/);
    expect(row.prompt).not.toContain('reference image');
  });

  it('ignores a portrait that is not ready', async () => {
    const { images } = service();
    const { current, portraits, lockedSubmissions } = await withCast();
    await pool.query("UPDATE images SET status='failed', file_hash=NULL, content_type=NULL, byte_length=NULL WHERE id=ANY($1::uuid[])", [[...portraits.values()]]);
    const row = await load((await reserveAction(images, current, beat({ lockedSubmissions })))!);
    expect(row.model).toBe('fake-image');
    expect(row.moment!.cast.map(person => [person.imageNumber, person.portraitId])).toEqual([[null, null], [null, null], [null, null]]);
  });

  it('uses the show model saved for the show when nobody has a portrait', async () => {
    const { images } = service();
    const chosen = PICTURE_MODELS[PICTURE_MODELS.length - 1]!.id;
    await pool.query('UPDATE sessions SET picture_settings=$2::jsonb WHERE id=$1', [sessionId, JSON.stringify({ style: 'Pixel look', model: chosen })]);
    const row = await load((await reserveAction(images, await state(), beat()))!);
    expect(row.model).toBe(chosen);
    expect(row.prompt).toMatch(/^Pixel look\. /);
    expect(row.moment).toMatchObject({ style: 'Pixel look', model: chosen });
  });

  it('copies the scene hidden flag onto the action picture', async () => {
    const { images } = service();
    const current = await state();
    const scene = await transaction(pool, client => images.reserveScene(client, current, host));
    await pool.query('UPDATE images SET hidden=true WHERE id=$1', [scene]);
    const id = await reserveAction(images, current, beat());
    expect((await load(id!)).hidden).toBe(true);
  });

  it('makes the picture after commit and keeps it held', async () => {
    const { images, provider } = service();
    const id = await reserveAction(images, await state(), beat());
    images.run([id!]);
    await waitFor(async () => await statusOf(id!) === 'ready', 'the action picture');
    expect((await load(id!)).released_at).toBeNull();
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({ requestId: id, width: 1344, height: 768, title: 'Action picture' });
  });

  it('cancels the older picture of the round when a new draft arrives and stops its call', async () => {
    let calls = 0;
    const { images, provider } = service({ hold: () => (++calls === 1 ? new Promise<void>(() => undefined) : Promise.resolve()) });
    const current = await state();
    const first = await reserveAction(images, current, beat());
    images.run([first!]);
    await waitFor(() => provider.requests.length === 1, 'the first picture to reach the picture service');
    const second = await reserveAction(images, current, beat({ draft: draft('The roof gives way in a roar of stone.') }));
    expect(await load(first!)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.actionSuperseded });
    expect((await load(first!)).finished_at).toBeInstanceOf(Date);
    images.run([second!]);
    await waitFor(async () => await statusOf(second!) === 'ready', 'the second picture');
    expect(provider.requests[0]!.signal?.aborted).toBe(true);
    expect(await load(first!)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.actionSuperseded });
    expect((await rows()).filter(row => row.status === 'ready').map(row => row.id)).toEqual([second]);
  });

  it('does not let a late run for a cancelled picture stop the newer one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { images, provider } = service({ hold: () => gate });
    const current = await state();
    const first = await reserveAction(images, current, beat());
    const second = await reserveAction(images, current, beat({ draft: draft('The roof gives way in a roar of stone.') }));
    expect(await statusOf(first!)).toBe('cancelled');
    images.run([second!]);
    await waitFor(() => provider.requests.length === 1, 'the newer picture to reach the picture service');
    images.run([first!]);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(provider.requests[0]!.signal?.aborted).toBe(false);
    release();
    await waitFor(async () => await statusOf(second!) === 'ready', 'the newer picture');
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.signal?.aborted).toBe(false);
    expect(await statusOf(first!)).toBe('cancelled');
  });

  it('cancels older held pictures and makes none when the new draft has no narration', async () => {
    const { images } = service();
    const current = await state();
    const first = await reserveAction(images, current, beat());
    expect(await reserveAction(images, current, beat({ draft: draft('') }))).toBeNull();
    expect(await reserveAction(images, current, beat({ draft: null }))).toBeNull();
    expect(await rows()).toHaveLength(1);
    expect(await load(first!)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.actionSuperseded });
  });

  it('never touches a released picture of the round', async () => {
    const { images } = service();
    const current = await state();
    const first = await reserveAction(images, current, beat());
    expect(await release(images)).toBe(first);
    const second = await reserveAction(images, current, beat({ draft: draft('The roof gives way in a roar of stone.') }));
    expect(await load(first!)).toMatchObject({ status: 'making', message: null });
    expect((await load(first!)).released_at).toBeInstanceOf(Date);
    expect((await load(second!)).status).toBe('making');
  });

  it('makes nothing for a conversation round or when pictures are off', async () => {
    const current = await state();
    const { images } = service();
    expect(await reserveAction(images, current, beat({ kind: 'conversation' }))).toBeNull();
    const { images: off } = service(null);
    expect(await reserveAction(off, current, beat())).toBeNull();
    expect(await release(off)).toBeNull();
    expect(await rows()).toEqual([]);
  });

  it('releases the newest held picture of the round while it is being made or ready', async () => {
    const { images } = service();
    const current = await state();
    const first = await reserveAction(images, current, beat());
    const second = await reserveAction(images, current, beat({ draft: draft('The roof gives way in a roar of stone.') }));
    const other = await reserveAction(images, current, beat({ id: 'beat-action-2' }));
    expect(await release(images)).toBe(second);
    expect((await load(second!)).released_at).toBeInstanceOf(Date);
    expect((await load(first!)).released_at).toBeNull();
    expect((await load(other!)).released_at).toBeNull();
    // Already released, so there is nothing left to release.
    expect(await release(images)).toBeNull();

    await pool.query("UPDATE images SET status='ready', file_hash=repeat('a', 64), content_type='image/png', byte_length=10, finished_at=clock_timestamp() WHERE id=$1", [other]);
    expect(await release(images, 'beat-action-2')).toBe(other);
  });

  it('releases nothing when the newest held picture failed or the round has none', async () => {
    const { images } = service();
    const current = await state();
    await reserveAction(images, current, beat());
    const newest = await reserveAction(images, current, beat({ draft: draft('The roof gives way in a roar of stone.') }));
    await pool.query("UPDATE images SET status='failed', message='The picture could not be made.', finished_at=clock_timestamp() WHERE id=$1", [newest]);
    expect(await release(images)).toBeNull();
    expect(await release(images, 'beat-without-pictures')).toBeNull();
    expect((await rows()).every(row => row.released_at === null)).toBe(true);
  });

  // Round 1's released picture and a New picture pressed after it, both still being made and held at the picture service.
  async function makingOnStream(images: ImageService, provider: FakeImageProvider, current: SessionState) {
    const round = await reserveAction(images, current, beat());
    expect(await release(images)).toBe(round);
    images.run([round!]);
    await waitFor(() => provider.requests.length === 1, 'the round picture to reach the picture service');
    const scene = await transaction(pool, client => images.reserveScene(client, current, host, 'request'));
    images.run([scene!]);
    await waitFor(() => provider.requests.length === 2, 'the scene picture to reach the picture service');
    expect(await statusOf(round!)).toBe('making');
    return { scene: scene!, round: round! };
  }
  const markReady = (id: string) => pool.query("UPDATE images SET status='ready', file_hash=repeat('a', 64), content_type='image/png', byte_length=10, finished_at=clock_timestamp() WHERE id=$1", [id]);

  it('cancels and stops the older pictures still being made when a newer round is released', async () => {
    const { images, provider } = service({ hold: () => new Promise<void>(() => undefined) });
    const current = await state();
    const { scene, round } = await makingOnStream(images, provider, current);
    const newer = await reserveAction(images, current, beat({ id: 'beat-action-2' }));
    await markReady(newer!);
    expect(await release(images, 'beat-action-2')).toBe(newer);
    for (const id of [scene, round]) {
      expect(await load(id)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.newerMoment });
      expect((await load(id)).finished_at).toBeInstanceOf(Date);
    }
    await waitFor(() => provider.requests.every(request => request.signal?.aborted), 'both picture calls to stop');
    expect(await load(newer!)).toMatchObject({ status: 'ready', message: null });
  });

  it('cancels nothing when the newer round has no picture to release', async () => {
    const { images, provider } = service({ hold: () => new Promise<void>(() => undefined) });
    const current = await state();
    const { scene, round } = await makingOnStream(images, provider, current);
    const failed = await reserveAction(images, current, beat({ id: 'beat-action-2' }));
    await pool.query("UPDATE images SET status='failed', message='The picture could not be made.', finished_at=clock_timestamp() WHERE id=$1", [failed]);
    expect(await release(images, 'beat-action-2')).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await statusOf(scene)).toBe('making');
    expect(await statusOf(round)).toBe('making');
    expect(provider.requests.some(request => request.signal?.aborted)).toBe(false);
  });

  it('stops nothing when the publish that released the newer round rolls back', async () => {
    const { images, provider } = service({ hold: () => new Promise<void>(() => undefined) });
    const current = await state();
    const { scene, round } = await makingOnStream(images, provider, current);
    const newer = await reserveAction(images, current, beat({ id: 'beat-action-2' }));
    await markReady(newer!);
    await expect(transaction(pool, async (client) => {
      expect(await images.releaseActionPicture(client, sessionId, 'beat-action-2')).toBe(newer);
      expect((await client.query('SELECT status FROM images WHERE id=$1', [scene])).rows[0].status).toBe('cancelled');
      await new Promise(resolve => setTimeout(resolve, 100));
      throw new Error('publish failed');
    })).rejects.toThrow('publish failed');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await load(scene)).toMatchObject({ status: 'making', message: null });
    expect(await load(round)).toMatchObject({ status: 'making', message: null });
    expect((await load(newer!)).released_at).toBeNull();
    expect(provider.requests.some(request => request.signal?.aborted)).toBe(false);
  });

  it('returns null for a session that is gone and leaves the caller transaction usable', async () => {
    const { images } = service();
    const current = await state();
    const missing = structuredClone(current);
    missing.session.id = 'no-such-session';
    const result = await transaction(pool, async (client) => {
      await client.query("UPDATE sessions SET title='Kept title' WHERE id=$1", [sessionId]);
      expect(await images.reserveActionPicture(client, missing, beat({ sessionId: 'no-such-session' }), host)).toBeNull();
      expect(await images.releaseActionPicture(client, 'no-such-session', 'beat-action-1')).toBeNull();
      const id = await images.reserveActionPicture(client, current, beat(), host);
      return { id, title: (await client.query('SELECT title FROM sessions WHERE id=$1', [sessionId])).rows[0].title };
    });
    expect(result.title).toBe('Kept title');
    expect((await rows()).map(row => row.id)).toEqual([result.id]);
  });
});
