import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PictureMomentSchema, type CharacterCardDefinition, type DirectorSnapshot, type ScenarioDefinition } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeImageProvider } from '../src/fake-images';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const NOT_PUBLISHED = 'That beat has not been published yet.';

type App = Awaited<ReturnType<typeof buildApp>>;
type Reply = Awaited<ReturnType<App['inject']>>;
interface Show { sessionId: string; player: string }
interface Row { id: string; subject_id: string; status: string; hidden: boolean; message: string | null; beat_id: string | null; shows_beat_id: string | null; shelf_only: boolean; model: string; moment: unknown; prompt: string }

suite('Draw again from the shelf', () => {
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
    const hostToken = `shelf-redraw-host-${randomUUID()}`;
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
    "SELECT id, subject_id, status, hidden, message, beat_id, shows_beat_id, shelf_only, model, moment, prompt FROM images WHERE session_id=$1 AND purpose='scene' ORDER BY created_at, id", [show.sessionId])).rows as Row[];
  async function waitFor(check: () => Promise<boolean>, what: string) {
    const deadline = Date.now() + 8_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const waitForStatus = (show: Show, id: string, status: string) =>
    waitFor(async () => (await rows(show)).find(row => row.id === id)?.status === status, `picture ${status}`);
  const post = (show: Show, path: 'beat-picture' | 'scene-picture', payload: Record<string, unknown> = {}, credential = host) => request(`/api/sessions/${show.sessionId}/${path}`, payload, credential);
  const sceneOf = (view: DirectorSnapshot) => view.session.scene.id;
  async function liveWithPicture() {
    const show = await rehearsal();
    await goLive(show);
    const [first] = await rows(show);
    if (first) await waitForStatus(show, first.id, 'ready');
    return show;
  }


  // Takes a live show through two published conversations and returns the first one's beat id.
  async function twoPublishedBeats() {
    const show = await liveWithPicture();
    const first = await draftRound(show, 'conversation');
    const firstBeatId = first.activeBeat!.id;
    await publishRound(show, first);
    await publishConversation(show);
    const second = (await director(show)).lastSceneBeatId!;
    expect(second).not.toBe(firstBeatId);
    return { show, firstBeatId, secondBeatId: second };
  }
  const beatRows = async (show: Show) => (await rows(show)).filter(row => row.shelf_only);

  it('draws a shelf-only picture of an older beat with that beat\'s scene words, and never shows it on the stream', async () => {
    await boot();
    const { show, firstBeatId } = await twoPublishedBeats();
    await waitFor(async () => (await rows(show)).every(row => row.status !== 'making'), 'the published pictures');
    const shownBefore = (await director(show)).scenePicture;
    const statusBefore = (await director(show)).scenePictureStatus;
    const original = (await rows(show)).find(row => row.beat_id === firstBeatId)!;
    const originalScene = PictureMomentSchema.parse(original.moment).scene;

    const pressed = await post(show, 'beat-picture', { beatId: firstBeatId });
    expect(pressed.statusCode, pressed.body).toBe(202);
    expect(Object.keys(pressed.json())).toEqual(['imageId']);
    const imageId = pressed.json().imageId as string;
    await waitForStatus(show, imageId, 'ready');

    const row = (await rows(show)).find(item => item.id === imageId)!;
    expect(row).toMatchObject({ shelf_only: true, beat_id: null, shows_beat_id: firstBeatId, subject_id: sceneOf(await director(show)), hidden: false });
    expect(PictureMomentSchema.parse(row.moment).scene).toEqual(originalScene);
    const events = await pool.query("SELECT data FROM audit_events WHERE session_id=$1 AND kind='picture.making' ORDER BY sequence", [show.sessionId]);
    expect(events.rows.at(-1)!.data).toEqual({ imageId, purpose: 'scene', subjectId: sceneOf(await director(show)), shelfOnly: true });

    const view = await director(show);
    expect(view.scenePicture).toEqual(shownBefore);
    expect(view.scenePictureStatus).toEqual(statusBefore);
    expect(view.scenePictureStatus!.imageId).not.toBe(imageId);
  });

  it('keeps the scene words of the old scene after the scene changes', async () => {
    await boot();
    const { show, firstBeatId } = await twoPublishedBeats();
    await waitFor(async () => (await rows(show)).every(row => row.status !== 'making'), 'the published pictures');
    const original = PictureMomentSchema.parse((await rows(show)).find(row => row.beat_id === firstBeatId)!.moment).scene;
    await changeScene(show);
    await waitFor(async () => (await rows(show)).every(row => row.status !== 'making'), 'the new scene picture');
    const view = await director(show);
    const shownBefore = view.scenePicture;

    const pressed = await post(show, 'beat-picture', { beatId: firstBeatId });
    expect(pressed.statusCode, pressed.body).toBe(202);
    const imageId = pressed.json().imageId as string;
    await waitForStatus(show, imageId, 'ready');
    const row = (await rows(show)).find(item => item.id === imageId)!;
    const scene = PictureMomentSchema.parse(row.moment).scene;
    expect(scene).toEqual(original);
    expect(scene.title).not.toBe('At the docks');
    expect(row.prompt).not.toContain('Rain falls on the boats.');
    expect(row.shelf_only).toBe(true);
    expect((await director(show)).scenePicture).toEqual(shownBefore);
  });

  it('survives the next publish and a Draw the place press while it is being made', async () => {
    await boot();
    const { show, firstBeatId } = await twoPublishedBeats();
    await waitFor(async () => (await rows(show)).every(row => row.status !== 'making'), 'the published pictures');
    hold();
    const imageId = (await post(show, 'beat-picture', { beatId: firstBeatId })).json().imageId as string;
    await publishConversation(show);
    const place = await post(show, 'scene-picture');
    expect(place.statusCode, place.body).toBe(202);
    expect((await rows(show)).find(row => row.id === imageId)).toMatchObject({ status: 'making', message: null });
    release();
    await waitForStatus(show, imageId, 'ready');
    await waitForStatus(show, place.json().imageId, 'ready');
    expect((await rows(show)).find(row => row.id === imageId)).toMatchObject({ status: 'ready', shelf_only: true });
    expect((await director(show)).scenePictureStatus!.imageId).toBe(place.json().imageId);
  });

  it('keeps one shelf picture when another redraw of the same beat finishes', async () => {
    await boot();
    const { show, firstBeatId } = await twoPublishedBeats();
    await waitFor(async () => (await rows(show)).every(row => row.status !== 'making'), 'the published pictures');
    const imageId = (await post(show, 'beat-picture', { beatId: firstBeatId })).json().imageId as string;
    await waitForStatus(show, imageId, 'ready');
    const again = (await post(show, 'beat-picture', { beatId: firstBeatId })).json().imageId as string;
    await waitForStatus(show, again, 'ready');
    expect(await beatRows(show)).toHaveLength(2);
    expect((await rows(show)).filter(row => row.status === 'cancelled' && row.shelf_only)).toEqual([]);
  });

  describe('refusals and the old behaviour', () => {
    it('refuses a beat that was never published, a made-up id and another show\'s beat', async () => {
      await boot();
      const { show } = await twoPublishedBeats();
      const other = await liveWithPicture();
      const otherBeat = (await publishConversation(other), (await director(other)).lastSceneBeatId!);
      const drafted = await draftRound(show, 'conversation');
      const before = (await rows(show)).map(row => row.id);
      for (const beatId of [drafted.activeBeat!.id, 'no-such-beat', otherBeat]) {
        const refused = await post(show, 'beat-picture', { beatId });
        expect(refused.statusCode, refused.body).toBe(409);
        expect(refused.json()).toMatchObject({ code: 'conflict', message: NOT_PUBLISHED });
      }
      expect((await rows(show)).map(row => row.id)).toEqual(before);
    });

    it('turns a player away and refuses extra fields', async () => {
      await boot();
      const { show, firstBeatId } = await twoPublishedBeats();
      const player = await post(show, 'beat-picture', { beatId: firstBeatId }, show.player);
      expect(player.statusCode, player.body).toBe(403);
      const extra = await post(show, 'beat-picture', { beatId: firstBeatId, style: 'x' });
      expect(extra.statusCode, extra.body).toBe(400);
      expect(await beatRows(show)).toEqual([]);
    });

    it('behaves as before with no beatId: an empty body draws the last beat as a normal picture', async () => {
      await boot();
      const { show, secondBeatId } = await twoPublishedBeats();
      await waitFor(async () => (await rows(show)).every(row => row.status !== 'making'), 'the published pictures');
      const pressed = await post(show, 'beat-picture');
      expect(pressed.statusCode, pressed.body).toBe(202);
      const imageId = pressed.json().imageId as string;
      await waitForStatus(show, imageId, 'ready');
      expect((await rows(show)).find(row => row.id === imageId)).toMatchObject({ shelf_only: false, beat_id: null, shows_beat_id: secondBeatId });
      expect((await director(show)).scenePictureStatus!.imageId).toBe(imageId);
      const events = await pool.query("SELECT data FROM audit_events WHERE session_id=$1 AND kind='picture.making' ORDER BY sequence", [show.sessionId]);
      expect(events.rows.at(-1)!.data).not.toHaveProperty('shelfOnly');
    });
  });

  describe('Hide', () => {
    const hide = (show: Show) => request(`/api/sessions/${show.sessionId}/scene-picture/hide`, {});
    const pinnedOf = async (show: Show) => (await pool.query('SELECT pinned_image_id FROM sessions WHERE id=$1', [show.sessionId])).rows[0].pinned_image_id as string | null;
    const hiddenEvents = async (show: Show) =>
      (await pool.query("SELECT data FROM audit_events WHERE session_id=$1 AND kind='picture.hidden' ORDER BY sequence", [show.sessionId])).rows.map(row => row.data);

    it('clears a pin and names the released picture in its event', async () => {
      await boot();
      const show = await liveWithPicture();
      const ready = (await rows(show)).find(row => row.status === 'ready')!;
      await pool.query('UPDATE sessions SET pinned_image_id=$2 WHERE id=$1', [show.sessionId, ready.id]);
      const hidden = await hide(show);
      expect(hidden.statusCode, hidden.body).toBe(200);
      expect(hidden.json()).toEqual({ ok: true });
      expect(await pinnedOf(show)).toBeNull();
      expect(await hiddenEvents(show)).toEqual([{ sceneId: ready.subject_id, hidden: true, unpinnedImageId: ready.id }]);
    });

    it('says null when nothing was pinned, and Show leaves a pin alone', async () => {
      await boot();
      const show = await liveWithPicture();
      const ready = (await rows(show)).find(row => row.status === 'ready')!;
      expect((await hide(show)).statusCode).toBe(200);
      expect(await hiddenEvents(show)).toEqual([{ sceneId: ready.subject_id, hidden: true, unpinnedImageId: null }]);
      await pool.query('UPDATE sessions SET pinned_image_id=$2 WHERE id=$1', [show.sessionId, ready.id]);
      const shown = await request(`/api/sessions/${show.sessionId}/scene-picture/show`, {});
      expect(shown.statusCode, shown.body).toBe(200);
      expect(await pinnedOf(show)).toBe(ready.id);
    });
  });

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    assetDir = await mkdtemp(join(tmpdir(), 'rpg-shelf-redraw-'));
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
