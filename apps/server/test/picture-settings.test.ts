import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PICTURE_STYLE, PICTURE_MODELS, PICTURE_STYLE_MAX, type CharacterCardDefinition, type DirectorSnapshot, type ScenarioDefinition } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeImageProvider } from '../src/fake-images';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const SETTINGS_ONLY = 'Only the director can change picture settings.';
const ENDED = 'This session has ended.';
const UNKNOWN_MODEL = 'Choose a picture model from the list.';
const OTHER_MODEL = PICTURE_MODELS[1]!.id;

type App = Awaited<ReturnType<typeof buildApp>>;
type Reply = Awaited<ReturnType<App['inject']>>;
interface Invite { role: string; token: string; characterId: string | null }
interface Show { sessionId: string; player: string }

suite('picture settings route', () => {
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  let app: App | null = null;
  let host = '';
  let starter: { scenario: ScenarioDefinition; characters: CharacterCardDefinition[] };

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (url: string, payload?: unknown, credential = host): Promise<Reply> => app!.inject({
    method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, ...(credential ? { cookie: credential } : {}) }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  async function boot(options: { images?: boolean } = {}) {
    const hostToken = `picture-settings-host-${randomUUID()}`;
    const provider = new FakeImageProvider();
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, assetDir, ...(options.images === false ? {} : { images: provider }) });
    host = cookie(await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } }));
    starter = (await request('/api/library/starter')).json();
    return provider;
  }
  async function redeemPlayer(invites: Invite[]) {
    const invite = invites.find(item => item.role === 'player')!;
    const redeemed = await app!.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token: invite.token } });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    return cookie(redeemed);
  }
  async function rehearsal(): Promise<Show> {
    const created = await request('/api/sessions', { commandId: randomUUID() });
    expect(created.statusCode, created.body).toBe(200);
    return { sessionId: created.json().sessionId, player: await redeemPlayer(created.json().invites) };
  }
  async function customShow(): Promise<Show> {
    const saved = (await request('/api/library/scenarios', { commandId: randomUUID(), expectedVersion: 0, definition: starter.scenario })).json();
    const characters = [];
    for (const definition of starter.characters.slice(0, 2)) {
      const template = (await request('/api/library/characters', { commandId: randomUUID(), expectedVersion: 0, definition })).json();
      characters.push({ templateId: template.id, version: template.version });
    }
    const created = await request('/api/sessions', { commandId: randomUUID(), scenario: { templateId: saved.id, version: saved.version }, characters });
    expect(created.statusCode, created.body).toBe(200);
    return { sessionId: created.json().sessionId, player: await redeemPlayer(created.json().invites) };
  }
  const director = async (show: Show) => (await request(`/api/sessions/${show.sessionId}`)).json() as DirectorSnapshot;
  const save = (show: Show, payload: unknown, credential = host) => request(`/api/sessions/${show.sessionId}/picture-settings`, payload, credential);
  const stored = async (show: Show) => (await pool.query('SELECT picture_settings FROM sessions WHERE id=$1', [show.sessionId])).rows[0].picture_settings;
  const events = async (show: Show) => (await pool.query("SELECT data FROM audit_events WHERE session_id=$1 AND kind='picture.settings_saved' ORDER BY sequence", [show.sessionId])).rows.map(row => row.data);
  async function waitFor(check: () => Promise<boolean>, what: string) {
    const deadline = Date.now() + 8_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  it('saves and answers the effective settings for a custom show and stores them on the show', async () => {
    await boot();
    const show = await customShow();
    expect(await stored(show)).toEqual({ style: starter.scenario.pictureStyle?.trim() ?? '', model: starter.scenario.pictureModel ?? null });

    const saved = await save(show, { style: '  Bold black-ink comic book art  ', model: OTHER_MODEL });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toEqual({ style: 'Bold black-ink comic book art', model: OTHER_MODEL });
    expect(await stored(show)).toEqual({ style: 'Bold black-ink comic book art', model: OTHER_MODEL });
  });

  it('works for a rehearsal show that has no brief', async () => {
    await boot();
    const show = await rehearsal();
    const saved = await save(show, { style: 'Pixel art look', model: PICTURE_MODELS[0]!.id });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toEqual({ style: 'Pixel art look', model: PICTURE_MODELS[0]!.id });
    expect(await stored(show)).toEqual({ style: 'Pixel art look', model: PICTURE_MODELS[0]!.id });
  });

  it('falls back to the brief style, then the default, when the saved style is blank', async () => {
    const provider = await boot();
    const custom = await customShow();
    const saved = await save(custom, { style: '   ', model: OTHER_MODEL });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toEqual({ style: starter.scenario.pictureStyle?.trim() || DEFAULT_PICTURE_STYLE, model: OTHER_MODEL });
    expect(await stored(custom)).toEqual({ style: '', model: OTHER_MODEL });

    const plain = await rehearsal();
    expect((await save(plain, { style: '', model: OTHER_MODEL })).json()).toEqual({ style: DEFAULT_PICTURE_STYLE, model: OTHER_MODEL });
    // The server's own model is accepted even when it is not on the list.
    expect(PICTURE_MODELS.some(entry => entry.id === provider.model)).toBe(false);
    expect((await save(plain, { style: '', model: provider.model })).json()).toEqual({ style: DEFAULT_PICTURE_STYLE, model: provider.model });
  });

  it('records one event per save', async () => {
    await boot();
    const show = await rehearsal();
    expect(await events(show)).toEqual([]);
    expect((await save(show, { style: 'One', model: OTHER_MODEL })).statusCode).toBe(200);
    expect((await save(show, { style: 'Two', model: PICTURE_MODELS[0]!.id })).statusCode).toBe(200);
    expect(await events(show)).toEqual([{ model: OTHER_MODEL }, { model: PICTURE_MODELS[0]!.id }]);
  });

  it('turns away a player, a server with pictures off, an ended show, an unknown model and a malformed body', async () => {
    await boot();
    const show = await rehearsal();
    const good = { style: 'Watercolor', model: OTHER_MODEL };

    const player = await save(show, good, show.player);
    expect(player.statusCode, player.body).toBe(403);
    expect(player.json()).toMatchObject({ code: 'forbidden', message: SETTINGS_ONLY });

    const unknown = await save(show, { style: 'Watercolor', model: 'not-a-listed-model' });
    expect(unknown.statusCode, unknown.body).toBe(400);
    expect(unknown.json()).toMatchObject({ code: 'invalid_input', message: UNKNOWN_MODEL });

    for (const body of [{ style: 'x' }, { model: OTHER_MODEL }, { ...good, extra: 1 }, { style: 'x'.repeat(PICTURE_STYLE_MAX + 1), model: OTHER_MODEL }, { style: 'x', model: 'Bad Model!' }]) {
      const bad = await save(show, body);
      expect(bad.statusCode, JSON.stringify(body)).toBe(400);
      expect(bad.json()).toMatchObject({ code: 'invalid_input' });
    }
    expect(await stored(show)).toBeNull();
    expect(await events(show)).toEqual([]);

    await pool.query("UPDATE sessions SET status='ended' WHERE id=$1", [show.sessionId]);
    const ended = await save(show, good);
    expect(ended.statusCode, ended.body).toBe(409);
    expect(ended.json()).toMatchObject({ code: 'conflict', message: ENDED });
    expect(await stored(show)).toBeNull();

    await app!.close();
    await boot({ images: false });
    const off = await rehearsal();
    const refused = await save(off, good);
    expect(refused.statusCode, refused.body).toBe(503);
    expect(refused.json()).toMatchObject({ code: 'pictures_off' });
    expect(await stored(off)).toBeNull();
  });

  it('draws a place picture with the saved model and style', async () => {
    await boot();
    const show = await rehearsal();
    expect((await save(show, { style: 'Bold black-ink comic book art', model: OTHER_MODEL })).statusCode).toBe(200);
    const live = await request(`/api/sessions/${show.sessionId}/commands`, { commandId: randomUUID(), type: 'set_status', status: 'live', expectedStateRevision: (await director(show)).session.stateRevision });
    expect(live.statusCode, live.body).toBe(200);
    const picture = (id: string) => pool.query("SELECT status, model, prompt FROM images WHERE id=$1", [id]);
    await waitFor(async () => (await pool.query("SELECT 1 FROM images WHERE session_id=$1 AND purpose='scene' AND status='ready'", [show.sessionId])).rowCount === 1, 'the opening picture');

    const pressed = await request(`/api/sessions/${show.sessionId}/scene-picture`, {});
    expect(pressed.statusCode, pressed.body).toBe(202);
    const { imageId } = pressed.json() as { imageId: string };
    await waitFor(async () => (await picture(imageId)).rows[0].status === 'ready', 'the new picture');
    const row = (await picture(imageId)).rows[0];
    expect(row.model).toBe(OTHER_MODEL);
    expect(row.prompt.startsWith('Bold black-ink comic book art.')).toBe(true);
  });

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    assetDir = await mkdtemp(join(tmpdir(), 'rpg-picture-settings-'));
  });
  afterEach(async () => {
    await app?.close();
    app = null;
  });
  afterAll(async () => {
    await pool?.end();
    if (assetDir) await rm(assetDir, { recursive: true, force: true });
  });
});
