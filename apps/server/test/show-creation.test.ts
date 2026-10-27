import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterCardDefinition, ScenarioDefinition } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeImageProvider } from '../src/fake-images';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';

type App = Awaited<ReturnType<typeof buildApp>>;
type Reply = Awaited<ReturnType<App['inject']>>;

suite('show creation', () => {
  let pool: ReturnType<typeof createPool>;
  let assetDir: string;
  let app: App | null = null;
  let host = '';
  let starter: { scenario: ScenarioDefinition; characters: CharacterCardDefinition[] };
  const control: { gate: Promise<void> | null } = { gate: null };
  let release: () => void = () => undefined;

  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (url: string, payload?: unknown, credential = host): Promise<Reply> => app!.inject({
    method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, ...(credential ? { cookie: credential } : {}) }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  async function boot(options: { images?: boolean } = {}) {
    control.gate = null;
    const hostToken = `show-creation-test-host-${randomUUID()}`;
    const images = options.images === false ? undefined : new FakeImageProvider({ hold: () => control.gate ?? Promise.resolve() });
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, assetDir, ...(images ? { images } : {}) });
    host = cookie(await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } }));
    starter = (await request('/api/library/starter')).json();
  }
  const hold = () => {
    control.gate = new Promise<void>(resolve => { release = () => { control.gate = null; resolve(); }; });
  };
  async function customBody(adjust?: (scenario: ScenarioDefinition) => void) {
    const scenario = structuredClone(starter.scenario);
    adjust?.(scenario);
    const saved = (await request('/api/library/scenarios', { commandId: randomUUID(), expectedVersion: 0, definition: scenario })).json();
    const characters = [];
    for (const definition of starter.characters.slice(0, 2)) {
      const template = (await request('/api/library/characters', { commandId: randomUUID(), expectedVersion: 0, definition })).json();
      characters.push({ templateId: template.id, version: template.version });
    }
    return { scenario: { templateId: saved.id, version: saved.version }, characters };
  }
  const create = (extra: Record<string, unknown> = {}, commandId = randomUUID()) => request('/api/sessions', { commandId, ...extra });
  const links = async (sessionId: string) => (await pool.query('SELECT * FROM stream_links WHERE session_id=$1', [sessionId])).rows;
  const npcPictures = async (sessionId: string) => (await pool.query("SELECT subject_id, status, attach FROM images WHERE session_id=$1 AND purpose='npc' ORDER BY subject_id", [sessionId])).rows as Array<{ subject_id: string; status: string; attach: boolean }>;
  async function waitFor(check: () => Promise<boolean>, what: string) {
    const deadline = Date.now() + 8_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  async function expectMainLink(sessionId: string) {
    const rows = await links(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: 'show', label: 'Main show', can_present: true, revoked_at: null, character_id: null, producer_grant_id: null });
    const listed = (await request(`/api/sessions/${sessionId}/stream-links`)).json().links as Array<{ id: string }>;
    expect(listed).toHaveLength(1);
    const { token } = (await request(`/api/sessions/${sessionId}/stream-links/${listed[0]!.id}/link`)).json();
    const access = await app!.inject({ method: 'POST', url: '/api/stream/access', headers: { origin }, payload: { token } });
    expect(access.statusCode, access.body).toBe(200);
    expect(access.json()).toMatchObject({ sessionId, link: { id: listed[0]!.id, subject: 'show', canPresent: true } });
    const events = (await pool.query("SELECT data, command_id FROM audit_events WHERE session_id=$1 AND kind='stream_link.created'", [sessionId])).rows;
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ linkId: listed[0]!.id, subject: 'show', characterId: null, producerGrantId: null });
  }

  it('gives a practice show one active main show link', async () => {
    await boot();
    const created = await create();
    expect(created.statusCode, created.body).toBe(200);
    expect(Object.keys(created.json()).sort()).toEqual(['invites', 'sessionId']);
    await expectMainLink(created.json().sessionId);
  });

  it('gives a custom show one active main show link', async () => {
    await boot({ images: false });
    const created = await create(await customBody());
    expect(created.statusCode, created.body).toBe(200);
    await expectMainLink(created.json().sessionId);
  });

  it('adds no second link when the same command is sent again', async () => {
    await boot();
    const commandId = randomUUID();
    const first = await create({}, commandId);
    const again = await create({}, commandId);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().sessionId).toBe(first.json().sessionId);
    expect(await links(first.json().sessionId)).toHaveLength(1);
  });

  it('starts one automatic portrait for each non-player character without one', async () => {
    await boot();
    const withPortrait = randomUUID();
    let expected: string[] = [];
    const body = await customBody((scenario) => {
      scenario.npcs[0]!.portraitId = withPortrait;
      expected = scenario.npcs.slice(1).filter(npc => npc.appearance.trim() || npc.role.trim()).map(npc => npc.displayName);
    });
    expect(expected.length).toBeGreaterThan(0);
    const created = await create(body);
    expect(created.statusCode, created.body).toBe(200);
    const sessionId = created.json().sessionId as string;
    await waitFor(async () => (await npcPictures(sessionId)).length === expected.length, 'the portraits to be reserved');
    const pictures = await npcPictures(sessionId);
    expect(pictures.every(picture => picture.attach)).toBe(true);
    const npcRows = (await pool.query("SELECT id, data->>'displayName' AS name FROM npcs WHERE session_id=$1", [sessionId])).rows as Array<{ id: string; name: string }>;
    const named = pictures.map(picture => npcRows.find(row => row.id === picture.subject_id)?.name).sort();
    expect(named).toEqual([...expected].sort());
    await waitFor(async () => (await npcPictures(sessionId)).every(picture => picture.status !== 'making'), 'the portraits to finish');
  });

  it('answers before the portraits finish', async () => {
    await boot();
    hold();
    const created = await create(await customBody());
    expect(created.statusCode, created.body).toBe(200);
    const sessionId = created.json().sessionId as string;
    const pictures = await npcPictures(sessionId);
    expect(pictures.length).toBeGreaterThan(0);
    expect(pictures.every(picture => picture.status === 'making')).toBe(true);
    release();
    await waitFor(async () => (await npcPictures(sessionId)).every(picture => picture.status !== 'making'), 'the portraits to finish');
  });

  it('starts no portraits for a replayed command', async () => {
    await boot();
    const body = await customBody();
    const commandId = randomUUID();
    const first = await create(body, commandId);
    const sessionId = first.json().sessionId as string;
    await waitFor(async () => (await npcPictures(sessionId)).every(picture => picture.status !== 'making'), 'the portraits to finish');
    const before = (await npcPictures(sessionId)).length;
    expect((await create(body, commandId)).statusCode).toBe(200);
    expect(await npcPictures(sessionId)).toHaveLength(before);
    expect(await links(sessionId)).toHaveLength(1);
  });

  it('starts no portraits for a practice show or when pictures are off', async () => {
    await boot();
    const practice = await create();
    expect(await npcPictures(practice.json().sessionId)).toEqual([]);
    await app!.close();
    await boot({ images: false });
    const custom = await create(await customBody());
    expect(custom.statusCode, custom.body).toBe(200);
    expect(await npcPictures(custom.json().sessionId)).toEqual([]);
    await expectMainLink(custom.json().sessionId);
  });

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    assetDir = await mkdtemp(join(tmpdir(), 'rpg-show-creation-'));
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
