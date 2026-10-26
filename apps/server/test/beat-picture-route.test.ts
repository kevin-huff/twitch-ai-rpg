import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOMENT_MODEL, PICTURE_MODELS, PictureMomentSchema, type CharacterCardDefinition, type DirectorSnapshot, type ScenarioDefinition } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeImageProvider } from '../src/fake-images';
import { PICTURE_MESSAGES } from '../src/images';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const NOT_STARTED = 'Start the show before you make a new picture.';
const NO_BEAT = 'No beat has been published in this scene yet.';
const ENDED = 'This session has ended.';
const SCENE_ONLY = 'Only the director can change scene pictures.';

type App = Awaited<ReturnType<typeof buildApp>>;
type Reply = Awaited<ReturnType<App['inject']>>;
interface Show { sessionId: string; player: string }
interface Row { id: string; subject_id: string; status: string; hidden: boolean; message: string | null; beat_id: string | null; model: string; moment: unknown; prompt: string }

suite('the Draw the last beat route', () => {
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  let app: App | null = null;
  let host = '';
  let provider: FakeImageProvider | null = null;
  // The fake provider waits on `gate`, so a test decides when a picture finishes.
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
    const hostToken = `beat-picture-route-host-${randomUUID()}`;
    provider = options.images === false ? null : new FakeImageProvider({ hold: () => control.gate ?? Promise.resolve() });
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, assetDir, ...(provider ? { images: provider } : {}) });
    host = cookie(await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } }));
  }

  async function redeem(invites: Array<{ role: string; token: string }>) {
    const invite = invites.find(item => item.role === 'player')!;
    const redeemed = await app!.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token: invite.token } });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    return cookie(redeemed);
  }
  async function rehearsal(): Promise<Show> {
    const created = await request('/api/sessions', { commandId: randomUUID() });
    expect(created.statusCode, created.body).toBe(200);
    return { sessionId: created.json().sessionId, player: await redeem(created.json().invites) };
  }
  // A show with a lobby that has not started: scenario and two characters from the library.
  async function lobbyShow(): Promise<Show> {
    const starter = (await request('/api/library/starter')).json() as { scenario: ScenarioDefinition; characters: CharacterCardDefinition[] };
    const saved = (await request('/api/library/scenarios', { commandId: randomUUID(), expectedVersion: 0, definition: starter.scenario })).json();
    const characters = [];
    for (const definition of starter.characters.slice(0, 2)) {
      const template = (await request('/api/library/characters', { commandId: randomUUID(), expectedVersion: 0, definition })).json();
      characters.push({ templateId: template.id, version: template.version });
    }
    const created = await request('/api/sessions', { commandId: randomUUID(), scenario: { templateId: saved.id, version: saved.version }, characters });
    expect(created.statusCode, created.body).toBe(200);
    return { sessionId: created.json().sessionId, player: await redeem(created.json().invites) };
  }
  const director = async (show: Show) => (await request(`/api/sessions/${show.sessionId}`)).json() as DirectorSnapshot;
  const command = (show: Show, payload: Record<string, unknown>) => request(`/api/sessions/${show.sessionId}/commands`, { commandId: randomUUID(), ...payload });
  async function goLive(show: Show) {
    const live = await command(show, { type: 'set_status', status: 'live', expectedStateRevision: (await director(show)).session.stateRevision });
    expect(live.statusCode, live.body).toBe(200);
  }
  async function changeScene(show: Show) {
    const view = await director(show);
    const changed = await command(show, {
      type: 'change_scene', title: 'At the docks', description: 'Rain falls on the boats.', location: { kind: 'new', title: 'Docks', description: '' }, presentNpcIds: [],
      expectedStateRevision: view.session.stateRevision, reason: 'Director adjustment', discardQueuedInput: true,
    });
    expect(changed.statusCode, changed.body).toBe(200);
  }
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
  const publishConversation = async (show: Show) => publishRound(show, await draftRound(show, 'conversation'));

  const rows = async (show: Show) => (await pool.query(
    "SELECT id, subject_id, status, hidden, message, beat_id, model, moment, prompt FROM images WHERE session_id=$1 AND purpose='scene' ORDER BY created_at, id", [show.sessionId])).rows as Row[];
  async function waitFor(check: () => Promise<boolean>, what: string) {
    const deadline = Date.now() + 8_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const waitForStatus = (show: Show, id: string, status: string) =>
    waitFor(async () => (await rows(show)).find(row => row.id === id)?.status === status, `picture ${status}`);
  const post = (show: Show, path: 'beat-picture' | 'scene-picture', credential = host) => request(`/api/sessions/${show.sessionId}/${path}`, {}, credential);
  const sceneOf = (view: DirectorSnapshot) => view.session.scene.id;
  async function liveWithPicture() {
    const show = await rehearsal();
    await goLive(show);
    const [first] = await rows(show);
    if (first) await waitForStatus(show, first.id, 'ready');
    return show;
  }

  describe('refusals', () => {
    it('turns a player away with 403 and reserves nothing', async () => {
      await boot();
      const show = await liveWithPicture();
      await publishConversation(show);
      const before = await rows(show);
      const refused = await post(show, 'beat-picture', show.player);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json()).toMatchObject({ code: 'forbidden', message: SCENE_ONLY });
      expect(await rows(show)).toEqual(before);
    });

    it('answers the pictures-off sentence with 503 when there is no image provider', async () => {
      await boot({ images: false });
      const show = await rehearsal();
      await goLive(show);
      const refused = await post(show, 'beat-picture');
      expect(refused.statusCode, refused.body).toBe(503);
      expect(refused.json()).toMatchObject({ code: 'pictures_off', message: PICTURE_MESSAGES.off });
      expect(await rows(show)).toEqual([]);
    });

    it('refuses a body', async () => {
      await boot();
      const show = await liveWithPicture();
      const refused = await request(`/api/sessions/${show.sessionId}/beat-picture`, { style: 'x' });
      expect(refused.statusCode, refused.body).toBe(400);
    });

    it('refuses a show that has ended', async () => {
      await boot();
      const show = await liveWithPicture();
      await publishConversation(show);
      await pool.query("UPDATE sessions SET status='ended' WHERE id=$1", [show.sessionId]);
      const before = await rows(show);
      const refused = await post(show, 'beat-picture');
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'conflict', message: ENDED });
      expect(await rows(show)).toEqual(before);
    });

    it('refuses a show that is still in the lobby or has not started', async () => {
      await boot();
      for (const waiting of [await rehearsal(), await lobbyShow()]) {
        const refused = await post(waiting, 'beat-picture');
        expect(refused.statusCode, refused.body).toBe(409);
        expect(refused.json()).toMatchObject({ code: 'conflict', message: NOT_STARTED });
        expect(await rows(waiting)).toEqual([]);
      }
    });

    it('refuses when no beat has been published in this scene', async () => {
      await boot();
      const show = await liveWithPicture();
      const before = await rows(show);
      const refused = await post(show, 'beat-picture');
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'conflict', message: NO_BEAT });
      expect(await rows(show)).toEqual(before);
      expect(await pool.query("SELECT 1 FROM audit_events WHERE session_id=$1 AND kind='picture.making'", [show.sessionId]).then(result => result.rowCount)).toBe(0);
    });

    it('refuses a beat from before a scene change', async () => {
      await boot();
      const show = await liveWithPicture();
      await publishConversation(show);
      await changeScene(show);
      const refused = await post(show, 'beat-picture');
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'conflict', message: NO_BEAT });
      await waitFor(async () => (await rows(show)).every(row => row.status !== 'making'), 'the new scene picture');
      expect((await rows(show)).filter(row => row.moment !== null)).toEqual([]);
    });
  });

  it('draws the last beat after a published conversation, with a moment and no round tag', async () => {
    await boot();
    const show = await liveWithPicture();
    const published = await publishConversation(show);
    const sceneId = sceneOf(published);
    expect((await director(show)).lastSceneBeatId).not.toBeNull();
    const before = await rows(show);

    const pressed = await post(show, 'beat-picture');
    expect(pressed.statusCode, pressed.body).toBe(202);
    const { imageId } = pressed.json() as { imageId: string };
    expect(Object.keys(pressed.json())).toEqual(['imageId']);

    await waitForStatus(show, imageId, 'ready');
    const made = (await rows(show)).filter(row => !before.some(old => old.id === row.id));
    expect(made.map(row => row.id)).toEqual([imageId]);
    const row = made[0]!;
    expect(row).toMatchObject({ subject_id: sceneId, beat_id: null, hidden: false });
    const moment = PictureMomentSchema.parse(row.moment);
    expect(moment.lines.length).toBeGreaterThan(0);
    expect(row.prompt.length).toBeGreaterThan(0);
    // Nobody in a rehearsal show has a portrait, so the picture is drawn from words with the show's model.
    expect(moment.cast.every(person => person.imageNumber === null)).toBe(true);
    expect(row.model).not.toBe('');
    const asked = provider!.requests.find(item => item.title === 'Beat picture');
    expect(asked).toBeDefined();
    expect(asked!.prompt).toBe(row.prompt);

    const events = await pool.query("SELECT data FROM audit_events WHERE session_id=$1 AND kind='picture.making' ORDER BY sequence", [show.sessionId]);
    expect(events.rows.at(-1)!.data).toEqual({ imageId, purpose: 'scene', subjectId: sceneId });
    const view = await director(show);
    expect(view.scenePictureStatus).toMatchObject({ state: 'ready', imageId, drawing: null });
  });

  it('reports a beat picture as drawing a beat while it is made, and a place picture as drawing the place', async () => {
    await boot();
    const show = await liveWithPicture();
    await publishConversation(show);
    hold();
    const beat = await post(show, 'beat-picture');
    expect(beat.statusCode, beat.body).toBe(202);
    expect((await director(show)).scenePictureStatus).toMatchObject({ state: 'making', drawing: 'beat' });
    const place = await post(show, 'scene-picture');
    expect(place.statusCode, place.body).toBe(202);
    expect((await director(show)).scenePictureStatus).toMatchObject({ state: 'making', drawing: 'place' });
    release();
    await waitForStatus(show, place.json().imageId, 'ready');
  });

  it('starts over when a place picture is being made', async () => {
    await boot();
    const show = await liveWithPicture();
    await publishConversation(show);
    hold();
    const place = await post(show, 'scene-picture');
    expect(place.statusCode, place.body).toBe(202);
    const beat = await post(show, 'beat-picture');
    expect(beat.statusCode, beat.body).toBe(202);
    const first = place.json().imageId as string;
    const second = beat.json().imageId as string;
    expect(second).not.toBe(first);
    expect((await rows(show)).find(row => row.id === first)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.startedOver });
    release();
    await waitForStatus(show, second, 'ready');
    expect((await rows(show)).find(row => row.id === first)!.status).toBe('cancelled');
    expect((await rows(show)).find(row => row.id === second)!.moment).not.toBeNull();
  });

  it('starts over when another beat picture is being made, and the newest one is the one shown', async () => {
    await boot();
    const show = await liveWithPicture();
    await publishConversation(show);
    hold();
    const first = (await post(show, 'beat-picture')).json().imageId as string;
    const second = (await post(show, 'beat-picture')).json().imageId as string;
    expect((await rows(show)).find(row => row.id === first)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.startedOver });
    release();
    await waitForStatus(show, second, 'ready');
    const view = await director(show);
    expect(view.scenePictureStatus).toMatchObject({ state: 'ready', imageId: second });
    expect((await rows(show)).find(row => row.id === first)!.status).toBe('cancelled');
  });

  it('keeps a held action-round picture through both buttons', async () => {
    await boot();
    const show = await liveWithPicture();
    await publishConversation(show);
    hold();
    const drafted = await draftRound(show, 'action');
    const heldBefore = (await rows(show)).filter(row => row.beat_id !== null);
    expect(heldBefore).toHaveLength(1);
    const held = heldBefore[0]!;
    expect(held).toMatchObject({ beat_id: drafted.activeBeat!.id, status: 'making' });

    const beat = await post(show, 'beat-picture');
    expect(beat.statusCode, beat.body).toBe(202);
    expect((await rows(show)).find(row => row.id === held.id)).toMatchObject({ status: 'making', message: null });
    const place = await post(show, 'scene-picture');
    expect(place.statusCode, place.body).toBe(202);
    const all = await rows(show);
    expect(all.find(row => row.id === held.id)).toMatchObject({ status: 'making', message: null });
    expect(all.find(row => row.id === beat.json().imageId)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.startedOver });

    release();
    await waitForStatus(show, held.id, 'ready');
    await waitForStatus(show, place.json().imageId, 'ready');
    expect((await rows(show)).find(row => row.id === held.id)!.status).toBe('ready');
  });

  it('draws a beat from words with the show\'s saved style and model when nobody has a portrait', async () => {
    await boot();
    const show = await liveWithPicture();
    await publishConversation(show);
    const chosen = PICTURE_MODELS.find(entry => entry.id !== MOMENT_MODEL)!.id;
    const saved = await request(`/api/sessions/${show.sessionId}/picture-settings`, { style: 'Ink wash', model: chosen });
    expect(saved.statusCode, saved.body).toBe(200);
    const { imageId } = (await post(show, 'beat-picture')).json() as { imageId: string };
    await waitForStatus(show, imageId, 'ready');
    const row = (await rows(show)).find(item => item.id === imageId)!;
    expect(row.prompt).toMatch(/^Ink wash\. /);
    expect(row.model).toBe(chosen);
    expect(row.model).not.toBe(MOMENT_MODEL);
    expect(provider!.requests.find(item => item.title === 'Beat picture')).toMatchObject({ model: chosen });
  });

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    assetDir = await mkdtemp(join(tmpdir(), 'rpg-beat-picture-route-'));
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
