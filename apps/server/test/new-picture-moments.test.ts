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
interface Row { id: string; beat_id: string | null; status: string; released_at: Date | null; message: string | null }

// A picture whose title is gated waits until the gate opens or its call is aborted, so a test decides when each picture finishes.
class GatedImages extends FakeImageProvider {
  gates = new Map<string, Promise<void>>();
  signals = new Map<string, AbortSignal[]>();
  gate(title: string) {
    let open!: () => void;
    this.gates.set(title, new Promise<void>((resolve) => { open = resolve; }));
    return () => { this.gates.delete(title); open(); };
  }
  async generate(request: ImageRequest) {
    if (request.signal) this.signals.set(request.title, [...(this.signals.get(request.title) ?? []), request.signal]);
    const gate = this.gates.get(request.title);
    if (gate) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new ProviderError('invalid_context', 'Sogni'));
        if (request.signal?.aborted) return abort();
        request.signal?.addEventListener('abort', abort, { once: true });
        gate.then(() => resolve());
      });
    }
    return super.generate(request);
  }
}

suite('New picture against action rounds', () => {
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  let app: App | null = null;
  let host = '';
  let images: GatedImages;

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (url: string, payload?: Record<string, unknown>, credential = host): Promise<Reply> => app!.inject({
    method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, ...(credential ? { cookie: credential } : {}) }, ...(payload === undefined ? {} : { payload }),
  });
  async function boot() {
    images = new GatedImages();
    const hostToken = `new-picture-moments-host-${randomUUID()}`;
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
    'SELECT id, beat_id, status, released_at, message FROM images WHERE session_id=$1 ORDER BY created_at, id', [show.sessionId])).rows as Row[];
  async function waitFor(check: () => Promise<boolean>, what: string) {
    const deadline = Date.now() + 8_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  // Takes a rehearsal show live and waits for its opening picture.
  async function liveWithPicture() {
    const show = await rehearsal();
    await ok(show, { type: 'set_status', status: 'live', expectedStateRevision: (await director(show)).session.stateRevision });
    await waitFor(async () => (await rows(show))[0]?.status === 'ready', 'the opening picture');
    return show;
  }
  // Runs an action round to draft review and waits until its picture is ready.
  async function draftedActionRound(show: Show) {
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
    await waitFor(async () => (await director(show)).actionPicture?.state === 'ready', 'the action picture');
    return director(show);
  }
  const publish = (show: Show, view: DirectorSnapshot) => ok(show, {
    type: 'publish_beat', beatId: view.activeBeat!.id, expectedBeatRevision: view.activeBeat!.revision,
    expectedStateRevision: view.session.stateRevision, draftRevision: view.activeBeat!.draftRevision, textOnly: true,
  });
  const actionRow = async (show: Show) => (await rows(show)).find(row => row.beat_id)!;
  const newPicture = (show: Show) => request(`/api/sessions/${show.sessionId}/scene-picture`, {});
  const stageImage = async (show: Show) => (await stageView(show)).scenePicture?.imageId;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    assetDir = await mkdtemp(join(tmpdir(), 'new-picture-moments-'));
  });
  afterEach(async () => { await app?.close(); app = null; });
  afterAll(async () => { await pool?.end(); await rm(assetDir, { recursive: true, force: true }); });

  it('lets a New picture pressed after publish replace the round picture once it finishes', async () => {
    await boot();
    const show = await liveWithPicture();
    const drafted = await draftedActionRound(show);
    await publish(show, drafted);
    const action = await actionRow(show);
    expect(action.released_at).not.toBeNull();
    expect(await stageImage(show)).toBe(action.id);

    const openScene = images.gate('Scene picture');
    const pressed = await newPicture(show);
    expect(pressed.statusCode, pressed.body).toBe(202);
    const pressedId = pressed.json().imageId as string;

    // While the new picture is being made the stage keeps the round's picture.
    expect(await stageImage(show)).toBe(action.id);
    expect((await director(show)).scenePictureStatus).toMatchObject({ state: 'making' });

    openScene();
    await waitFor(async () => (await rows(show)).find(row => row.id === pressedId)?.status === 'ready', 'the new picture');
    expect(await stageImage(show)).toBe(pressedId);
    expect((await director(show)).scenePictureStatus).toMatchObject({ state: 'ready', imageId: pressedId });
  });

  it('lets a round published after a finished New picture replace it', async () => {
    await boot();
    const show = await liveWithPicture();
    const drafted = await draftedActionRound(show);
    const pressed = await newPicture(show);
    expect(pressed.statusCode, pressed.body).toBe(202);
    const pressedId = pressed.json().imageId as string;
    await waitFor(async () => (await rows(show)).find(row => row.id === pressedId)?.status === 'ready', 'the new picture');
    expect(await stageImage(show)).toBe(pressedId);

    await publish(show, drafted);
    const action = await actionRow(show);
    expect(action.released_at).not.toBeNull();
    expect(await stageImage(show)).toBe(action.id);
    expect((await director(show)).scenePictureStatus).toMatchObject({ state: 'ready', imageId: action.id });
  });

  it('cancels a New picture still being made when the round is published, and accepts New picture again', async () => {
    await boot();
    const show = await liveWithPicture();
    const drafted = await draftedActionRound(show);
    images.gate('Scene picture');
    const pressed = await newPicture(show);
    expect(pressed.statusCode, pressed.body).toBe(202);
    const pressedId = pressed.json().imageId as string;
    await waitFor(async () => (images.signals.get('Scene picture') ?? []).length === 2, 'the new picture to start');
    const signal = images.signals.get('Scene picture')![1]!;
    expect(signal.aborted).toBe(false);

    await publish(show, drafted);
    const action = await actionRow(show);

    // The round is the newer moment, so the unfinished picture is cancelled and its call is stopped once the publish has committed.
    const cancelled = (await rows(show)).find(row => row.id === pressedId)!;
    expect(cancelled).toMatchObject({ status: 'cancelled', message: PICTURE_MESSAGES.newerMoment });
    await waitFor(async () => signal.aborted, 'the new picture call to be stopped');
    expect(await stageImage(show)).toBe(action.id);
    expect((await director(show)).scenePictureStatus).toMatchObject({ state: 'ready', imageId: action.id });

    images.gates.clear();
    const again = await newPicture(show);
    expect(again.statusCode, again.body).toBe(202);
    await waitFor(async () => (await rows(show)).find(row => row.id === again.json().imageId)?.status === 'ready', 'the second new picture');
    expect(await stageImage(show)).toBe(again.json().imageId);
  });
});
