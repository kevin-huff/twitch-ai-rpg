import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DirectorSnapshot, PlayerSnapshot, StageSnapshot } from '@rpg/contracts';
import { ProviderError } from '@rpg/providers';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeImageProvider } from '../src/fake-images';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';

type App = Awaited<ReturnType<typeof buildApp>>;
type Reply = Awaited<ReturnType<App['inject']>>;
interface Show { sessionId: string; stage: string; player: string }
interface Row { id: string; beat_id: string | null; status: string; hidden: boolean; released_at: Date | null }

suite('action round pictures: hiding, failure and abort', () => {
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  let app: App | null = null;
  let host = '';
  // The fake provider fails while `failing` is set, so a test decides which pictures can be made.
  // `gate` holds every picture call until a test releases it.
  const control: { failing: boolean; gate: Promise<void> | null } = { failing: false, gate: null };

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (url: string, payload?: Record<string, unknown>, credential = host): Promise<Reply> => app!.inject({
    method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, ...(credential ? { cookie: credential } : {}) }, ...(payload === undefined ? {} : { payload }),
  });
  async function boot() {
    control.failing = false;
    control.gate = null;
    const hostToken = `action-round-pictures-host-${randomUUID()}`;
    app = await buildApp({
      databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, assetDir,
      images: new FakeImageProvider({ fail: () => control.failing ? new ProviderError('http_error', 'Sogni') : null, hold: () => control.gate ?? Promise.resolve() }),
    });
    host = cookie(await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } }));
  }
  async function rehearsal(): Promise<Show> {
    const created = await request('/api/sessions', { commandId: randomUUID() });
    expect(created.statusCode, created.body).toBe(200);
    const cookies: Record<string, string> = {};
    for (const invite of created.json().invites as Array<{ role: string; token: string }>) {
      if (invite.role !== 'stage' && (invite.role !== 'player' || cookies.player)) continue;
      const redeemed = await app!.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token: invite.token } });
      expect(redeemed.statusCode, redeemed.body).toBe(200);
      cookies[invite.role] = cookie(redeemed);
    }
    return { sessionId: created.json().sessionId, stage: cookies.stage!, player: cookies.player! };
  }
  const director = async (show: Show) => (await request(`/api/sessions/${show.sessionId}`)).json() as DirectorSnapshot;
  const stageView = async (show: Show) => (await request(`/api/sessions/${show.sessionId}`, undefined, show.stage)).json() as StageSnapshot;
  const playerView = async (show: Show) => (await request(`/api/sessions/${show.sessionId}`, undefined, show.player)).json() as PlayerSnapshot;
  const command = (show: Show, payload: Record<string, unknown>, credential = host) =>
    request(`/api/sessions/${show.sessionId}/commands`, { commandId: randomUUID(), ...payload }, credential);
  async function ok(show: Show, payload: Record<string, unknown>, credential = host) {
    const response = await command(show, payload, credential);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().snapshot as DirectorSnapshot;
  }
  const rows = async (show: Show) => (await pool.query(
    'SELECT id, beat_id, status, hidden, released_at FROM images WHERE session_id=$1 ORDER BY created_at, id', [show.sessionId])).rows as Row[];
  async function waitFor(check: () => Promise<boolean>, what: string) {
    const deadline = Date.now() + 8_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  // Takes a rehearsal show live and waits for its opening picture, leaving no job running and no beat open.
  async function liveWithPicture() {
    const show = await rehearsal();
    await ok(show, { type: 'set_status', status: 'live', expectedStateRevision: (await director(show)).session.stateRevision });
    await waitFor(async () => (await rows(show))[0]?.status === 'ready', 'the opening picture');
    return { show, first: (await rows(show))[0]! };
  }
  // Runs an action round to draft review and waits until its picture is no longer being made.
  async function renderedActionRound(show: Show) {
    let view = await director(show);
    view = await ok(show, { type: 'open_beat', kind: 'action', expectedInputEpoch: view.session.inputEpoch });
    await ok(show, {
      type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: view.session.inputEpoch, contextBeatId: view.activeBeat!.id,
      kind: 'act', text: '', intent: 'Open the archive', approach: 'Study the latch',
    }, show.player);
    view = await director(show);
    const beat = (type: string, extra: Record<string, unknown> = {}) => ({ type, beatId: view.activeBeat!.id, expectedBeatRevision: view.activeBeat!.revision, ...extra });
    view = await ok(show, beat('plan_beat', { submissionIds: view.submissions.filter(item => item.status === 'queued').map(item => item.id) }));
    view = await ok(show, beat('approve_stakes', { classification: 'action', contracts: view.activeBeat!.contracts }));
    view = await ok(show, beat('lock_beat'));
    await ok(show, beat('render_beat'));
    return director(show);
  }
  async function draftedActionRound(show: Show) {
    await renderedActionRound(show);
    await waitFor(async () => (await director(show)).actionPicture?.state !== 'making', 'the action picture to finish');
    return director(show);
  }
  const publish = (show: Show, view: DirectorSnapshot) => ok(show, {
    type: 'publish_beat', beatId: view.activeBeat!.id, expectedBeatRevision: view.activeBeat!.revision,
    expectedStateRevision: view.session.stateRevision, draftRevision: view.activeBeat!.draftRevision, textOnly: true,
  });
  const actionRow = async (show: Show) => (await rows(show)).find(row => row.beat_id)!;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    assetDir = await mkdtemp(join(tmpdir(), 'action-round-pictures-'));
  });
  afterEach(async () => { await app?.close(); app = null; });
  afterAll(async () => { await pool?.end(); await rm(assetDir, { recursive: true, force: true }); });

  it('keeps a published action picture off the stage and seats while the scene picture is hidden, until Show picture', async () => {
    await boot();
    const { show } = await liveWithPicture();
    const drafted = await draftedActionRound(show);
    expect(drafted.actionPicture).toMatchObject({ state: 'ready' });
    const action = await actionRow(show);

    const hidden = await request(`/api/sessions/${show.sessionId}/scene-picture/hide`, {});
    expect(hidden.statusCode, hidden.body).toBe(200);
    await publish(show, drafted);

    // The picture is released, but the scene is hidden, so neither the stage nor the seats get a picture.
    expect((await actionRow(show)).released_at).not.toBeNull();
    expect((await stageView(show)).scenePicture).toBeNull();
    expect((await playerView(show)).scenePicture).toBeNull();
    expect((await director(show)).scenePictureStatus).toMatchObject({ state: 'ready', imageId: action.id, hidden: true });
    expect((await request(`/api/sessions/${show.sessionId}/images/${action.id}`, undefined, show.stage)).statusCode).toBe(404);

    const shown = await request(`/api/sessions/${show.sessionId}/scene-picture/show`, {});
    expect(shown.statusCode, shown.body).toBe(200);
    const sceneId = (await director(show)).session.scene.id;
    expect((await stageView(show)).scenePicture).toMatchObject({ imageId: action.id, sceneId });
    expect((await playerView(show)).scenePicture).toMatchObject({ imageId: action.id, sceneId });
    expect((await director(show)).scenePictureStatus).toMatchObject({ imageId: action.id, hidden: false });
  });

  it('still publishes a round whose picture failed, and the stage keeps the picture it had', async () => {
    await boot();
    const { show, first } = await liveWithPicture();
    control.failing = true;
    const drafted = await draftedActionRound(show);
    expect(drafted.actionPicture).toMatchObject({ beatId: drafted.activeBeat!.id, state: 'failed', imageId: null });
    expect((await actionRow(show)).status).toBe('failed');

    const published = await publish(show, drafted);
    expect(published.activeBeat).toBeNull();
    expect((await actionRow(show)).released_at).toBeNull();
    const sceneId = (await director(show)).session.scene.id;
    expect((await stageView(show)).scenePicture).toMatchObject({ imageId: first.id, sceneId });
    expect((await playerView(show)).scenePicture).toMatchObject({ imageId: first.id, sceneId });
    expect((await director(show)).scenePictureStatus).toMatchObject({ state: 'ready', imageId: first.id });
  });

  it('never releases or serves the picture of an aborted round', async () => {
    await boot();
    const { show, first } = await liveWithPicture();
    const drafted = await draftedActionRound(show);
    expect(drafted.actionPicture).toMatchObject({ state: 'ready' });
    const action = await actionRow(show);

    await ok(show, { type: 'abort_beat', beatId: drafted.activeBeat!.id, expectedBeatRevision: drafted.activeBeat!.revision, reason: 'The players changed their minds.' });

    expect((await actionRow(show)).released_at).toBeNull();
    expect((await actionRow(show)).status).toBe('cancelled');
    const sceneId = (await director(show)).session.scene.id;
    expect((await stageView(show)).scenePicture).toMatchObject({ imageId: first.id, sceneId });
    expect((await playerView(show)).scenePicture).toMatchObject({ imageId: first.id, sceneId });
    expect((await director(show)).actionPicture).toBeNull();
    expect((await request(`/api/sessions/${show.sessionId}/images/${action.id}`, undefined, show.stage)).statusCode).toBe(404);
    expect((await request(`/api/sessions/${show.sessionId}/images/${action.id}`, undefined, show.player)).statusCode).toBe(404);
  });

  it('stops a held picture that is still being drawn when its beat is abandoned', async () => {
    await boot();
    const { show } = await liveWithPicture();
    let open: () => void = () => undefined;
    control.gate = new Promise<void>((resolve) => { open = resolve; });
    const view = await renderedActionRound(show);
    await waitFor(async () => (await rows(show)).some(row => row.beat_id && row.status === 'making'), 'the held picture to start');

    await ok(show, { type: 'abort_beat', beatId: view.activeBeat!.id, expectedBeatRevision: view.activeBeat!.revision, reason: 'Never mind.' });
    open();
    await new Promise(resolve => setTimeout(resolve, 300));

    const held = await actionRow(show);
    expect(held.status).toBe('cancelled');
    expect(held.released_at).toBeNull();
  });

  it('leaves only the next beat\'s picture held after an abandoned beat', async () => {
    await boot();
    const { show } = await liveWithPicture();
    const drafted = await draftedActionRound(show);
    await ok(show, { type: 'abort_beat', beatId: drafted.activeBeat!.id, expectedBeatRevision: drafted.activeBeat!.revision, reason: 'Never mind.' });
    const narrating = await ok(show, { type: 'narrate_scene', expectedInputEpoch: (await director(show)).session.inputEpoch });
    await ok(show, { type: 'render_beat', beatId: narrating.activeBeat!.id, expectedBeatRevision: narrating.activeBeat!.revision });
    await waitFor(async () => (await rows(show)).filter(row => row.beat_id && row.status === 'ready').length === 1, 'the next beat\'s picture');

    const held = (await rows(show)).filter(row => row.beat_id && row.released_at === null);
    expect(held).toHaveLength(2);
    expect(held.filter(row => row.status !== 'cancelled')).toHaveLength(1);
    expect(held.filter(row => row.status === 'cancelled')).toHaveLength(1);
  });
});
