import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DirectorSnapshot, ImageRequest, StageSnapshot } from '@rpg/contracts';
import { ProviderError } from '@rpg/providers';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeImageProvider } from '../src/fake-images';
import { PICTURE_MESSAGES } from '../src/picture-limits';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';

type App = Awaited<ReturnType<typeof buildApp>>;
type Reply = Awaited<ReturnType<App['inject']>>;
interface Show { sessionId: string; stage: string; player: string }
interface Row { id: string; beat_id: string | null; status: string; message: string | null }
interface Call { title: string; signal: AbortSignal | undefined; settled: boolean }

// Holds a picture call at its title's gate and records each call's signal, so a test can see which jobs were stopped.
class GatedImages extends FakeImageProvider {
  gates = new Map<string, Promise<void>>();
  once = new Map<string, Promise<void>>();
  calls: Call[] = [];
  gate(title: string) {
    let open!: () => void;
    this.gates.set(title, new Promise<void>((resolve) => { open = resolve; }));
    return () => { this.gates.delete(title); open(); };
  }
  gateNext(title: string) {
    let open!: () => void;
    this.once.set(title, new Promise<void>((resolve) => { open = resolve; }));
    return () => open();
  }
  async generate(request: ImageRequest) {
    const call: Call = { title: request.title, signal: request.signal, settled: false };
    this.calls.push(call);
    try {
      let gate = this.gates.get(request.title);
      const one = this.once.get(request.title);
      if (one) { this.once.delete(request.title); gate = one; }
      if (gate) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(new ProviderError('invalid_context', 'Sogni'));
          if (request.signal?.aborted) return abort();
          request.signal?.addEventListener('abort', abort, { once: true });
          gate.then(() => resolve());
        });
      }
      return await super.generate(request);
    } finally {
      call.settled = true;
    }
  }
}

suite('picture moments: a late picture never takes the stream back from a newer moment', () => {
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  let app: App | null = null;
  let host = '';

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (url: string, payload?: Record<string, unknown>, credential = host): Promise<Reply> => app!.inject({
    method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, ...(credential ? { cookie: credential } : {}) }, ...(payload === undefined ? {} : { payload }),
  });
  async function boot(images: FakeImageProvider) {
    const hostToken = `picture-moments-host-${randomUUID()}`;
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, assetDir, images });
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
  const command = (show: Show, payload: Record<string, unknown>, credential = host) =>
    request(`/api/sessions/${show.sessionId}/commands`, { commandId: randomUUID(), ...payload }, credential);
  async function ok(show: Show, payload: Record<string, unknown>, credential = host) {
    const response = await command(show, payload, credential);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().snapshot as DirectorSnapshot;
  }
  const rows = async (show: Show) => (await pool.query(
    'SELECT id, beat_id, status, message FROM images WHERE session_id=$1 ORDER BY created_at, id', [show.sessionId])).rows as Row[];
  async function waitFor(check: () => boolean | Promise<boolean>, what: string) {
    const deadline = Date.now() + 8_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const notMaking = async (show: Show) => (await rows(show)).every(row => row.status !== 'making');
  async function goLive(show: Show) {
    await ok(show, { type: 'set_status', status: 'live', expectedStateRevision: (await director(show)).session.stateRevision });
  }
  // Runs an action round to draft review without waiting for its picture, whatever state that picture is in.
  async function draftedRound(show: Show) {
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
    view = await ok(show, beat('render_beat'));
    await waitFor(async () => (await director(show)).activeBeat?.phase === 'draft_review', 'the draft');
    return director(show);
  }
  const publish = (show: Show, view: DirectorSnapshot) => ok(show, {
    type: 'publish_beat', beatId: view.activeBeat!.id, expectedBeatRevision: view.activeBeat!.revision,
    expectedStateRevision: view.session.stateRevision, draftRevision: view.activeBeat!.draftRevision, textOnly: true,
  });
  const actionRow = async (show: Show) => (await rows(show)).filter(row => row.beat_id).at(-1)!;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    assetDir = await mkdtemp(join(tmpdir(), 'picture-moments-'));
  });
  afterEach(async () => { await app?.close(); app = null; });
  afterAll(async () => { await pool?.end(); await rm(assetDir, { recursive: true, force: true }); });

  it('keeps the newer round on the stage when an older round picture finishes late', async () => {
    const images = new GatedImages();
    await boot(images);
    const show = await rehearsal();
    await goLive(show);
    await waitFor(async () => (await rows(show))[0]?.status === 'ready', 'the opening picture');

    // Round 1 is published while its picture is still being made; round 2 is published with its picture ready.
    const openFirst = images.gateNext('Action picture');
    let view = await draftedRound(show);
    expect(view.actionPicture?.state).toBe('making');
    await publish(show, view);
    const first = await actionRow(show);
    expect(first.status).toBe('making');

    await draftedRound(show);
    await waitFor(async () => (await director(show)).actionPicture?.state === 'ready', 'the second round picture');
    view = await director(show);
    await publish(show, view);
    const second = await actionRow(show);
    expect(second.id).not.toBe(first.id);
    const sceneId = (await director(show)).session.scene.id;
    expect((await stageView(show)).scenePicture).toEqual({ imageId: second.id, sceneId });

    // Round 1's picture is stopped when round 2 is published; opening its gate afterwards changes nothing.
    const firstCall = images.calls.find(call => call.title === 'Action picture')!;
    await waitFor(() => firstCall.signal?.aborted === true, 'the older round job to be stopped');
    openFirst();
    await waitFor(async () => (await notMaking(show)) && images.calls.every(call => call.settled), 'no picture to be making');

    const after = await rows(show);
    expect(after.find(row => row.id === first.id)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.newerMoment });
    expect(after.find(row => row.id === second.id)).toMatchObject({ status: 'ready' });
    expect((await stageView(show)).scenePicture).toEqual({ imageId: second.id, sceneId });
    expect((await director(show)).scenePictureStatus).toMatchObject({ state: 'ready', imageId: second.id });
  });

  it('cancels an opening picture still being made when the first round is published', async () => {
    const images = new GatedImages();
    const openScene = images.gate('Scene picture');
    await boot(images);
    const show = await rehearsal();
    await goLive(show);
    await waitFor(() => images.calls.some(call => call.title === 'Scene picture'), 'the opening picture to start');
    const opening = (await rows(show))[0]!;
    expect(opening.status).toBe('making');

    await draftedRound(show);
    await waitFor(async () => (await director(show)).actionPicture?.state === 'ready', 'the round picture');
    const view = await director(show);
    await publish(show, view);
    const action = await actionRow(show);

    const openingCall = images.calls.find(call => call.title === 'Scene picture')!;
    await waitFor(() => openingCall.signal?.aborted === true, 'the opening job to be stopped');
    const sceneId = (await director(show)).session.scene.id;
    expect((await rows(show)).find(row => row.id === opening.id)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.newerMoment });
    expect((await stageView(show)).scenePicture).toEqual({ imageId: action.id, sceneId });
    const status = (await director(show)).scenePictureStatus;
    expect(status).toMatchObject({ imageId: action.id });
    expect(status?.state).not.toBe('making');

    openScene();
    await waitFor(() => images.calls.every(call => call.settled), 'the opening job to settle');
    expect((await rows(show)).find(row => row.id === opening.id)).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.newerMoment });
    expect((await stageView(show)).scenePicture).toEqual({ imageId: action.id, sceneId });
    expect((await director(show)).scenePictureStatus).toMatchObject({ state: 'ready', imageId: action.id });
  });
});
