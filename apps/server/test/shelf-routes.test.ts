import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShelfPicturesSchema, type DirectorSnapshot } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeImageProvider } from '../src/fake-images';
import { PICTURE_MESSAGES } from '../src/images';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const LIST_ONLY = 'Only the director can see the picture list.';
const PIN_ONLY = 'Only the director can pin pictures.';
const HELD = 'This picture waits for its beat to be published.';
const NOT_FINISHED = 'Only a finished picture from this show can go on the stream.';
const NOTHING_PINNED = 'No picture is pinned right now.';
const ENDED = 'This session has ended.';

type App = Awaited<ReturnType<typeof buildApp>>;
type Reply = Awaited<ReturnType<App['inject']>>;
interface Show { sessionId: string; player: string; stage: string }

suite('the picture list, pin and release routes', () => {
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  let app: App | null = null;
  let host = '';
  const control: { gate: Promise<void> | null } = { gate: null };
  let release: () => void = () => undefined;

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (url: string, payload?: Record<string, unknown>, credential = host): Promise<Reply> => app!.inject({
    method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, ...(credential ? { cookie: credential } : {}) }, ...(payload === undefined ? {} : { payload }),
  });
  const hold = () => {
    control.gate = new Promise<void>(resolve => { release = () => { control.gate = null; resolve(); }; });
  };
  async function boot(options: { images?: boolean } = {}) {
    control.gate = null;
    const hostToken = `shelf-routes-host-${randomUUID()}`;
    const provider = options.images === false ? null : new FakeImageProvider({ hold: () => control.gate ?? Promise.resolve() });
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, assetDir, ...(provider ? { images: provider } : {}) });
    host = cookie(await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } }));
  }
  async function redeem(invites: Array<{ role: string; token: string }>, role: string) {
    const invite = invites.find(item => item.role === role)!;
    const redeemed = await app!.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token: invite.token } });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    return cookie(redeemed);
  }
  async function rehearsal(): Promise<Show> {
    const created = await request('/api/sessions', { commandId: randomUUID() });
    expect(created.statusCode, created.body).toBe(200);
    const invites = created.json().invites as Array<{ role: string; token: string }>;
    return { sessionId: created.json().sessionId, player: await redeem(invites, 'player'), stage: await redeem(invites, 'stage') };
  }
  const director = async (show: Show) => (await request(`/api/sessions/${show.sessionId}`)).json() as DirectorSnapshot;
  const command = (show: Show, payload: Record<string, unknown>) => request(`/api/sessions/${show.sessionId}/commands`, { commandId: randomUUID(), ...payload });
  const rows = async (show: Show) => (await pool.query(
    "SELECT id, status FROM images WHERE session_id=$1 AND purpose='scene' ORDER BY created_at, id", [show.sessionId])).rows as Array<{ id: string; status: string }>;
  async function waitFor(check: () => Promise<boolean>, what: string) {
    const deadline = Date.now() + 8_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  // A live show whose opening picture is ready.
  async function liveWithPicture(): Promise<{ show: Show; imageId: string }> {
    const show = await rehearsal();
    const live = await command(show, { type: 'set_status', status: 'live', expectedStateRevision: (await director(show)).session.stateRevision });
    expect(live.statusCode, live.body).toBe(200);
    await waitFor(async () => (await rows(show)).some(row => row.status === 'ready'), 'the opening picture');
    return { show, imageId: (await rows(show)).find(row => row.status === 'ready')!.id };
  }
  const list = async (show: Show, credential = host) => request(`/api/sessions/${show.sessionId}/pictures`, undefined, credential);
  const pin = (show: Show, imageId: string, credential = host) => request(`/api/sessions/${show.sessionId}/pinned-picture`, { imageId }, credential);
  const unpin = (show: Show, credential = host) => request(`/api/sessions/${show.sessionId}/pinned-picture/release`, {}, credential);
  const pinnedOf = async (show: Show) => (await pool.query('SELECT pinned_image_id FROM sessions WHERE id=$1', [show.sessionId])).rows[0].pinned_image_id as string | null;
  const events = async (show: Show, kind: string) => (await pool.query('SELECT data FROM audit_events WHERE session_id=$1 AND kind=$2 ORDER BY sequence', [show.sessionId, kind])).rows.map(row => row.data);

  it('lists every picture for the director, newest first, with label and status', async () => {
    await boot();
    const { show, imageId } = await liveWithPicture();
    const response = await list(show);
    expect(response.statusCode, response.body).toBe(200);
    const parsed = ShelfPicturesSchema.parse(response.json());
    expect(parsed.pictures.map(picture => picture.imageId)).toEqual([imageId]);
    expect(parsed.pictures[0]).toMatchObject({ kind: 'place', status: 'ready', onStream: true, pinned: false, held: false, shelfOnly: false });
    expect(parsed.pictures[0]!.label.length).toBeGreaterThan(0);
  });

  it('turns a seat and a stage link away from all three routes with 403', async () => {
    await boot();
    const { show, imageId } = await liveWithPicture();
    for (const credential of [show.player, show.stage]) {
      const listed = await list(show, credential);
      expect(listed.statusCode, listed.body).toBe(403);
      expect(listed.json()).toMatchObject({ code: 'forbidden', message: LIST_ONLY });
      const pinned = await pin(show, imageId, credential);
      expect(pinned.statusCode, pinned.body).toBe(403);
      expect(pinned.json()).toMatchObject({ code: 'forbidden', message: PIN_ONLY });
      const released = await unpin(show, credential);
      expect(released.statusCode, released.body).toBe(403);
      expect(released.json()).toMatchObject({ code: 'forbidden', message: PIN_ONLY });
    }
    expect(await pinnedOf(show)).toBeNull();
    expect(await events(show, 'picture.pinned')).toEqual([]);
  });

  it('answers the pictures-off sentence with 503 on all three routes', async () => {
    await boot({ images: false });
    const show = await rehearsal();
    for (const response of [await list(show), await pin(show, randomUUID()), await unpin(show)]) {
      expect(response.statusCode, response.body).toBe(503);
      expect(response.json()).toMatchObject({ code: 'pictures_off', message: PICTURE_MESSAGES.off });
    }
  });

  it('pins a ready picture, shows it as pinned and on stream, and records one event', async () => {
    await boot();
    const { show, imageId } = await liveWithPicture();
    const pinned = await pin(show, imageId);
    expect(pinned.statusCode, pinned.body).toBe(200);
    expect(pinned.json()).toEqual({ ok: true });
    expect(await pinnedOf(show)).toBe(imageId);
    expect(await events(show, 'picture.pinned')).toEqual([{ imageId }]);
    const listed = ShelfPicturesSchema.parse((await list(show)).json());
    expect(listed.pictures.find(picture => picture.imageId === imageId)).toMatchObject({ pinned: true, onStream: true });

    // Pinning the picture that is already pinned is fine and records nothing more.
    const again = await pin(show, imageId);
    expect(again.statusCode, again.body).toBe(200);
    expect(await events(show, 'picture.pinned')).toEqual([{ imageId }]);
  });

  it('keeps the pin through a scene change', async () => {
    await boot();
    const { show, imageId } = await liveWithPicture();
    expect((await pin(show, imageId)).statusCode).toBe(200);
    const view = await director(show);
    const changed = await command(show, {
      type: 'change_scene', title: 'At the docks', description: 'Rain falls on the boats.', location: { kind: 'new', title: 'Docks', description: '' }, presentNpcIds: [],
      expectedStateRevision: view.session.stateRevision, reason: 'Director adjustment', discardQueuedInput: true,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(await pinnedOf(show)).toBe(imageId);
    await waitFor(async () => (await rows(show)).every(row => row.status !== 'making'), 'the new scene picture');
    const listed = ShelfPicturesSchema.parse((await list(show)).json());
    expect(listed.pictures.find(picture => picture.imageId === imageId)).toMatchObject({ pinned: true, onStream: true });
    expect(listed.pictures.filter(picture => picture.onStream)).toHaveLength(1);
  });

  it('lists and pins a library card portrait a character uses', async () => {
    await boot();
    const { show } = await liveWithPicture();
    const owner = (await pool.query('SELECT owner_id FROM sessions WHERE id=$1', [show.sessionId])).rows[0].owner_id as string;
    const card = randomUUID();
    await pool.query(
      `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, status, hidden, prompt, width, height, provider, model, requested_by, file_hash, content_type, byte_length)
       VALUES($1,$2,NULL,'card','library-card','shelf-card-test','ready',false,'A portrait.',768,768,'fake','fake-image',$2,$3,'image/jpeg',1000)`,
      [card, owner, 'b'.repeat(64)]);
    const character = (await pool.query('SELECT id FROM characters WHERE session_id=$1 ORDER BY ordinal LIMIT 1', [show.sessionId])).rows[0].id as string;
    await pool.query("UPDATE characters SET data = jsonb_set(data, '{portraitId}', to_jsonb($3::text)) WHERE session_id=$1 AND id=$2", [show.sessionId, character, card]);
    const listed = ShelfPicturesSchema.parse((await list(show)).json());
    expect(listed.pictures.find(picture => picture.imageId === card)).toMatchObject({ kind: 'portrait', status: 'ready' });
    const pinned = await pin(show, card);
    expect(pinned.statusCode, pinned.body).toBe(200);
    expect(await pinnedOf(show)).toBe(card);
  });

  it('refuses another show\'s picture, an unknown picture, and held, making or failed pictures', async () => {
    await boot();
    const { show, imageId } = await liveWithPicture();
    const other = await liveWithPicture();

    const foreign = await pin(show, other.imageId);
    expect(foreign.statusCode, foreign.body).toBe(409);
    expect(foreign.json()).toMatchObject({ code: 'conflict', message: NOT_FINISHED });
    const unknown = await pin(show, randomUUID());
    expect(unknown.statusCode, unknown.body).toBe(409);
    expect(unknown.json()).toMatchObject({ message: NOT_FINISHED });

    hold();
    const making = await request(`/api/sessions/${show.sessionId}/scene-picture`, {});
    expect(making.statusCode, making.body).toBe(202);
    const makingId = making.json().imageId as string;
    const stillMaking = await pin(show, makingId);
    expect(stillMaking.statusCode, stillMaking.body).toBe(409);
    expect(stillMaking.json()).toMatchObject({ message: NOT_FINISHED });
    release();
    await waitFor(async () => (await rows(show)).find(row => row.id === makingId)?.status === 'ready', 'the picture');

    await pool.query("UPDATE images SET status='failed', message='The picture service did not answer.', file_hash=NULL WHERE id=$1", [makingId]);
    const failed = await pin(show, makingId);
    expect(failed.statusCode, failed.body).toBe(409);
    expect(failed.json()).toMatchObject({ message: NOT_FINISHED });

    await pool.query("UPDATE images SET beat_id='held-beat', released_at=NULL WHERE id=$1", [makingId]);
    const held = await pin(show, makingId);
    expect(held.statusCode, held.body).toBe(409);
    expect(held.json()).toMatchObject({ message: HELD });

    // A beat's picture that publishing never released stays off the stream, so it cannot be pinned even once the beat is out.
    const beatId = randomUUID();
    await pool.query("INSERT INTO beats(id, session_id, kind, phase, data) VALUES($1,$2,'conversation','published','{}')", [beatId, show.sessionId]);
    await pool.query('INSERT INTO published_beats(id, session_id, beat_number, data) VALUES($1,$2,99,$3)', [beatId, show.sessionId,
      { id: beatId, kind: 'conversation', beatNumber: 99, actionRoundNumber: 0, stateRevision: 1, publishedAt: new Date().toISOString(), rolls: [], outcomes: [], textOnly: true, segments: [] }]);
    await pool.query("UPDATE images SET status='ready', message=NULL, file_hash=$2, beat_id=$3, released_at=NULL WHERE id=$1", [makingId, 'a'.repeat(64), beatId]);
    const unreleased = await pin(show, makingId);
    expect(unreleased.statusCode, unreleased.body).toBe(409);
    expect(unreleased.json()).toMatchObject({ message: HELD });

    expect(await pinnedOf(show)).toBeNull();
    expect(await events(show, 'picture.pinned')).toEqual([]);
    expect((await pin(show, imageId)).statusCode).toBe(200);
  });

  it('releases the pin, and refuses a second release', async () => {
    await boot();
    const { show, imageId } = await liveWithPicture();
    const nothing = await unpin(show);
    expect(nothing.statusCode, nothing.body).toBe(409);
    expect(nothing.json()).toMatchObject({ code: 'conflict', message: NOTHING_PINNED });

    expect((await pin(show, imageId)).statusCode).toBe(200);
    const released = await unpin(show);
    expect(released.statusCode, released.body).toBe(200);
    expect(released.json()).toEqual({ ok: true });
    expect(await pinnedOf(show)).toBeNull();
    expect(await events(show, 'picture.unpinned')).toEqual([{ imageId }]);
    expect(ShelfPicturesSchema.parse((await list(show)).json()).pictures[0]).toMatchObject({ pinned: false });

    const second = await unpin(show);
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json()).toMatchObject({ message: NOTHING_PINNED });
    expect(await events(show, 'picture.unpinned')).toHaveLength(1);
  });

  it('refuses to pin or release on a show that has ended', async () => {
    await boot();
    const { show, imageId } = await liveWithPicture();
    expect((await pin(show, imageId)).statusCode).toBe(200);
    await pool.query("UPDATE sessions SET status='ended' WHERE id=$1", [show.sessionId]);
    for (const response of [await pin(show, imageId), await unpin(show)]) {
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ code: 'conflict', message: ENDED });
    }
    expect(await pinnedOf(show)).toBe(imageId);
  });

  it('refuses a body the route does not know', async () => {
    await boot();
    const { show, imageId } = await liveWithPicture();
    const extra = await request(`/api/sessions/${show.sessionId}/pinned-picture`, { imageId, style: 'x' });
    expect(extra.statusCode, extra.body).toBe(400);
    const missing = await request(`/api/sessions/${show.sessionId}/pinned-picture`, {});
    expect(missing.statusCode, missing.body).toBe(400);
    const release = await request(`/api/sessions/${show.sessionId}/pinned-picture/release`, { imageId });
    expect(release.statusCode, release.body).toBe(400);
  });

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    assetDir = await mkdtemp(join(tmpdir(), 'rpg-shelf-routes-'));
  });
  afterEach(async () => {
    release();
    await app?.close();
    app = null;
  });
  afterAll(async () => {
    await pool?.end();
    if (assetDir) await rm(assetDir, { recursive: true, force: true });
  });
});
