import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PICTURE_MODELS, type AiProvider, type DirectorSnapshot, type ScenarioDefinition, type StageSnapshot } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool, transaction } from '../src/database';
import { FakeImageProvider, type FakeImageOptions } from '../src/fake-images';
import { FAKE_PICTURE_DESCRIPTION, FakeAiProvider } from '../src/fake-provider';
import { PICTURE_MESSAGES } from '../src/images';
import { pictureStyleOf } from '../src/picture-prompts';
import { readState } from '../src/repository';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const IMMUTABLE = 'private, max-age=31536000, immutable';

type App = Awaited<ReturnType<typeof buildApp>>;
type Reply = Awaited<ReturnType<App['inject']>>;
interface Harness { app: App; provider: FakeImageProvider | null; host: string; hostToken: string; request: (url: string, payload?: Record<string, unknown>, cookie?: string) => Promise<Reply> }

suite('picture wiring in the app', () => {
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  const open: App[] = [];

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  async function boot(images: FakeImageOptions | null = {}, extra: { hostToken?: string; ai?: AiProvider } = {}): Promise<Harness> {
    const hostToken = extra.hostToken ?? `picture-wiring-host-${randomUUID()}`;
    const provider = images ? new FakeImageProvider(images) : null;
    const app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, assetDir, ...(provider ? { images: provider } : {}), ...(extra.ai ? { provider: extra.ai } : {}) });
    open.push(app);
    const request = (url: string, payload?: Record<string, unknown>, credential = host) => app.inject({
      method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, ...(credential ? { cookie: credential } : {}) }, ...(payload === undefined ? {} : { payload }),
    });
    let host = '';
    host = cookie(await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } }));
    return { app, provider, host, hostToken, request };
  }
  async function createSession(h: Harness, body: Record<string, unknown> = {}) {
    const response = await h.request('/api/sessions', { commandId: randomUUID(), ...body });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { sessionId: string; invites: Array<{ role: string; characterId: string | null; token: string }> };
  }
  async function redeem(h: Harness, token: string) {
    const response = await h.app.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token } });
    expect(response.statusCode, response.body).toBe(200);
    return cookie(response);
  }
  async function waitFor(check: () => Promise<boolean> | boolean, what: string) {
    const deadline = Date.now() + 8_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const imageRows = async (sessionId: string) => (await pool.query('SELECT id, purpose, status, message FROM images WHERE session_id=$1 ORDER BY created_at', [sessionId])).rows;
  const builderCall = (h: Harness, access: Reply, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) => h.app.inject({
    method, url, headers: { origin, cookie: cookie(access), 'x-rpg-identity': access.json().identityId }, ...(payload ? { payload } : {}),
  });
  const openBeat = async (h: Harness, sessionId: string) => {
    const director = (await h.request(`/api/sessions/${sessionId}`)).json() as DirectorSnapshot;
    const response = await h.request(`/api/sessions/${sessionId}/commands`, { commandId: randomUUID(), type: 'open_beat', kind: 'conversation', expectedInputEpoch: director.session.inputEpoch });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().snapshot as DirectorSnapshot;
  };

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    assetDir = await mkdtemp(join(tmpdir(), 'rpg-picture-wiring-'));
  });
  afterAll(async () => {
    for (const app of open) await app.close().catch(() => undefined);
    await pool?.end();
    if (assetDir) await rm(assetDir, { recursive: true, force: true });
  });

  it('reports picturesEnabled in director and stage snapshots only when an image provider is set', async () => {
    const on = await boot({});
    const onSession = await createSession(on);
    const stage = await redeem(on, onSession.invites.find(invite => invite.role === 'stage')!.token);
    expect((await on.request(`/api/sessions/${onSession.sessionId}`)).json().picturesEnabled).toBe(true);
    const stageOn = (await on.request(`/api/sessions/${onSession.sessionId}`, undefined, stage)).json() as StageSnapshot;
    expect(stageOn.role).toBe('stage');
    expect(stageOn.picturesEnabled).toBe(true);
    expect(stageOn.scenePicture).toBeNull();

    const off = await boot(null);
    const offSession = await createSession(off);
    const stageOff = await redeem(off, offSession.invites.find(invite => invite.role === 'stage')!.token);
    const directorOff = (await off.request(`/api/sessions/${offSession.sessionId}`)).json() as DirectorSnapshot;
    expect(directorOff.picturesEnabled).toBe(false);
    expect(directorOff.scenePictureStatus).toBeNull();
    expect(directorOff.portraitJobs).toEqual([]);
    const stageSnapshot = (await off.request(`/api/sessions/${offSession.sessionId}`, undefined, stageOff)).json() as StageSnapshot;
    expect(stageSnapshot.picturesEnabled).toBe(false);
    expect(stageSnapshot.scenePicture).toBeNull();

    // Without a provider the commands never reserve a picture.
    await openBeat(off, offSession.sessionId);
    expect(await imageRows(offSession.sessionId)).toEqual([]);
    expect(off.provider).toBeNull();
  });

  it('makes the opening scene picture when a rehearsal goes live and serves it with the immutable header', async () => {
    const h = await boot({});
    const created = await createSession(h);
    const stage = await redeem(h, created.invites.find(invite => invite.role === 'stage')!.token);
    const view = await openBeat(h, created.sessionId);
    expect(view.picturesEnabled).toBe(true);
    expect(view.scenePictureStatus).toMatchObject({ sceneId: view.session.scene.id });

    let shown: StageSnapshot['scenePicture'] = null;
    await waitFor(async () => {
      shown = ((await h.request(`/api/sessions/${created.sessionId}`, undefined, stage)).json() as StageSnapshot).scenePicture;
      return shown !== null;
    }, 'the scene picture to reach the stage snapshot');
    expect(shown).toMatchObject({ sceneId: view.session.scene.id });
    const row = (await imageRows(created.sessionId))[0]!;
    expect(row).toMatchObject({ purpose: 'scene', status: 'ready', id: shown!.imageId });
    expect(h.provider!.requests).toHaveLength(1);

    const image = await h.request(`/api/sessions/${created.sessionId}/images/${shown!.imageId}`, undefined, stage);
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['cache-control']).toBe(IMMUTABLE);
    expect(image.headers['x-content-type-options']).toBe('nosniff');

    // Only successful picture responses are cached; a missing picture and other API replies are not.
    const missing = await h.request(`/api/sessions/${created.sessionId}/images/${randomUUID()}`, undefined, stage);
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['cache-control']).toBe('no-store');
    expect((await h.request(`/api/sessions/${created.sessionId}`)).headers['cache-control']).toBe('no-store');
  });

  it('adds the picture flags to the library and the private character link only when pictures are on', async () => {
    const on = await boot({});
    expect((await on.request('/api/library')).json().picturesEnabled).toBe(true);
    const off = await boot(null);
    expect(await off.request('/api/library').then(response => response.json())).not.toHaveProperty('picturesEnabled');

    for (const [h, enabled] of [[on, true], [off, false]] as const) {
      const link = (await h.request('/api/character-builders', { commandId: randomUUID(), label: 'A player', instructions: '' })).json();
      const access = await h.request('/api/character-builder/access', { token: link.token });
      expect(access.statusCode, access.body).toBe(200);
      const builder = access.json().builder;
      if (enabled) expect(builder.picturesEnabled).toBe(true); else expect(builder).not.toHaveProperty('picturesEnabled');
      const again = (await builderCall(h, access, 'GET', '/api/character-builder')).json();
      if (enabled) expect(again.picturesEnabled).toBe(true); else expect(again).not.toHaveProperty('picturesEnabled');
    }
  });

  it('copies a scenario picture style into the show brief', async () => {
    const h = await boot({});
    const starter = (await h.request('/api/library/starter')).json() as { scenario: ScenarioDefinition };
    const brief = async (definition: ScenarioDefinition) => {
      const saved = (await h.request('/api/library/scenarios', { commandId: randomUUID(), expectedVersion: 0, definition })).json();
      const created = await createSession(h, { scenario: { templateId: saved.id, version: saved.version }, characters: [{ playerWritten: true }, { playerWritten: true }] });
      return (await transaction(pool, client => readState(client, created.sessionId))).session.brief;
    };
    const styled = await brief({ ...starter.scenario, pictureStyle: 'Ink wash, muted greys' });
    expect(styled?.pictureStyle).toBe('Ink wash, muted greys');
    const plain = await brief(starter.scenario);
    expect(plain).toBeDefined();
    expect(plain).not.toHaveProperty('pictureStyle');
  });

  it('copies a scenario picture style and model into the show settings and the director snapshot', async () => {
    const h = await boot({});
    const starter = (await h.request('/api/library/starter')).json() as { scenario: ScenarioDefinition };
    const create = async (definition: ScenarioDefinition) => {
      const saved = (await h.request('/api/library/scenarios', { commandId: randomUUID(), expectedVersion: 0, definition })).json();
      const created = await createSession(h, { scenario: { templateId: saved.id, version: saved.version }, characters: [{ playerWritten: true }, { playerWritten: true }] });
      const column = (await pool.query('SELECT picture_settings FROM sessions WHERE id=$1', [created.sessionId])).rows[0].picture_settings;
      const snapshot = (await h.request(`/api/sessions/${created.sessionId}`)).json() as DirectorSnapshot;
      return { column, snapshot };
    };

    const model = PICTURE_MODELS[PICTURE_MODELS.length - 1]!.id;
    const chosen = await create({ ...starter.scenario, pictureStyle: 'Ink wash, muted greys', pictureModel: model });
    expect(chosen.column).toEqual({ style: 'Ink wash, muted greys', model });
    expect(chosen.snapshot.pictureSettings).toEqual({ style: 'Ink wash, muted greys', model });

    const plain = await create(starter.scenario);
    expect(plain.column).toEqual({ style: '', model: null });
    expect(plain.snapshot.pictureSettings).toEqual({ style: pictureStyleOf(starter.scenario.pictureStyle), model: 'fake-image' });

    const created = await createSession(h);
    expect((await pool.query('SELECT picture_settings FROM sessions WHERE id=$1', [created.sessionId])).rows[0].picture_settings).toBeNull();
    expect(((await h.request(`/api/sessions/${created.sessionId}`)).json() as DirectorSnapshot).pictureSettings).toEqual({ style: pictureStyleOf(undefined), model: 'fake-image' });

    const off = await boot(null);
    const offSession = await createSession(off);
    expect(((await off.request(`/api/sessions/${offSession.sessionId}`)).json() as DirectorSnapshot).pictureSettings).toBeNull();
  });

  it('turns a picture left making by a restart into a failed one with the standard sentence', async () => {
    const first = await boot({});
    const created = await createSession(first);
    const ownerId = (await pool.query('SELECT owner_id FROM sessions WHERE id=$1', [created.sessionId])).rows[0].owner_id;
    const making = async (purpose: string, sessionId: string | null) => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, status, prompt, width, height, provider, model, requested_by)
         VALUES($1,$2,$3,$4,'subject',$5,'making','A picture.',768,768,'fake','fake-image',$2)`,
        [id, ownerId, sessionId, purpose, `wiring-restart:${purpose}`]);
      return id;
    };
    const ids = { scene: await making('scene', created.sessionId), npc: await making('npc', created.sessionId), card: await making('card', null) };
    const beat = randomUUID();
    await pool.query(
      `INSERT INTO images(id, owner_id, session_id, purpose, subject_id, limit_key, status, prompt, width, height, provider, model, requested_by, moment)
       VALUES($1,$2,$3,'scene','subject',$4,'making','A picture.',768,768,'fake','fake-image',$2,$5::jsonb)`,
      [beat, ownerId, created.sessionId, 'wiring-restart:beat', JSON.stringify({ style: 'Painterly', model: 'fake-image', scene: { title: 'Bar', description: 'A bar.', place: 'Public bar' }, lines: [], cast: [], names: [] })]);
    const ready = randomUUID();
    await pool.query(
      `INSERT INTO images(id, owner_id, purpose, subject_id, limit_key, status, prompt, width, height, provider, model, requested_by, file_hash, content_type, byte_length)
       VALUES($1,$2,'card','subject','wiring-restart:ready','ready','A picture.',768,768,'fake','fake-image',$2,$3,'image/png',10)`, [ready, ownerId, 'c'.repeat(64)]);

    await boot({});
    const load = async (id: string) => (await pool.query('SELECT status, message, finished_at FROM images WHERE id=$1', [id])).rows[0];
    expect(await load(ids.scene)).toMatchObject({ status: 'failed', message: PICTURE_MESSAGES.sceneFailed });
    expect(await load(ids.npc)).toMatchObject({ status: 'failed', message: PICTURE_MESSAGES.npcFailed });
    expect(await load(ids.card)).toMatchObject({ status: 'failed', message: PICTURE_MESSAGES.cardFailed });
    expect(await load(beat)).toMatchObject({ status: 'failed', message: PICTURE_MESSAGES.beatFailed });
    expect((await load(ids.scene)).finished_at).not.toBeNull();
    expect((await load(ready)).status).toBe('ready');
  });

  it('cancels a picture still being made when the app closes, before the pool ends', async () => {
    const hold = new Promise<void>(() => undefined);
    const h = await boot({ hold: () => hold });
    const created = await createSession(h);
    await openBeat(h, created.sessionId);
    await waitFor(() => h.provider!.requests.length === 1, 'the held job to reach the provider');
    expect((await imageRows(created.sessionId))[0]).toMatchObject({ purpose: 'scene', status: 'making' });

    await h.app.close();
    const [row] = await imageRows(created.sessionId);
    expect(row).toMatchObject({ status: 'cancelled' });
    expect(row.message).toBeTruthy();
  });

  it.each([
    ['gives an action round picture the story AI description, which proves the AI provider reaches the job', true],
    ['describes an action round picture from the round itself when the server has no story AI of its own', false],
  ])('%s', async (_label, configured) => {
    const h = await boot({}, configured ? { ai: new FakeAiProvider() } : {});
    const created = await createSession(h);
    const sessionId = created.sessionId;
    const player = await redeem(h, created.invites.find(invite => invite.role === 'player')!.token);
    const director = async () => (await h.request(`/api/sessions/${sessionId}`)).json() as DirectorSnapshot;
    const send = async (payload: Record<string, unknown>, credential?: string) => {
      const response = await h.request(`/api/sessions/${sessionId}/commands`, { commandId: randomUUID(), ...payload }, credential);
      expect(response.statusCode, response.body).toBe(200);
      return response.json().snapshot as DirectorSnapshot;
    };
    await send({ type: 'set_status', status: 'live', expectedStateRevision: (await director()).session.stateRevision });
    await waitFor(async () => (await imageRows(sessionId))[0]?.status === 'ready', 'the opening picture');
    let view = await director();
    view = await send({ type: 'open_beat', kind: 'action', expectedInputEpoch: view.session.inputEpoch });
    await send({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: view.session.inputEpoch, contextBeatId: view.activeBeat!.id, kind: 'act', text: '', intent: 'Open the archive', approach: 'Study the latch' }, player);
    view = await director();
    const beat = (type: string, extra: Record<string, unknown> = {}) => ({ type, beatId: view.activeBeat!.id, expectedBeatRevision: view.activeBeat!.revision, ...extra });
    view = await send(beat('plan_beat', { submissionIds: view.submissions.filter(item => item.status === 'queued').map(item => item.id) }));
    view = await send(beat('approve_stakes', { classification: 'action', contracts: view.activeBeat!.contracts }));
    view = await send(beat('lock_beat'));
    await send(beat('render_beat'));
    await waitFor(async () => (await director()).actionPicture?.state === 'ready', 'the action picture');
    const prompt = (await pool.query('SELECT prompt FROM images WHERE session_id=$1 AND beat_id IS NOT NULL', [sessionId])).rows[0].prompt as string;
    if (configured) expect(prompt).toContain(FAKE_PICTURE_DESCRIPTION);
    else expect(prompt).toContain('A single dramatic moment in a story');
    if (!configured) expect(prompt).not.toContain(FAKE_PICTURE_DESCRIPTION);
  });

  it('registers every picture and portrait route', async () => {
    const h = await boot({});
    const created = await createSession(h);
    const sessionId = created.sessionId;
    const post = async (url: string, payload: Record<string, unknown>, credential?: string) => {
      const response = await h.request(url, payload, credential);
      expect(response.json().message, `${url} must be a registered route`).not.toBe('Route was not found.');
      return response;
    };
    const view = await openBeat(h, sessionId);
    await waitFor(async () => (await imageRows(sessionId)).every(row => row.status !== 'making') && (await imageRows(sessionId)).length > 0, 'the opening picture');
    const scene = (await imageRows(sessionId))[0]!.id as string;

    const again = await post(`/api/sessions/${sessionId}/scene-picture`, {});
    expect(again.statusCode, again.body).toBe(202);
    const newScene = again.json().imageId as string;
    await waitFor(async () => (await imageRows(sessionId)).find(row => row.id === newScene)?.status === 'ready', 'the new scene picture');
    expect((await post(`/api/sessions/${sessionId}/scene-picture/hide`, {})).json()).toEqual({ ok: true });
    expect((await h.request(`/api/sessions/${sessionId}/images/${newScene}`)).statusCode).toBe(200);
    expect((await post(`/api/sessions/${sessionId}/scene-picture/show`, {})).json()).toEqual({ ok: true });

    const npc = view.npcs[0]!;
    const made = await post(`/api/sessions/${sessionId}/npcs/${npc.id}/portrait`, {});
    expect(made.statusCode, made.body).toBe(202);
    const portrait = made.json().imageId as string;
    await waitFor(async () => (await imageRows(sessionId)).find(row => row.id === portrait)?.status === 'ready', 'the NPC portrait');
    expect((await post(`/api/sessions/${sessionId}/npcs/${npc.id}/portrait/remove`, {})).json()).toEqual({ ok: true });
    expect(scene).toBeTruthy();

    const seat = await redeem(h, created.invites.find(invite => invite.role === 'player')!.token);
    const own = (await h.request(`/api/sessions/${sessionId}`, undefined, seat)).json();
    const details = { appearance: 'A tall figure in a grey coat.', role: '', pronouns: '', name: '' };
    const seatPortrait = await post(`/api/sessions/${sessionId}/character/portrait`, { expectedCharacterRevision: own.ownCharacter.cardRevision, details }, seat);
    expect(seatPortrait.statusCode, seatPortrait.body).toBeLessThan(500);

    const library = await post('/api/library/portraits', { subject: 'card', subjectKey: 'wiring-card', details });
    expect(library.statusCode, library.body).toBe(200);
    expect((await h.request(`/api/library/images/${library.json().imageId}`)).statusCode).toBe(200);
    expect((await h.request(`/api/library/images/${library.json().imageId}`)).headers['cache-control']).toBe(IMMUTABLE);

    const link = (await h.request('/api/character-builders', { commandId: randomUUID(), label: 'A player', instructions: '' })).json();
    const access = await h.request('/api/character-builder/access', { token: link.token });
    const builderPortrait = await builderCall(h, access, 'POST', '/api/character-builder/portrait', { expectedRevision: access.json().builder.revision, details });
    expect(builderPortrait.statusCode, builderPortrait.body).toBe(200);
    const builderImage = await builderCall(h, access, 'GET', `/api/character-builder/images/${builderPortrait.json().imageId}`);
    expect(builderImage.statusCode).toBe(200);
    expect(builderImage.headers['cache-control']).toBe(IMMUTABLE);
  });
});
