import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterCardDefinition, DirectorSnapshot, PlayerSnapshot, ScenarioDefinition, StageSnapshot } from '@rpg/contracts';
import { ProviderError } from '@rpg/providers';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeImageProvider } from '../src/fake-images';
import { FAKE_PICTURE_DESCRIPTION, FakeAiProvider } from '../src/fake-provider';
import { PICTURE_MESSAGES } from '../src/images';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const NOT_STARTED = 'Start the show before you make a new picture.';
const NO_PICTURE = 'There is no picture for this scene yet.';
const SCENE_ONLY = 'Only the director can change scene pictures.';
const HOURLY = /^The picture limit for this hour is used up\. Try again in (1 minute|\d+ minutes)\.$/;

type App = Awaited<ReturnType<typeof buildApp>>;
type Reply = Awaited<ReturnType<App['inject']>>;
interface Invite { role: string; token: string; characterId: string | null }
interface Show { sessionId: string; stage: string; player: string }

suite('scene pictures through commands and routes', () => {
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  let app: App | null = null;
  let host = '';
  let ai = new FakeAiProvider();
  let starter: { scenario: ScenarioDefinition; characters: CharacterCardDefinition[] };
  // The fake provider waits on `gate` and fails while `failing` is set, so a test decides when a picture finishes.
  const control: { gate: Promise<void> | null; failing: boolean } = { gate: null, failing: false };
  let release: () => void = () => undefined;

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (url: string, payload?: Record<string, unknown>, credential = host): Promise<Reply> => app!.inject({
    method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, ...(credential ? { cookie: credential } : {}) }, ...(payload === undefined ? {} : { payload }),
  });
  const hold = () => {
    control.gate = new Promise<void>(resolve => { release = () => { control.gate = null; resolve(); }; });
  };
  async function boot(options: { images?: boolean; imageHourlyLimit?: number } = {}) {
    control.gate = null;
    control.failing = false;
    const hostToken = `pictures-test-host-${randomUUID()}`;
    ai = new FakeAiProvider();
    const images = options.images === false ? null : new FakeImageProvider({
      hold: () => control.gate ?? Promise.resolve(),
      fail: () => control.failing ? new ProviderError('http_error', 'Sogni') : null,
    });
    app = await buildApp({
      databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, assetDir, provider: ai,
      ...(images ? { images } : {}), ...(options.imageHourlyLimit ? { imageHourlyLimit: options.imageHourlyLimit } : {}),
    });
    host = cookie(await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } }));
    starter = (await request('/api/library/starter')).json();
    return images;
  }

  async function redeem(invites: Invite[]) {
    const cookies: Record<string, string> = {};
    for (const invite of invites) {
      if (invite.role !== 'stage' && (invite.role !== 'player' || cookies.player)) continue;
      const redeemed = await app!.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token: invite.token } });
      expect(redeemed.statusCode, redeemed.body).toBe(200);
      cookies[invite.role] = cookie(redeemed);
    }
    return cookies as { stage: string; player: string };
  }
  async function rehearsal(): Promise<Show> {
    const created = await request('/api/sessions', { commandId: randomUUID() });
    expect(created.statusCode, created.body).toBe(200);
    return { sessionId: created.json().sessionId, ...(await redeem(created.json().invites)) };
  }
  // A custom show with a lobby: scenario and two characters from the library, as in seat-generation.test.ts.
  async function customShow(): Promise<Show> {
    const saved = (await request('/api/library/scenarios', { commandId: randomUUID(), expectedVersion: 0, definition: starter.scenario })).json();
    const characters = [];
    for (const definition of starter.characters.slice(0, 2)) {
      const template = (await request('/api/library/characters', { commandId: randomUUID(), expectedVersion: 0, definition })).json();
      characters.push({ templateId: template.id, version: template.version });
    }
    const created = await request('/api/sessions', { commandId: randomUUID(), scenario: { templateId: saved.id, version: saved.version }, characters });
    expect(created.statusCode, created.body).toBe(200);
    return { sessionId: created.json().sessionId, ...(await redeem(created.json().invites)) };
  }
  const director = async (show: Show) => (await request(`/api/sessions/${show.sessionId}`)).json() as DirectorSnapshot;
  const stageView = async (show: Show) => (await request(`/api/sessions/${show.sessionId}`, undefined, show.stage)).json() as StageSnapshot;
  const playerView = async (show: Show) => (await request(`/api/sessions/${show.sessionId}`, undefined, show.player)).json() as PlayerSnapshot;
  const command = (show: Show, payload: Record<string, unknown>, commandId = randomUUID()) => request(`/api/sessions/${show.sessionId}/commands`, { commandId, ...payload });
  async function openBeat(show: Show) {
    const response = await command(show, { type: 'open_beat', kind: 'conversation', expectedInputEpoch: (await director(show)).session.inputEpoch });
    expect(response.statusCode, response.body).toBe(200);
    return response;
  }
  // Seats from saved cards start approved, so a show is ready to start as soon as it is made.
  async function expectCardsApproved(show: Show) {
    const details = (await director(show)).characterDetails;
    expect(details.length).toBeGreaterThan(0);
    for (const character of details) {
      expect(character.approved, character.id).toBe(true);
      expect(character.draft, character.id).toBeNull();
    }
  }
  async function start(show: Show, commandId = randomUUID(), revision?: number) {
    revision ??= (await director(show)).session.stateRevision;
    return command(show, { type: 'start_session', expectedStateRevision: revision, overrideUnreadyReason: 'Testing the opening picture.' }, commandId);
  }
  async function goLive(show: Show) {
    const live = await command(show, { type: 'set_status', status: 'live', expectedStateRevision: (await director(show)).session.stateRevision });
    expect(live.statusCode, live.body).toBe(200);
    return live;
  }
  // Takes a rehearsal show live and waits for its opening picture, leaving no job running and no beat open.
  async function liveWithPicture() {
    const show = await rehearsal();
    await goLive(show);
    const [first] = await rows(show);
    await waitForStatus(show, first!.id, 'ready');
    return { show, first: (await rows(show))[0]! };
  }
  async function changeScene(show: Show, title = 'At the docks') {
    const view = await director(show);
    return command(show, {
      type: 'change_scene', title, description: 'Rain falls on the boats.', location: { kind: 'new', title: 'Docks', description: '' }, presentNpcIds: [],
      expectedStateRevision: view.session.stateRevision, reason: 'Director adjustment', discardQueuedInput: true,
    });
  }
  const rows = async (show: Show) => (await pool.query(
    "SELECT id, subject_id, status, hidden, message FROM images WHERE session_id=$1 AND purpose='scene' ORDER BY created_at, id", [show.sessionId])).rows as Array<{ id: string; subject_id: string; status: string; hidden: boolean; message: string | null }>;
  async function waitFor(check: () => Promise<boolean>, what: string) {
    const deadline = Date.now() + 8_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const waitForStatus = (show: Show, id: string, status: string) =>
    waitFor(async () => (await rows(show)).find(row => row.id === id)?.status === status, `picture ${status}`);
  const picturePost = (show: Show, path: string, credential = host) => request(`/api/sessions/${show.sessionId}/scene-picture${path}`, {}, credential);
  const sceneOf = (view: { session: { scene: { id: string } } }) => view.session.scene.id;

  it('reserves exactly one scene picture when a lobby show starts, without touching the story state', async () => {
    await boot();
    hold();
    const show = await customShow();
    await expectCardsApproved(show);
    const before = await director(show);
    expect(await rows(show)).toEqual([]);

    const commandId = randomUUID();
    const started = await start(show, commandId, before.session.stateRevision);
    expect(started.statusCode, started.body).toBe(200);
    const response = started.json().snapshot as DirectorSnapshot;
    expect(response.session.status).toBe('live');
    expect(response.picturesEnabled).toBe(true);
    expect(response.scenePictureStatus).toMatchObject({ sceneId: sceneOf(before), state: 'making', imageId: null, hidden: false });
    const [row, ...others] = await rows(show);
    expect(others).toEqual([]);
    expect(row).toMatchObject({ subject_id: sceneOf(before), status: 'making' });
    expect((await stageView(show)).scenePicture).toBeNull();

    // A retried start answers from its receipt and makes no second picture.
    const replay = await start(show, commandId, before.session.stateRevision);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(await rows(show)).toHaveLength(1);

    release();
    await waitForStatus(show, row!.id, 'ready');
    const stage = await stageView(show);
    expect(stage.picturesEnabled).toBe(true);
    expect(stage.scenePicture).toEqual({ imageId: row!.id, sceneId: sceneOf(before) });
    expect((await playerView(show)).scenePicture).toEqual({ imageId: row!.id, sceneId: sceneOf(before) });

    // The picture never changed the revision or any character's version.
    const after = await director(show);
    expect(after.session.stateRevision).toBe(response.session.stateRevision);
    expect(after.npcDetails.map(npc => [npc.id, npc.version])).toEqual(before.npcDetails.map(npc => [npc.id, npc.version]));
    expect(after.scenePictureStatus).toMatchObject({ state: 'ready', imageId: row!.id });

    // The finished picture leaves an event and an outbox row for the sockets.
    const events = await pool.query(
      "SELECT e.kind, e.data, o.revision FROM audit_events e JOIN outbox o ON o.event_id=e.id WHERE e.session_id=$1 AND e.kind='picture.ready'", [show.sessionId]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].data).toMatchObject({ imageId: row!.id, purpose: 'scene', subjectId: sceneOf(before) });
    expect(JSON.stringify(events.rows[0].data)).not.toContain('prompt');
  });

  it('reserves one scene picture when a rehearsal show opens its first beat', async () => {
    await boot();
    hold();
    const show = await rehearsal();
    expect(await rows(show)).toEqual([]);
    const opened = (await openBeat(show)).json().snapshot as DirectorSnapshot;
    expect(opened.scenePictureStatus).toMatchObject({ sceneId: sceneOf(opened), state: 'making' });
    const [row, ...others] = await rows(show);
    expect(others).toEqual([]);
    expect(row).toMatchObject({ subject_id: sceneOf(opened), status: 'making' });

    release();
    await waitForStatus(show, row!.id, 'ready');
    expect(await rows(show)).toHaveLength(1);
  });

  it('moves the picture to the new scene when the director changes scene', async () => {
    await boot();
    const { show, first } = await liveWithPicture();
    expect((await stageView(show)).scenePicture?.imageId).toBe(first.id);
    hold();
    const changed = await changeScene(show);
    expect(changed.statusCode, changed.body).toBe(200);
    const view = changed.json().snapshot as DirectorSnapshot;
    expect(sceneOf(view)).not.toBe(first.subject_id);
    expect(view.scenePictureStatus).toMatchObject({ sceneId: sceneOf(view), state: 'making', imageId: null });

    // The old scene's picture is gone from the audience while the new one is being made.
    expect((await stageView(show)).scenePicture).toBeNull();
    expect((await playerView(show)).scenePicture).toBeNull();
    const all = await rows(show);
    expect(all).toHaveLength(2);
    const second = all.find(row => row.subject_id === sceneOf(view))!;
    expect(second.status).toBe('making');

    release();
    await waitForStatus(show, second.id, 'ready');
    expect((await stageView(show)).scenePicture).toEqual({ imageId: second.id, sceneId: sceneOf(view) });
    expect(second.id).not.toBe(first.id);
  });

  it('still changes scene when the hourly picture limit is used up, leaving a failed picture with the reason', async () => {
    // The first start-up fails any leftover 'making' rows, so the count taken after it is stable.
    await boot();
    await app!.close();
    // The limit counts every picture of the last hour on this database, so it is set one above what is already used.
    const used = Number((await pool.query(
      "SELECT count(*) AS used FROM images WHERE (status='making' OR started_at IS NOT NULL) AND created_at > clock_timestamp() - interval '1 hour'")).rows[0].used);
    await boot({ imageHourlyLimit: used + 1 });
    const { show, first } = await liveWithPicture();

    const changed = await changeScene(show);
    expect(changed.statusCode, changed.body).toBe(200);
    const view = changed.json().snapshot as DirectorSnapshot;
    expect(view.scenePictureStatus).toMatchObject({ sceneId: sceneOf(view), state: 'failed', imageId: null });
    expect(view.scenePictureStatus?.message).toMatch(HOURLY);
    const failed = (await rows(show)).find(row => row.subject_id === sceneOf(view))!;
    expect(failed.status).toBe('failed');
    expect(failed.message).toMatch(HOURLY);
    expect(first.status).toBe('ready');
    expect((await director(show)).session.scene.title).toBe('At the docks');

    // Pressing New picture over the limit says so instead of quietly failing.
    const pressed = await picturePost(show, '');
    expect(pressed.statusCode, pressed.body).toBe(429);
    expect(pressed.json()).toMatchObject({ code: 'picture_limit' });
    expect(pressed.json().message).toMatch(HOURLY);
  });

  describe('New picture', () => {
    it('is for the director of the show only and only once the show has started', async () => {
      await boot();
      const { show } = await liveWithPicture();
      for (const credential of [show.player, show.stage]) {
        const refused = await picturePost(show, '', credential);
        expect(refused.statusCode, refused.body).toBe(403);
        expect(refused.json()).toMatchObject({ code: 'forbidden', message: SCENE_ONLY });
      }
      expect((await request(`/api/sessions/${show.sessionId}/scene-picture`, { extra: true })).statusCode).toBe(400);
      expect((await picturePost(show, '', '')).statusCode).toBe(401);

      // Another host's show looks like it does not exist.
      const foreign = await rehearsal();
      await pool.query('UPDATE sessions SET owner_id=$2 WHERE id=$1', [foreign.sessionId, 'foreign-host']);
      expect((await picturePost(foreign, '')).statusCode).toBe(404);
      expect((await picturePost(foreign, '/hide')).statusCode).toBe(404);
      expect((await picturePost(foreign, '/show')).statusCode).toBe(404);

      // A rehearsal that has not opened, and a lobby show that has not started, are both turned away.
      for (const waiting of [await rehearsal(), await customShow()]) {
        const early = await picturePost(waiting, '');
        expect(early.statusCode, early.body).toBe(409);
        expect(early.json()).toMatchObject({ code: 'conflict', message: NOT_STARTED });
        expect(await rows(waiting)).toEqual([]);
      }
    });

    it('starts over when a second press comes while a picture is being made', async () => {
      await boot();
      const { show } = await liveWithPicture();
      hold();
      const pressed = await picturePost(show, '');
      expect(pressed.statusCode, pressed.body).toBe(202);
      const again = await picturePost(show, '');
      expect(again.statusCode, again.body).toBe(202);
      const first = pressed.json().imageId as string;
      const second = again.json().imageId as string;
      expect(second).not.toBe(first);
      expect(await rows(show)).toHaveLength(3);
      expect((await rows(show)).find(row => row.id === first)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.startedOver });
      release();
      await waitForStatus(show, second, 'ready');
      expect((await rows(show)).find(row => row.id === first)!.status).toBe('cancelled');
      expect((await picturePost(show, '')).statusCode).toBe(202);
    });

    it('replaces the shown picture when the new one is ready', async () => {
      await boot();
      const { show, first } = await liveWithPicture();
      hold();
      const pressed = await picturePost(show, '');
      expect(pressed.statusCode, pressed.body).toBe(202);
      const { imageId } = pressed.json() as { imageId: string };
      expect(imageId).not.toBe(first.id);

      // While it is being made the audience keeps the old picture and the director sees the new one coming.
      expect((await stageView(show)).scenePicture?.imageId).toBe(first.id);
      expect((await director(show)).scenePictureStatus).toMatchObject({ state: 'making', imageId: first.id });
      const making = await pool.query("SELECT kind, data FROM audit_events WHERE session_id=$1 AND kind='picture.making'", [show.sessionId]);
      expect(making.rows).toHaveLength(1);
      expect(making.rows[0].data).toEqual({ imageId, purpose: 'scene', subjectId: first.subject_id });

      release();
      await waitForStatus(show, imageId, 'ready');
      expect((await stageView(show)).scenePicture).toEqual({ imageId, sceneId: first.subject_id });
      expect((await director(show)).scenePictureStatus).toMatchObject({ state: 'ready', imageId, message: null });
    });

    it('keeps the old picture and tells the director when the new one fails', async () => {
      await boot();
      const { show, first } = await liveWithPicture();
      control.failing = true;
      const pressed = await picturePost(show, '');
      expect(pressed.statusCode, pressed.body).toBe(202);
      await waitForStatus(show, pressed.json().imageId, 'failed');

      expect((await stageView(show)).scenePicture?.imageId).toBe(first.id);
      const status = (await director(show)).scenePictureStatus;
      expect(status).toMatchObject({ state: 'failed', imageId: first.id, message: PICTURE_MESSAGES.sceneFailed });
      expect((await rows(show)).find(row => row.id === pressed.json().imageId)?.message).toBe(PICTURE_MESSAGES.sceneFailed);
      const failure = await pool.query("SELECT data FROM audit_events WHERE session_id=$1 AND kind='picture.failed'", [show.sessionId]);
      expect(failure.rows).toHaveLength(1);

      // Trying again after the fault clears works.
      control.failing = false;
      const retry = await picturePost(show, '');
      expect(retry.statusCode, retry.body).toBe(202);
      await waitForStatus(show, retry.json().imageId, 'ready');
      expect((await stageView(show)).scenePicture?.imageId).toBe(retry.json().imageId);
    });
  });

  describe('Hide picture and Show picture', () => {
    it('takes the picture away from the audience while the director keeps it, and Show brings it back', async () => {
      await boot();
      const { show, first } = await liveWithPicture();
      for (const path of ['/hide', '/show']) {
        for (const credential of [show.player, show.stage]) {
          const refused = await picturePost(show, path, credential);
          expect(refused.statusCode, refused.body).toBe(403);
          expect(refused.json().message).toBe(SCENE_ONLY);
        }
      }
      const imageUrl = `/api/sessions/${show.sessionId}/images/${first.id}`;
      expect((await request(imageUrl, undefined, show.stage)).statusCode).toBe(200);

      const hidden = await picturePost(show, '/hide');
      expect(hidden.statusCode, hidden.body).toBe(200);
      expect(hidden.json()).toEqual({ ok: true });
      expect((await stageView(show)).scenePicture).toBeNull();
      expect((await playerView(show)).scenePicture).toBeNull();
      expect((await request(imageUrl, undefined, show.stage)).statusCode).toBe(404);
      expect((await request(imageUrl, undefined, show.player)).statusCode).toBe(404);
      const status = (await director(show)).scenePictureStatus;
      expect(status).toMatchObject({ state: 'ready', imageId: first.id, hidden: true });
      expect((await request(imageUrl)).statusCode).toBe(200);

      // Hiding twice is harmless.
      expect((await picturePost(show, '/hide')).statusCode).toBe(200);

      const shown = await picturePost(show, '/show');
      expect(shown.statusCode, shown.body).toBe(200);
      expect(shown.json()).toEqual({ ok: true });
      expect((await stageView(show)).scenePicture).toEqual({ imageId: first.id, sceneId: first.subject_id });
      expect((await director(show)).scenePictureStatus).toMatchObject({ imageId: first.id, hidden: false });
      expect((await request(imageUrl, undefined, show.stage)).statusCode).toBe(200);
      const kinds = await pool.query("SELECT kind, data FROM audit_events WHERE session_id=$1 AND kind IN ('picture.hidden','picture.shown') ORDER BY sequence", [show.sessionId]);
      expect(kinds.rows.map(row => row.kind)).toEqual(['picture.hidden', 'picture.hidden', 'picture.shown']);
      expect(kinds.rows[0].data).toEqual({ sceneId: first.subject_id, hidden: true });
    });

    it('keeps a new picture hidden until the director shows it', async () => {
      await boot();
      const { show, first } = await liveWithPicture();
      expect((await picturePost(show, '/hide')).statusCode).toBe(200);
      const pressed = await picturePost(show, '');
      expect(pressed.statusCode, pressed.body).toBe(202);
      const second = pressed.json().imageId as string;
      await waitForStatus(show, second, 'ready');
      expect((await stageView(show)).scenePicture).toBeNull();
      expect((await director(show)).scenePictureStatus).toMatchObject({ state: 'ready', imageId: second, hidden: true });
      expect((await rows(show)).every(row => row.hidden)).toBe(true);

      expect((await picturePost(show, '/show')).statusCode).toBe(200);
      expect((await stageView(show)).scenePicture).toEqual({ imageId: second, sceneId: first.subject_id });
    });

    it('turns the director away when the scene has no picture yet', async () => {
      await boot();
      const show = await rehearsal();
      for (const path of ['/hide', '/show']) {
        const refused = await picturePost(show, path);
        expect(refused.statusCode, refused.body).toBe(409);
        expect(refused.json()).toMatchObject({ code: 'conflict', message: NO_PICTURE });
      }
      expect(await rows(show)).toEqual([]);
    });

    it('turns hide away when the only picture failed and records nothing, but lets show through', async () => {
      await boot();
      control.failing = true;
      const show = await rehearsal();
      await goLive(show);
      const [only] = await rows(show);
      await waitForStatus(show, only!.id, 'failed');
      const refused = await picturePost(show, '/hide');
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'conflict', message: NO_PICTURE });
      expect((await rows(show)).every(row => !row.hidden)).toBe(true);
      const events = await pool.query("SELECT 1 FROM audit_events WHERE session_id=$1 AND kind IN ('picture.hidden','picture.shown')", [show.sessionId]);
      expect(events.rowCount).toBe(0);
      const shown = await picturePost(show, '/show');
      expect(shown.statusCode, shown.body).toBe(200);
    });

    it('hides the only picture while it is being made, then keeps it off the stage and players until shown', async () => {
      await boot();
      hold();
      const show = await rehearsal();
      await goLive(show);
      const [only] = await rows(show);
      expect(only!.status).toBe('making');
      const hidden = await picturePost(show, '/hide');
      expect(hidden.statusCode, hidden.body).toBe(200);
      expect((await rows(show)).map(row => row.hidden)).toEqual([true]);
      release();
      await waitForStatus(show, only!.id, 'ready');
      expect((await stageView(show)).scenePicture).toBeNull();
      expect((await playerView(show)).scenePicture).toBeNull();
      expect((await director(show)).scenePictureStatus).toMatchObject({ state: 'ready', hidden: true });
      const shown = await picturePost(show, '/show');
      expect(shown.statusCode, shown.body).toBe(200);
      expect((await stageView(show)).scenePicture).toEqual({ imageId: only!.id, sceneId: only!.subject_id });
    });

    it('lets the director show a hidden scene whose only picture failed, and the next new picture is not hidden', async () => {
      await boot();
      hold();
      control.failing = true;
      const show = await rehearsal();
      await goLive(show);
      const [only] = await rows(show);
      expect((await picturePost(show, '/hide')).statusCode).toBe(200);
      release();
      await waitForStatus(show, only!.id, 'failed');
      expect((await rows(show)).map(row => row.hidden)).toEqual([true]);
      expect((await picturePost(show, '/hide')).statusCode).toBe(409);
      const shown = await picturePost(show, '/show');
      expect(shown.statusCode, shown.body).toBe(200);
      expect((await rows(show)).map(row => row.hidden)).toEqual([false]);
      control.failing = false;
      const pressed = await picturePost(show, '');
      expect(pressed.statusCode, pressed.body).toBe(202);
      const next = pressed.json().imageId as string;
      await waitForStatus(show, next, 'ready');
      expect((await rows(show)).find(row => row.id === next)!.hidden).toBe(false);
      expect((await stageView(show)).scenePicture).toEqual({ imageId: next, sceneId: only!.subject_id });
    });

    it('hides a ready picture while a newer one is being made, and marks both rows', async () => {
      await boot();
      const { show } = await liveWithPicture();
      hold();
      const pressed = await picturePost(show, '');
      expect(pressed.statusCode, pressed.body).toBe(202);
      expect((await rows(show)).map(row => row.status)).toEqual(['ready', 'making']);
      const hidden = await picturePost(show, '/hide');
      expect(hidden.statusCode, hidden.body).toBe(200);
      expect((await rows(show)).map(row => row.hidden)).toEqual([true, true]);
      release();
      await waitForStatus(show, pressed.json().imageId, 'ready');
    });
  });

  describe('action round pictures', () => {
    const heldRows = async (show: Show) => (await pool.query(
      'SELECT id, beat_id, status, released_at FROM images WHERE session_id=$1 AND beat_id IS NOT NULL ORDER BY created_at, id', [show.sessionId])).rows as Array<{ id: string; beat_id: string; status: string; released_at: Date | null }>;
    const imageGet = (show: Show, imageId: string, credential: string) => request(`/api/sessions/${show.sessionId}/images/${imageId}`, undefined, credential);
    const beatCommand = async (show: Show, type: string, fields: Record<string, unknown> = {}) => {
      const view = await director(show);
      const response = await command(show, { type, beatId: view.activeBeat!.id, expectedBeatRevision: view.activeBeat!.revision, ...fields });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().snapshot as DirectorSnapshot;
    };
    // Takes a live show through one round, up to a drafted script waiting for review.
    async function draftRound(show: Show, kind: 'action' | 'conversation') {
      const opened = await command(show, { type: 'open_beat', kind, expectedInputEpoch: (await director(show)).session.inputEpoch });
      expect(opened.statusCode, opened.body).toBe(200);
      const view = opened.json().snapshot as DirectorSnapshot;
      const submitted = await request(`/api/sessions/${show.sessionId}/commands`, {
        commandId: randomUUID(), type: 'save_submission', expectedSubmissionRevision: 0, contextBeatId: view.activeBeat!.id, expectedInputEpoch: view.session.inputEpoch,
        ...(kind === 'action'
          ? { kind: 'act', text: '', intent: 'Open the archive mechanism', approach: 'Careful investigation' }
          : { kind: 'say', text: 'Hello there.', recipientNpcIds: [view.npcs[0]!.id] }),
      }, show.player);
      expect(submitted.statusCode, submitted.body).toBe(200);
      const queued = (await director(show)).submissions.filter(submission => submission.status === 'queued').map(submission => submission.id);
      const planned = await beatCommand(show, 'plan_beat', { submissionIds: queued });
      await beatCommand(show, 'approve_stakes', kind === 'action' ? { classification: 'action', contracts: planned.activeBeat!.contracts } : { classification: 'ordinary', contracts: [] });
      await beatCommand(show, 'lock_beat');
      return beatCommand(show, 'render_beat');
    }
    const publishRound = (show: Show, view: DirectorSnapshot) =>
      beatCommand(show, 'publish_beat', { expectedStateRevision: view.session.stateRevision, draftRevision: view.activeBeat!.draftRevision, textOnly: true });
    const actionRequests = (images: FakeImageProvider | null) => images!.requests.filter(item => item.title === 'Action picture');

    it('holds the action picture for the director until the round is published, then shows it', async () => {
      const images = await boot();
      const { show, first } = await liveWithPicture();
      hold();
      const drafted = await draftRound(show, 'action');
      const [held, ...others] = await heldRows(show);
      expect(others).toEqual([]);
      expect(held).toMatchObject({ beat_id: drafted.activeBeat!.id, status: 'making', released_at: null });
      expect(drafted.actionPicture).toEqual({ beatId: drafted.activeBeat!.id, state: 'making', imageId: null, message: null });
      expect(drafted.scenePictureStatus).toMatchObject({ state: 'ready', imageId: first.id });

      // A held picture never blocks New picture.
      const pressed = await picturePost(show, '');
      expect(pressed.statusCode, pressed.body).toBe(202);
      release();
      await waitForStatus(show, pressed.json().imageId, 'ready');
      await waitForStatus(show, held!.id, 'ready');

      // The story AI describes the round from its narration, and the prompt holds that description and none of the spoken lines.
      const [asked, ...more] = actionRequests(images);
      expect(more).toEqual([]);
      const segments = drafted.activeBeat!.draft!.segments;
      const narration = segments.find(segment => segment.kind === 'narration')!.text;
      const spoken = segments.find(segment => segment.kind === 'npc_dialogue')!.text;
      const [described, ...moreDescribed] = ai.pictureRequests;
      expect(moreDescribed).toEqual([]);
      expect(described!.lines.some(line => line.kind === 'narration' && line.text.includes(narration.split(' ').slice(-4).join(' ')))).toBe(true);
      expect(asked!.prompt).toContain(FAKE_PICTURE_DESCRIPTION);
      expect(asked!.prompt).not.toContain(spoken);

      // Ready but held: the stage and the player still see the newest released picture, and neither can fetch the held one.
      const ready = await director(show);
      expect(ready.actionPicture).toEqual({ beatId: drafted.activeBeat!.id, state: 'ready', imageId: held!.id, message: null });
      const sceneId = sceneOf(ready);
      const releasedBefore = { imageId: pressed.json().imageId, sceneId };
      expect((await stageView(show)).scenePicture).toEqual(releasedBefore);
      expect((await playerView(show)).scenePicture).toEqual(releasedBefore);
      expect((await imageGet(show, held!.id, show.stage)).statusCode).toBe(404);
      expect((await imageGet(show, held!.id, show.player)).statusCode).toBe(404);
      expect((await imageGet(show, held!.id, host)).statusCode).toBe(200);

      const published = await publishRound(show, ready);
      expect(published.actionPicture).toBeNull();
      expect((await heldRows(show))[0]!.released_at).not.toBeNull();
      const shown = { imageId: held!.id, sceneId };
      expect((await stageView(show)).scenePicture).toEqual(shown);
      expect((await playerView(show)).scenePicture).toEqual(shown);
      expect((await director(show)).scenePictureStatus).toMatchObject({ state: 'ready', imageId: held!.id });
      expect((await imageGet(show, held!.id, show.stage)).statusCode).toBe(200);
    });

    it('keeps the earlier picture on the stream when the round is published before its picture is ready, then shows it when it finishes', async () => {
      await boot();
      const { show, first } = await liveWithPicture();
      hold();
      const drafted = await draftRound(show, 'action');
      const [held] = await heldRows(show);
      expect(held!.status).toBe('making');

      const published = await publishRound(show, drafted);
      expect(published.actionPicture).toBeNull();
      const sceneId = sceneOf(published);
      expect((await stageView(show)).scenePicture).toEqual({ imageId: first.id, sceneId });
      expect((await playerView(show)).scenePicture).toEqual({ imageId: first.id, sceneId });
      expect((await director(show)).scenePictureStatus).toMatchObject({ state: 'making' });

      release();
      await waitForStatus(show, held!.id, 'ready');
      expect((await stageView(show)).scenePicture).toEqual({ imageId: held!.id, sceneId });
      expect((await playerView(show)).scenePicture).toEqual({ imageId: held!.id, sceneId });
      expect((await director(show)).scenePictureStatus).toMatchObject({ state: 'ready', imageId: held!.id });
      expect((await imageGet(show, held!.id, show.player)).statusCode).toBe(200);
    });

    it('makes no picture for a conversation round', async () => {
      const images = await boot();
      const { show, first } = await liveWithPicture();
      const before = images!.requests.length;
      const drafted = await draftRound(show, 'conversation');
      expect(drafted.actionPicture).toBeNull();
      const published = await publishRound(show, drafted);
      expect(published.actionPicture).toBeNull();
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await heldRows(show)).toEqual([]);
      expect((await rows(show)).map(row => row.id)).toEqual([first.id]);
      expect(images!.requests).toHaveLength(before);
      expect((await stageView(show)).scenePicture).toEqual({ imageId: first.id, sceneId: sceneOf(published) });
    });
  });

  it('answers the picture buttons with the pictures-off sentence and reserves nothing when there is no image provider', async () => {
    await boot({ images: false });
    const lobby = await customShow();
    await expectCardsApproved(lobby);
    const started = await start(lobby);
    expect(started.statusCode, started.body).toBe(200);
    const view = started.json().snapshot as DirectorSnapshot;
    expect(view.session.status).toBe('live');
    expect(view.picturesEnabled).toBe(false);
    expect(view.scenePictureStatus).toBeNull();
    expect(view.scenePicture).toBeNull();

    const opened = await rehearsal();
    await goLive(opened);
    expect((await changeScene(opened)).statusCode).toBe(200);

    for (const show of [lobby, opened]) {
      for (const path of ['', '/hide', '/show']) {
        const refused = await picturePost(show, path);
        expect(refused.statusCode, `${path} ${refused.body}`).toBe(503);
        expect(refused.json()).toMatchObject({ code: 'pictures_off', message: 'Pictures are off on this server.' });
      }
      expect(await rows(show)).toEqual([]);
    }
    expect((await stageView(lobby)).picturesEnabled).toBe(false);
  });

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    assetDir = await mkdtemp(join(tmpdir(), 'rpg-pictures-'));
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
