import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EMPTY_GUIDANCE, type DirectorSnapshot, type PlanResult, type ProviderContext, type SessionState } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool, transaction } from '../src/database';
import { readState, saveState } from '../src/repository';
import { FakeAiProvider } from '../src/fake-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'director-guidance-test-host-credential';

suite('private director guidance', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let host: string, player: string, stage: string, sessionId: string;
  let snapshot: DirectorSnapshot;
  let contexts: ProviderContext[];
  const fake = new FakeAiProvider();
  let plan: (context: ProviderContext) => Promise<PlanResult>;
  const options = { databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, providerTimeoutMs: 5000, rollDie: () => 4,
    provider: { plan: (context: ProviderContext) => { contexts.push(context); return plan(context); }, render: (context: ProviderContext) => { contexts.push(context); return fake.render(context); } } };
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
  const guide = (value: Record<string, unknown>) => ok({ type: 'set_guidance', ...value });
  const beatCommand = (type: string, value: Record<string, unknown> = {}) => ({ type, beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, ...value });
  async function mutate(action: (state: SessionState) => void) {
    await transaction(pool, async (client) => { const state = await readState(client, sessionId); action(state); await saveState(client, state); });
    await refresh();
  }
  async function say(recipientNpcIds: string[] = []) {
    const response = await command({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: snapshot.session.inputEpoch, contextBeatId: snapshot.activeBeat?.id ?? null, kind: 'say', text: 'A question for the room', recipientNpcIds }, player);
    expect(response.statusCode, response.body).toBe(200);
    await refresh();
  }
  const queued = () => snapshot.submissions.filter((item) => item.status === 'queued' || item.status === 'selected').map((item) => item.id);
  async function openConversation(recipientNpcIds: string[] = []) {
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    await say(recipientNpcIds);
  }
  const planContext = async () => {
    contexts = [];
    await ok(beatCommand('plan_beat', { submissionIds: queued() }));
    return contexts[0]!;
  };
  const names = (context: ProviderContext) => context.state.npcs.map((npc) => npc.displayName);

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp(options);
    host = cookie(await request('/api/auth/host', { token: hostToken }, ''));
  });
  beforeEach(async () => {
    contexts = []; plan = (value) => fake.plan(value);
    const created = (await request('/api/sessions', { commandId: randomUUID() })).json(); sessionId = created.sessionId;
    player = cookie(await request('/api/auth/redeem', { token: created.invites[0].token }, ''));
    stage = cookie(await request('/api/auth/redeem', { token: created.invites.at(-1).token }, ''));
    await refresh();
    await ok({ type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });
  });
  afterAll(async () => { await app?.close(); await pool.end(); });

  // Four non-player characters: two in the room, one far away with no way to talk, one far away on the radio.
  async function cast() {
    const base = structuredClone(snapshot.npcDetails[0]!);
    await pool.query('DELETE FROM npcs WHERE session_id=$1', [sessionId]);
    await mutate((state) => {
      const here = state.session.scene.locationId;
      const away = state.locations.find((location) => location.id !== here)?.id ?? randomUUID();
      const make = (displayName: string, status: 'present' | 'offstage', locationId: string, communicationChannel: string | null) => ({ ...structuredClone(base), id: randomUUID(), displayName, aliases: [], knowledge: [], relationships: [], secrets: [], status, locationId, communicationChannel, version: 0 });
      state.npcs = [make('Alma Here', 'present', here, null), make('Bram Here', 'present', here, null), make('Cora Away', 'offstage', away, null), make('Dov Radio', 'offstage', away, 'radio')];
    });
    const id = (name: string) => snapshot.npcDetails.find((npc) => npc.displayName === name)!.id;
    return { alma: id('Alma Here'), bram: id('Bram Here'), cora: id('Cora Away'), dov: id('Dov Radio') };
  }

  it('gives a new show empty guidance on the director snapshot and none on any other snapshot', async () => {
    expect(snapshot.guidance).toEqual(EMPTY_GUIDANCE);
    await pool.query("UPDATE sessions SET guidance='{}'::jsonb WHERE id=$1", [sessionId]);
    await refresh(); expect(snapshot.guidance).toEqual(EMPTY_GUIDANCE);
    await guide({ standingNote: 'Keep the fog thick.', storyPlan: 'The ferryman is the thief.' });
    expect((await request(`/api/sessions/${sessionId}?view=stage`)).json()).not.toHaveProperty('guidance');
    for (const credential of [player, stage]) {
      const body = (await request(`/api/sessions/${sessionId}`, undefined, credential)).body;
      expect(JSON.parse(body)).not.toHaveProperty('guidance');
      expect(body).not.toContain('Keep the fog thick.'); expect(body).not.toContain('The ferryman is the thief.');
    }
    const result = (await command({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: snapshot.session.inputEpoch, contextBeatId: null, kind: 'ooc', text: 'hello' }, player)).json();
    expect(result.snapshot).not.toHaveProperty('guidance');
  });

  it('keeps unsent fields on a partial save and records before and after', async () => {
    const { alma } = await cast();
    const first = await guide({ standingNote: '  Fog on the water.  ' });
    expect(snapshot.guidance).toEqual({ storyPlan: '', standingNote: 'Fog on the water.', aiCastNpcIds: [] });
    await guide({ aiCastNpcIds: [alma] });
    expect(snapshot.guidance).toEqual({ storyPlan: '', standingNote: 'Fog on the water.', aiCastNpcIds: [alma] });
    const third = await guide({ storyPlan: 'Plan for later.' });
    expect(snapshot.guidance).toEqual({ storyPlan: 'Plan for later.', standingNote: 'Fog on the water.', aiCastNpcIds: [alma] });
    await guide({ standingNote: '' });
    expect(snapshot.guidance).toEqual({ storyPlan: 'Plan for later.', standingNote: '', aiCastNpcIds: [alma] });
    const firstEvent = (await pool.query("SELECT kind,data FROM audit_events WHERE command_id=$1", [first.json().commandId])).rows;
    expect(firstEvent).toHaveLength(1); expect(firstEvent[0].kind).toBe('set_guidance');
    expect(firstEvent[0].data).toEqual({ before: EMPTY_GUIDANCE, after: { storyPlan: '', standingNote: 'Fog on the water.', aiCastNpcIds: [] } });
    const thirdEvent = (await pool.query("SELECT data FROM audit_events WHERE command_id=$1", [third.json().commandId])).rows[0].data;
    expect(thirdEvent.before).toEqual({ storyPlan: '', standingNote: 'Fog on the water.', aiCastNpcIds: [alma] });
    expect(thirdEvent.after.storyPlan).toBe('Plan for later.');
  });

  it('saves while paused with no open beat, and changes nothing else', async () => {
    await mutate(() => {});
    await openConversation();
    await ok(beatCommand('plan_beat', { submissionIds: queued() }));
    expect(snapshot.activeBeat!.phase).toBe('stakes_review');
    await ok({ type: 'set_status', status: 'paused', expectedStateRevision: snapshot.session.stateRevision });
    const before = snapshot; const { alma } = await cast();
    const pausedBefore = snapshot;
    await guide({ standingNote: 'Paused note', aiCastNpcIds: [alma] });
    expect(snapshot.session.status).toBe('paused');
    expect(snapshot.session.stateRevision).toBe(pausedBefore.session.stateRevision);
    expect(snapshot.session.inputEpoch).toBe(pausedBefore.session.inputEpoch);
    expect(snapshot.submissions).toEqual(pausedBefore.submissions);
    expect(snapshot.activeBeat).toEqual(pausedBefore.activeBeat);
    expect(snapshot.activeBeat!.phase).toBe('stakes_review');
    expect(before.session.inputEpoch).toBe(pausedBefore.session.inputEpoch);
    await ok({ type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });
    await ok(beatCommand('abort_beat', { reason: 'Clearing the table' }));
    expect(snapshot.activeBeat).toBeNull();
    await ok({ type: 'set_status', status: 'paused', expectedStateRevision: snapshot.session.stateRevision });
    const quiet = snapshot;
    await guide({ standingNote: 'No beat open' });
    expect(snapshot.guidance!.standingNote).toBe('No beat open');
    expect(snapshot.session.stateRevision).toBe(quiet.session.stateRevision); expect(snapshot.session.inputEpoch).toBe(quiet.session.inputEpoch);
  });

  it('refuses players and stream pages, unknown characters and empty commands', async () => {
    const { alma } = await cast();
    await say();
    const before = snapshot;
    for (const credential of [player, stage]) expect((await command({ type: 'set_guidance', standingNote: 'x' }, credential)).statusCode).toBe(403);
    const unknown = await command({ type: 'set_guidance', aiCastNpcIds: [alma, randomUUID()] });
    expect(unknown.statusCode).toBe(409); expect(unknown.json().message ?? unknown.body).toContain('A chosen character is not in this show.');
    expect((await command({ type: 'set_guidance' })).statusCode).toBe(400);
    expect((await command({ type: 'set_guidance', aiCastNpcIds: [alma, alma] })).statusCode).toBe(400);
    await refresh(); expect(snapshot.guidance).toEqual(EMPTY_GUIDANCE);
    expect(snapshot.session.stateRevision).toBe(before.session.stateRevision);
    expect(Number((await pool.query("SELECT count(*) FROM audit_events WHERE session_id=$1 AND kind='set_guidance'", [sessionId])).rows[0].count)).toBe(0);
  });

  it('lets a running plan finish with the context it started with, then uses the new guidance on the next request', async () => {
    await openConversation();
    let finish!: (result: PlanResult) => void;
    let started = false;
    plan = (context) => { started = true; return new Promise<PlanResult>((resolve) => { finish = (result) => resolve(result); void context; }); };
    contexts = [];
    const pending = command(beatCommand('plan_beat', { submissionIds: queued() }));
    const deadline = Date.now() + 3000;
    while (!started && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toBe(true);
    const running = contexts[0]!;
    await refresh();
    const revision = snapshot.session.stateRevision, epoch = snapshot.session.inputEpoch;
    await guide({ standingNote: 'Saved mid-flight' });
    expect(snapshot.session.stateRevision).toBe(revision); expect(snapshot.session.inputEpoch).toBe(epoch);
    finish(await fake.plan(running));
    const response = await pending;
    expect(response.statusCode, response.body).toBe(200);
    await refresh();
    expect(snapshot.jobs.at(-1)!.status).toBe('succeeded');
    expect(snapshot.activeBeat!.phase).toBe('stakes_review');
    expect(running).not.toHaveProperty('standingNote');
    plan = (value) => fake.plan(value);
    const next = await planContext();
    expect(next.standingNote).toBe('Saved mid-flight');
  });

  describe('what the AI is shown', () => {
    it('sends ticked characters who are here, but not ticked characters who are away', async () => {
      const { alma, cora } = await cast();
      await openConversation();
      await guide({ aiCastNpcIds: [alma, cora] });
      const context = await planContext();
      expect(names(context)).toEqual(['Alma Here']);
      expect(context.aiCastNpcIds).toEqual([alma]);
      expect(context.state.npcs.every((npc) => npc.secrets.length === 0 && npc.hiddenIdentity === null)).toBe(true);
    });

    it('adds characters the players name, here or on the radio, to the ticked ones', async () => {
      const { alma, bram, dov } = await cast();
      await guide({ aiCastNpcIds: [alma] });
      await openConversation([bram, dov]);
      const context = await planContext();
      expect(names(context)).toEqual(['Alma Here', 'Bram Here', 'Dov Radio']);
      expect(context.aiCastNpcIds).toEqual([alma]);
    });

    it('keeps today\'s context when nothing is ticked or every ticked character is away', async () => {
      const { cora } = await cast();
      await openConversation();
      const plain = await planContext();
      expect(names(plain)).toEqual(['Alma Here', 'Bram Here', 'Dov Radio']);
      expect(plain).not.toHaveProperty('aiCastNpcIds'); expect(plain).not.toHaveProperty('standingNote');
      await guide({ aiCastNpcIds: [cora] });
      const away = await planContext();
      expect(away.state.npcs).toEqual(plain.state.npcs);
      expect(Object.keys(away).sort()).toEqual(Object.keys(plain).sort());
      expect(away).not.toHaveProperty('aiCastNpcIds');
    });

    it('keeps today\'s rule of naming only the addressed characters when nothing is ticked', async () => {
      const { bram } = await cast();
      await openConversation([bram]);
      const named = await planContext();
      expect(names(named)).toEqual(['Bram Here']);
      expect(named).not.toHaveProperty('aiCastNpcIds');
    });

    it('adds the standing note to plans and scripts, and never sends the story plan', async () => {
      const { alma } = await cast();
      await guide({ standingNote: 'Keep the fog thick.', storyPlan: 'SECRET-PLAN-TEXT', aiCastNpcIds: [alma] });
      await openConversation();
      const planning = await planContext();
      expect(planning.standingNote).toBe('Keep the fog thick.');
      await ok(beatCommand('approve_stakes', { classification: 'ordinary', contracts: [] }));
      await ok(beatCommand('lock_beat'));
      contexts = [];
      await ok(beatCommand('render_beat'));
      expect(contexts[0]!.standingNote).toBe('Keep the fog thick.');
      for (const context of [planning, contexts[0]!]) expect(JSON.stringify(context)).not.toContain('SECRET-PLAN-TEXT');
      const stored = (await pool.query('SELECT input FROM generation_jobs WHERE session_id=$1', [sessionId])).rows;
      expect(JSON.stringify(stored)).not.toContain('SECRET-PLAN-TEXT');
      await guide({ standingNote: '' });
      await ok(beatCommand('render_beat'));
      expect(contexts.at(-1)).not.toHaveProperty('standingNote');
    });
  });
});
