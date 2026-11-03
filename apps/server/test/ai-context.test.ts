import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { CharacterCardDefinition, DirectorSnapshot, ProviderContext, ScenarioDefinition, SessionState } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool, transaction } from '../src/database';
import { readState, saveState } from '../src/repository';
import { FakeAiProvider } from '../src/fake-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'ai-context-test-host-credential';
const OLD_PLACE = 'The Lighthouse';
const OLD_DESCRIPTION = 'ZZOLDPLACE a salt-stained tower with a cracked lamp';
const NEW_DESCRIPTION = 'ZZNEWPLACE a crowded dock under rain';

suite('where the party came from, and the AI plan on new shows', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let host: string, player: string, sessionId: string;
  let snapshot: DirectorSnapshot;
  let contexts: ProviderContext[];
  const fake = new FakeAiProvider();
  const options = { databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, providerTimeoutMs: 5000, rollDie: () => 4,
    provider: { plan: (context: ProviderContext) => { contexts.push(context); return fake.plan(context); }, render: (context: ProviderContext) => { contexts.push(context); return fake.render(context); } } };
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (path: string, payload?: Record<string, unknown>, credential = host) => app.inject({ method: payload === undefined ? 'GET' : 'POST', url: path, headers: { origin, cookie: credential }, ...(payload === undefined ? {} : { payload }) });
  const command = (value: Record<string, unknown>, credential = host) => request(`/api/sessions/${sessionId}/commands`, { commandId: randomUUID(), ...value }, credential);
  const refresh = async () => { const response = await request(`/api/sessions/${sessionId}`); expect(response.statusCode, response.body).toBe(200); snapshot = response.json(); };
  async function ok(value: Record<string, unknown>) {
    const response = await command(value);
    expect(response.statusCode, response.body).toBe(200);
    snapshot = response.json().snapshot;
    return response;
  }
  const beatCommand = (type: string, value: Record<string, unknown> = {}) => ({ type, beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, ...value });
  async function mutate(action: (state: SessionState) => void) {
    await transaction(pool, async (client) => { const state = await readState(client, sessionId); action(state); await saveState(client, state); });
    await refresh();
  }
  async function move(location: { kind: 'existing'; locationId: string } | { kind: 'new'; title: string; description: string }) {
    await ok({ type: 'change_scene', title: 'A new scene', description: 'The party arrives.', location, presentNpcIds: [],
      expectedStateRevision: snapshot.session.stateRevision, reason: 'Director adjustment', discardQueuedInput: true });
  }
  async function say() {
    const response = await command({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: snapshot.session.inputEpoch, contextBeatId: snapshot.activeBeat?.id ?? null, kind: 'say', text: 'A question for the room', recipientNpcIds: [] }, player);
    expect(response.statusCode, response.body).toBe(200);
    await refresh();
  }
  async function plan() {
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    await say();
    contexts = [];
    await ok(beatCommand('plan_beat', { submissionIds: snapshot.submissions.filter((item) => item.status === 'queued').map((item) => item.id) }));
    return contexts[0]!;
  }
  async function renderContext() {
    await ok(beatCommand('approve_stakes', { classification: 'ordinary', contracts: [] }));
    await ok(beatCommand('lock_beat'));
    contexts = [];
    await ok(beatCommand('render_beat'));
    return contexts[0]!;
  }
  async function publish() {
    await ok(beatCommand('approve_continuity', { updates: snapshot.activeBeat!.draft!.continuity }));
    await ok(beatCommand('publish_beat', { expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat!.draftRevision, textOnly: true }));
  }

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp(options);
    host = cookie(await request('/api/auth/host', { token: hostToken }, ''));
  });
  beforeEach(async () => {
    contexts = [];
    const created = (await request('/api/sessions', { commandId: randomUUID() })).json(); sessionId = created.sessionId;
    player = cookie(await request('/api/auth/redeem', { token: created.invites[0].token }, ''));
    await refresh();
    await ok({ type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });
    await mutate((state) => {
      const here = state.locations.find((location) => location.id === state.session.scene.locationId)!;
      here.title = OLD_PLACE; here.description = OLD_DESCRIPTION;
    });
  });
  afterAll(async () => { await app?.close(); await pool.end(); });

  it('names the place the party left on the first plan and script after a move to another place', async () => {
    await move({ kind: 'new', title: 'The Docks', description: NEW_DESCRIPTION });
    const planning = await plan();
    expect(planning.cameFrom).toBe(OLD_PLACE);
    expect(planning.sceneBeatCount).toBe(0);
    const rendering = await renderContext();
    expect(rendering.cameFrom).toBe(OLD_PLACE);
    expect(rendering.sceneBeatCount).toBe(0);
  });

  it('drops the arrival once a beat is published in the new scene', async () => {
    await move({ kind: 'new', title: 'The Docks', description: NEW_DESCRIPTION });
    await plan();
    await renderContext();
    await publish();
    const next = await plan();
    expect(next).not.toHaveProperty('cameFrom');
    expect(next.sceneBeatCount).toBe(1);
  });

  it('counts the beats published since the show began when no scene has changed', async () => {
    const first = await plan();
    expect(first).not.toHaveProperty('cameFrom');
    expect(first.sceneBeatCount).toBe(0);
    await renderContext();
    await publish();
    expect((await plan()).sceneBeatCount).toBe(1);
  });

  it('gives no arrival for a move within the same place', async () => {
    await move({ kind: 'existing', locationId: snapshot.locations.find((location) => location.title === OLD_PLACE)!.id });
    const planning = await plan();
    expect(planning).not.toHaveProperty('cameFrom');
    expect(planning.sceneBeatCount).toBe(0);
  });

  it('names the place of the last beat after two moves with no beat between them', async () => {
    await plan();
    await renderContext();
    await publish();
    await move({ kind: 'new', title: 'The Docks', description: NEW_DESCRIPTION });
    await move({ kind: 'new', title: 'The Market', description: 'ZZMARKET stalls in the sun' });
    const planning = await plan();
    expect(planning.cameFrom).toBe(OLD_PLACE);
    expect(planning.sceneBeatCount).toBe(0);
  });

  it('gives no arrival for a move out and straight back with no beat between', async () => {
    const oldId = snapshot.locations.find((location) => location.title === OLD_PLACE)!.id;
    await plan();
    await renderContext();
    await publish();
    await move({ kind: 'new', title: 'The Docks', description: NEW_DESCRIPTION });
    await move({ kind: 'existing', locationId: oldId });
    const planning = await plan();
    expect(planning).not.toHaveProperty('cameFrom');
    expect(planning.sceneBeatCount).toBe(0);
  });

  it('keeps the arrival when a change within the same place follows a move', async () => {
    await plan();
    await renderContext();
    await publish();
    await move({ kind: 'new', title: 'The Docks', description: NEW_DESCRIPTION });
    await move({ kind: 'existing', locationId: snapshot.session.scene.locationId });
    const planning = await plan();
    expect(planning.cameFrom).toBe(OLD_PLACE);
    expect(planning.sceneBeatCount).toBe(0);
  });

  it('never stores a place description in any AI request', async () => {
    await move({ kind: 'new', title: 'The Docks', description: NEW_DESCRIPTION });
    await plan();
    await renderContext();
    const rows = (await pool.query('SELECT input FROM generation_jobs WHERE session_id=$1', [sessionId])).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const text = JSON.stringify(row.input);
      expect(text).toContain(OLD_PLACE);
      expect(text).not.toContain('ZZOLDPLACE');
      expect(text).not.toContain('ZZNEWPLACE');
    }
  });

  describe('a new custom show', () => {
    const PLAN = 'ZZPLAN The ferryman is the thief; steer every scene toward the harbor.';
    async function createShow(aiPlan?: string) {
      const starter = (await request('/api/library/starter')).json() as { scenario: ScenarioDefinition; characters: CharacterCardDefinition[] };
      const scenario = structuredClone(starter.scenario);
      if (aiPlan !== undefined) scenario.aiPlan = aiPlan; else delete scenario.aiPlan;
      const saved = (await request('/api/library/scenarios', { commandId: randomUUID(), expectedVersion: 0, definition: scenario })).json();
      expect(saved.id, JSON.stringify(saved)).toBeTruthy();
      const characters = [];
      for (const definition of starter.characters.slice(0, 2)) {
        const template = (await request('/api/library/characters', { commandId: randomUUID(), expectedVersion: 0, definition })).json();
        characters.push({ templateId: template.id, version: template.version });
      }
      const created = await request('/api/sessions', { commandId: randomUUID(), scenario: { templateId: saved.id, version: saved.version }, characters });
      expect(created.statusCode, created.body).toBe(200);
      return created.json() as { sessionId: string; invites: Array<{ role: string; token: string }> };
    }
    const view = async (id: string, credential: string) => (await request(`/api/sessions/${id}`, undefined, credential)).json();

    it('copies the scenario\'s AI plan into the show, and no player or stage page carries it', async () => {
      const created = await createShow(PLAN);
      const director = await view(created.sessionId, host);
      expect(director.guidance.storyPlan).toBe(PLAN);
      for (const role of ['player', 'stage']) {
        const invite = created.invites.find((item) => item.role === role)!;
        const credential = cookie(await request('/api/auth/redeem', { token: invite.token }, ''));
        const body = JSON.stringify(await view(created.sessionId, credential));
        expect(body).not.toContain('ZZPLAN');
      }
    });

    it('starts with an empty plan when the scenario has none', async () => {
      const created = await createShow();
      expect((await view(created.sessionId, host)).guidance.storyPlan).toBe('');
    });
  });
});
