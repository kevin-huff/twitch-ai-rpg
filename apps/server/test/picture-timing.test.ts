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
interface Row { id: string; purpose: string; beat_id: string | null; moment: unknown; status: string; shelf_only: boolean; released_at: Date | null }

suite('picture timing: the place picture, beat pictures and seat portraits', () => {
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  let app: App | null = null;
  let host = '';
  // Each picture call takes the next gate in line, so a test decides which picture finishes first.
  // A call with no gate waiting finishes at once.
  const control: { failing: boolean; gates: Promise<void>[] } = { failing: false, gates: [] };
  const gate = () => {
    let open: () => void = () => undefined;
    control.gates.push(new Promise<void>((resolve) => { open = resolve; }));
    return open;
  };

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (url: string, payload?: Record<string, unknown>, credential = host): Promise<Reply> => app!.inject({
    method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, ...(credential ? { cookie: credential } : {}) }, ...(payload === undefined ? {} : { payload }),
  });
  async function boot() {
    control.failing = false;
    control.gates = [];
    const hostToken = `picture-timing-host-${randomUUID()}`;
    app = await buildApp({
      databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, assetDir,
      images: new FakeImageProvider({ fail: () => control.failing ? new ProviderError('http_error', 'Sogni') : null, hold: () => control.gates.shift() ?? Promise.resolve() }),
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
  async function ok(show: Show, payload: Record<string, unknown>, credential = host) {
    const response = await request(`/api/sessions/${show.sessionId}/commands`, { commandId: randomUUID(), ...payload }, credential);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().snapshot as DirectorSnapshot;
  }
  const rows = async (show: Show) => (await pool.query(
    'SELECT id, purpose, beat_id, moment, status, shelf_only, released_at FROM images WHERE session_id=$1 ORDER BY created_at, id', [show.sessionId])).rows as Row[];
  const row = async (show: Show, id: string) => (await rows(show)).find(item => item.id === id)!;
  async function waitFor(check: () => Promise<boolean>, what: string) {
    const deadline = Date.now() + 8_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const finished = (show: Show, id: string) => waitFor(async () => (await row(show, id)).status !== 'making', 'a picture to finish');
  // Takes a rehearsal show live and returns its place picture, which may still be held back by a gate.
  async function goLive(show: Show) {
    await ok(show, { type: 'set_status', status: 'live', expectedStateRevision: (await director(show)).session.stateRevision });
    await waitFor(async () => (await rows(show)).some(item => item.purpose === 'scene'), 'the place picture to start');
    return (await rows(show))[0]!;
  }
  // Narrates the scene and publishes it, leaving the beat's picture for the caller to open or leave held.
  async function narrateAndPublish(show: Show) {
    const narrating = await ok(show, { type: 'narrate_scene', expectedInputEpoch: (await director(show)).session.inputEpoch });
    await ok(show, { type: 'render_beat', beatId: narrating.activeBeat!.id, expectedBeatRevision: narrating.activeBeat!.revision });
    await waitFor(async () => (await rows(show)).some(item => item.beat_id === narrating.activeBeat!.id), 'the beat picture to start');
    const view = await director(show);
    await ok(show, {
      type: 'publish_beat', beatId: view.activeBeat!.id, expectedBeatRevision: view.activeBeat!.revision,
      expectedStateRevision: view.session.stateRevision, draftRevision: view.activeBeat!.draftRevision, textOnly: true,
    });
    const released = (await rows(show)).filter(item => item.beat_id === narrating.activeBeat!.id && item.released_at);
    expect(released).toHaveLength(1);
    return released[0]!;
  }

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    assetDir = await mkdtemp(join(tmpdir(), 'picture-timing-'));
  });
  afterEach(async () => { await app?.close(); app = null; });
  afterAll(async () => { await pool?.end(); await rm(assetDir, { recursive: true, force: true }); });

  it('leaves the place picture drawing when a beat is published, then puts it on the shelf when the beat picture is already ready', async () => {
    await boot();
    const show = await rehearsal();
    const openPlace = gate();
    const place = await goLive(show);
    const beat = await narrateAndPublish(show);
    await waitFor(async () => (await row(show, beat.id)).status === 'ready', 'the beat picture');

    expect((await row(show, place.id)).status).toBe('making');
    openPlace();
    await finished(show, place.id);

    expect(await row(show, place.id)).toMatchObject({ status: 'ready', shelf_only: true });
    const sceneId = (await director(show)).session.scene.id;
    expect((await stageView(show)).scenePicture).toMatchObject({ imageId: beat.id, sceneId, kind: 'beat' });
    expect((await playerView(show)).scenePicture).toMatchObject({ imageId: beat.id, kind: 'beat' });
    expect((await director(show)).scenePictureStatus).toMatchObject({ imageId: beat.id, state: 'ready' });
    const events = await pool.query("SELECT 1 FROM audit_events WHERE session_id=$1 AND kind='picture.ready' AND data->>'imageId'=$2", [show.sessionId, place.id]);
    expect(events.rowCount).toBe(1);
  });

  it('shows the place picture with its reveal when it finishes before the beat picture, and the beat picture takes over later', async () => {
    await boot();
    const show = await rehearsal();
    const openPlace = gate();
    const place = await goLive(show);
    const openBeat = gate();
    const beat = await narrateAndPublish(show);
    expect((await row(show, place.id)).status).toBe('making');
    expect((await row(show, beat.id)).status).toBe('making');

    openPlace();
    await finished(show, place.id);
    expect(await row(show, place.id)).toMatchObject({ status: 'ready', shelf_only: false });
    const sceneId = (await director(show)).session.scene.id;
    expect((await stageView(show)).scenePicture).toMatchObject({ imageId: place.id, sceneId, kind: 'place' });

    openBeat();
    await finished(show, beat.id);
    expect((await stageView(show)).scenePicture).toMatchObject({ imageId: beat.id, kind: 'beat' });
    expect((await row(show, place.id)).shelf_only).toBe(false);
  });

  it('still puts a place picture on the stream when the director asks for it after a beat picture showed', async () => {
    await boot();
    const show = await rehearsal();
    const place = await goLive(show);
    await finished(show, place.id);
    const beat = await narrateAndPublish(show);
    await finished(show, beat.id);
    expect((await stageView(show)).scenePicture).toMatchObject({ imageId: beat.id, kind: 'beat' });

    const drawn = await request(`/api/sessions/${show.sessionId}/scene-picture`, {});
    expect(drawn.statusCode, drawn.body).toBe(202);
    const again = drawn.json().imageId as string;
    await finished(show, again);

    expect(await row(show, again)).toMatchObject({ status: 'ready', shelf_only: false });
    expect((await stageView(show)).scenePicture).toMatchObject({ imageId: again, kind: 'place' });
  });

  it('cancels an older beat picture that is still being drawn when the next beat is published', async () => {
    await boot();
    const show = await rehearsal();
    const place = await goLive(show);
    await finished(show, place.id);
    gate();
    const older = await narrateAndPublish(show);
    expect((await row(show, older.id)).status).toBe('making');

    const newer = await narrateAndPublish(show);
    await finished(show, newer.id);

    expect((await row(show, older.id)).status).toBe('cancelled');
    expect((await row(show, newer.id)).status).toBe('ready');
    expect((await stageView(show)).scenePicture).toMatchObject({ imageId: newer.id, kind: 'beat' });
  });

  it('records an event when a seat portrait is ready and when it fails', async () => {
    await boot();
    // A seat portrait needs a custom show with an editable lobby.
    const starter = (await request('/api/library/starter')).json();
    const scenario = (await request('/api/library/scenarios', { commandId: randomUUID(), expectedVersion: 0, definition: starter.scenario })).json();
    const characters = [];
    for (const definition of starter.characters.slice(0, 2)) {
      const template = (await request('/api/library/characters', { commandId: randomUUID(), expectedVersion: 0, definition })).json();
      characters.push({ templateId: template.id, version: template.version });
    }
    const created = await request('/api/sessions', { commandId: randomUUID(), scenario: { templateId: scenario.id, version: scenario.version }, characters });
    expect(created.statusCode, created.body).toBe(200);
    const sessionId = created.json().sessionId as string;
    const invite = (created.json().invites as Array<{ role: string; token: string }>).find(item => item.role === 'player')!;
    const redeemed = await app!.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token: invite.token } });
    const seat = cookie(redeemed);
    // The non-player portraits start with the show; let them finish so only the seat portraits are counted.
    await waitFor(async () => (await pool.query("SELECT 1 FROM images WHERE session_id=$1 AND status='making'", [sessionId])).rowCount === 0, 'the creation portraits');

    const details = { appearance: 'A tall figure in a grey coat.', role: '', pronouns: '', name: '' };
    const portrait = async () => {
      const own = (await request(`/api/sessions/${sessionId}`, undefined, seat)).json() as PlayerSnapshot;
      return request(`/api/sessions/${sessionId}/character/portrait`, { expectedCharacterRevision: own.ownCharacter!.cardRevision, details }, seat);
    };
    const eventsOf = async (kind: string) => (await pool.query(
      "SELECT data FROM audit_events WHERE session_id=$1 AND kind=$2 AND data->>'purpose'='character'", [sessionId, kind])).rows;

    const made = await portrait();
    expect(made.statusCode, made.body).toBe(200);
    const readyId = made.json().imageId as string;
    expect(await eventsOf('portrait.ready')).toMatchObject([{ data: { imageId: readyId, purpose: 'character' } }]);

    control.failing = true;
    await portrait();
    const failed = (await pool.query("SELECT id FROM images WHERE session_id=$1 AND purpose='character' AND status='failed'", [sessionId])).rows;
    expect(failed).toHaveLength(1);
    expect(await eventsOf('portrait.failed')).toMatchObject([{ data: { imageId: failed[0].id } }]);
    expect(await eventsOf('portrait.ready')).toHaveLength(1);
  });
});
