import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AiCallOptions, AiDraft, DirectorSnapshot, PlanResult, PlayerSnapshot, ProviderContext, SessionState, StageSnapshot } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool, transaction } from '../src/database';
import { readState, saveState } from '../src/repository';
import { FakeAiProvider } from '../src/fake-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'round-facts-test-host-credential';

suite('what a snapshot says about the open round', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let host: string, stage: string, sessionId: string;
  let players: string[], ids: string[];
  let snapshot: DirectorSnapshot;
  const dice: number[] = [];
  const fake = new FakeAiProvider();
  let plan: (context: ProviderContext, options?: AiCallOptions) => Promise<PlanResult>;
  let render: (context: ProviderContext, options?: AiCallOptions) => Promise<AiDraft>;
  const held: Array<() => void> = [];
  const pendings: Array<Promise<unknown>> = [];
  const options = { databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, providerTimeoutMs: 5000, rollDie: () => dice.shift() ?? 4,
    provider: { plan: (context: ProviderContext, callOptions?: AiCallOptions) => plan(context, callOptions), render: (context: ProviderContext, callOptions?: AiCallOptions) => render(context, callOptions) } };
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (path: string, payload?: Record<string, unknown>, credential = host) => app.inject({ method: payload === undefined ? 'GET' : 'POST', url: path, headers: { origin, cookie: credential }, ...(payload === undefined ? {} : { payload }) });
  const command = (value: Record<string, unknown>, credential = host) => request(`/api/sessions/${sessionId}/commands`, { commandId: randomUUID(), ...value }, credential);
  const refresh = async () => { const response = await request(`/api/sessions/${sessionId}`); expect(response.statusCode, response.body).toBe(200); snapshot = response.json(); };
  const viewAs = async <T>(credential: string) => { const response = await request(`/api/sessions/${sessionId}`, undefined, credential); expect(response.statusCode, response.body).toBe(200); return response.json() as T; };
  async function ok(value: Record<string, unknown>, credential = host) {
    const response = await command(value, credential);
    expect(response.statusCode, response.body).toBe(200);
    if (credential === host) snapshot = response.json().snapshot;
    return response;
  }
  const beatCommand = (type: string, value: Record<string, unknown> = {}) => ({ type, beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, ...value });
  async function mutate(action: (state: SessionState) => void) {
    await transaction(pool, async (client) => { const state = await readState(client, sessionId); action(state); await saveState(client, state); });
    await refresh();
  }
  const setCondition = (id: string, condition: 'down' | 'dead', strain = 8) => mutate((state) => { const item = state.characters.find((entry) => entry.id === id)!; item.condition = condition; item.strain = strain; });
  async function line(index: number, text: string, kind: 'say' | 'act' = 'say') {
    const response = await command({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: snapshot.session.inputEpoch, contextBeatId: snapshot.activeBeat?.id ?? null,
      kind, text, recipientNpcIds: [], ...(kind === 'act' ? { intent: 'Open the archive', approach: 'Study the latch' } : {}) }, players[index]);
    expect(response.statusCode, response.body).toBe(200);
    await refresh();
  }
  const queuedFor = (characterId: string) => snapshot.submissions.filter((item) => item.characterId === characterId && item.status === 'queued').map((item) => item.id);
  const open = (kind: 'conversation' | 'action' = 'conversation') => ok({ type: 'open_beat', kind, expectedInputEpoch: snapshot.session.inputEpoch });
  // Holds the AI until the test lets it answer.
  function holdPlan() {
    let signal: AbortSignal | undefined;
    plan = (_context, callOptions) => { signal = callOptions?.signal; return new Promise<PlanResult>((resolve) => { held.push(() => resolve({ classification: 'ordinary', contracts: [], directorSummary: '' })); }); };
    return () => signal;
  }
  const planInFlight = async (speaker = 1) => {
    await line(speaker, 'Stay with me, please');
    const seen = holdPlan();
    const pending = command(beatCommand('plan_beat', { submissionIds: queuedFor(ids[speaker]!) }));
    pendings.push(pending);
    await vi.waitFor(() => expect(seen()).toBeDefined(), { timeout: 2000, interval: 10 });
    return { pending };
  };
  const publicBeat = async (credential: string) => (await viewAs<PlayerSnapshot | StageSnapshot>(credential)).activeBeat!;
  const directorBeat = async () => (await viewAs<DirectorSnapshot>(host)).activeBeat! as unknown as Record<string, unknown>;

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp(options);
    host = cookie(await request('/api/auth/host', { token: hostToken }, ''));
  });
  beforeEach(async () => {
    dice.length = 0; held.length = 0; pendings.length = 0;
    plan = (context, callOptions) => fake.plan(context, callOptions); render = (context, callOptions) => fake.render(context, callOptions);
    const created = (await request('/api/sessions', { commandId: randomUUID() })).json(); sessionId = created.sessionId;
    const seats = created.invites.filter((invite: { role: string }) => invite.role === 'player').slice(0, 2);
    players = []; ids = [];
    for (const invite of seats) { players.push(cookie(await request('/api/auth/redeem', { token: invite.token }, ''))); ids.push(invite.characterId); }
    const stageInvite = created.invites.find((invite: { role: string }) => invite.role === 'stage');
    stage = cookie(await request('/api/auth/redeem', { token: stageInvite.token }, ''));
    await refresh();
    await ok({ type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });
  });
  afterEach(async () => { for (const release of held) release(); await Promise.allSettled(pendings); });
  afterAll(async () => { await app?.close(); await pool.end(); });

  describe('planning', () => {
    it('is false with no plan running, and the director round has no such key', async () => {
      await open();
      await line(1, 'Stay with me, please');
      for (const credential of [players[0]!, players[1]!, stage]) expect((await publicBeat(credential)).planning).toBe(false);
      expect(await directorBeat()).not.toHaveProperty('planning');
      expect(await directorBeat()).not.toHaveProperty('lastChanceFor');
    });

    it('is true for players and the stage while a plan request is waiting, and false once it answers', async () => {
      await open();
      const { pending } = await planInFlight();
      for (const credential of [players[0]!, players[1]!, stage]) expect((await publicBeat(credential)).planning).toBe(true);
      expect(await directorBeat()).not.toHaveProperty('planning');
      held.forEach((release) => release());
      expect((await pending).statusCode).toBe(200);
      for (const credential of [players[1]!, stage]) expect((await publicBeat(credential)).planning).toBe(false);
    });

    it('is false after a plan fails', async () => {
      await open();
      await line(1, 'Stay with me, please');
      plan = () => Promise.reject(new Error('The AI is down.'));
      await command(beatCommand('plan_beat', { submissionIds: queuedFor(ids[1]!) }));
      expect((await publicBeat(players[1]!)).planning).toBe(false);
    });

    it('is false after Rest throws the plan away', async () => {
      await mutate((state) => { state.characters[0]!.strain = 3; });
      await open();
      await planInFlight();
      expect((await publicBeat(stage)).planning).toBe(true);
      await ok({ type: 'rest', expectedStateRevision: snapshot.session.stateRevision });
      expect((await publicBeat(stage)).planning).toBe(false);
      expect((await publicBeat(players[1]!)).planning).toBe(false);
    });

    it('is false after a player changes a line that is in the plan', async () => {
      await open();
      await planInFlight();
      await refresh();
      const current = snapshot.submissions.find((item) => item.characterId === ids[1] && ['queued', 'selected'].includes(item.status))!;
      expect((await publicBeat(stage)).planning).toBe(true);
      await ok({ type: 'save_submission', submissionId: current.id, expectedSubmissionRevision: current.revision, expectedInputEpoch: snapshot.session.inputEpoch, contextBeatId: snapshot.activeBeat!.id,
        kind: 'say', text: 'Actually, stay a little longer', recipientNpcIds: [] }, players[1]!);
      expect((await publicBeat(stage)).planning).toBe(false);
      expect((await publicBeat(players[0]!)).planning).toBe(false);
    });

    it('is false after a player takes back a line that is in the plan', async () => {
      await open();
      await planInFlight();
      await refresh();
      const current = snapshot.submissions.find((item) => item.characterId === ids[1] && ['queued', 'selected'].includes(item.status))!;
      expect((await publicBeat(stage)).planning).toBe(true);
      await ok({ type: 'cancel_submission', submissionId: current.id, expectedSubmissionRevision: current.revision }, players[1]!);
      expect((await publicBeat(stage)).planning).toBe(false);
    });

    it('is false when the plan job row is marked cancelled', async () => {
      await open();
      await planInFlight();
      expect((await publicBeat(stage)).planning).toBe(true);
      await pool.query("UPDATE generation_jobs SET status='cancelled', finished_at=now() WHERE session_id=$1", [sessionId]);
      expect((await publicBeat(stage)).planning).toBe(false);
      expect((await publicBeat(players[1]!)).planning).toBe(false);
    });

    it('is never true while a script is being written', async () => {
      await open();
      await line(1, 'Stay with me, please');
      await ok(beatCommand('plan_beat', { submissionIds: queuedFor(ids[1]!) }));
      await ok(beatCommand('approve_stakes', { classification: 'ordinary', contracts: [] }));
      await ok(beatCommand('lock_beat'));
      let signal: AbortSignal | undefined;
      render = (_context, callOptions) => { signal = callOptions?.signal; return new Promise<AiDraft>(() => undefined); };
      const pending = command(beatCommand('render_beat'));
      pendings.push(pending);
      await vi.waitFor(() => expect(signal).toBeDefined(), { timeout: 2000, interval: 10 });
      const running = (await pool.query("SELECT task,status FROM generation_jobs WHERE session_id=$1 AND status IN ('queued','running')", [sessionId])).rows;
      expect(running).toEqual([{ task: 'render', status: 'running' }]);
      for (const credential of [players[1]!, stage]) expect((await publicBeat(credential)).planning).toBe(false);
      await pool.query("UPDATE generation_jobs SET status='cancelled', finished_at=now() WHERE session_id=$1", [sessionId]);
    });

    it('is not shown for a plan that belongs to an older try of the round', async () => {
      await open();
      await planInFlight();
      await pool.query("UPDATE generation_jobs SET generation=generation-1 WHERE session_id=$1", [sessionId]);
      expect((await publicBeat(stage)).planning).toBe(false);
    });
  });

  describe('last chance', () => {
    it('lists a downed character while the round takes lines and while the stakes are reviewed, and nobody who is up or dead', async () => {
      await setCondition(ids[0]!, 'down');
      await open();
      for (const credential of [players[0]!, players[1]!, stage]) expect((await publicBeat(credential)).lastChanceFor).toEqual([ids[0]]);
      await line(1, 'Stay with me, please');
      await ok(beatCommand('plan_beat', { submissionIds: queuedFor(ids[1]!) }));
      expect(snapshot.activeBeat!.phase).toBe('stakes_review');
      for (const credential of [players[0]!, stage]) expect((await publicBeat(credential)).lastChanceFor).toEqual([ids[0]]);
      await setCondition(ids[0]!, 'dead');
      expect((await publicBeat(stage)).lastChanceFor).toEqual([]);
    });

    it('is an empty list when nobody is down', async () => {
      await open();
      expect((await publicBeat(stage)).lastChanceFor).toEqual([]);
      expect((await publicBeat(players[0]!)).lastChanceFor).toEqual([]);
    });

    it('keeps a downed character listed once the dice are rolled, with no roll in the public round', async () => {
      await setCondition(ids[0]!, 'down');
      await open();
      await line(1, 'Stay with me, please');
      await ok(beatCommand('plan_beat', { submissionIds: queuedFor(ids[1]!) }));
      await ok(beatCommand('approve_stakes', { classification: 'ordinary', contracts: [] }));
      dice.push(5, 6);
      await ok(beatCommand('lock_beat'));
      expect(snapshot.activeBeat!.phase).toBe('locked');
      expect(snapshot.activeBeat!.resolution!.rolls.filter((roll) => roll.lastChance).map((roll) => roll.actorCharacterId)).toEqual([ids[0]]);
      for (const credential of [players[0]!, players[1]!, stage]) {
        const beat = await publicBeat(credential);
        expect(beat.lastChanceFor).toEqual([ids[0]]);
        expect(Object.keys(beat).sort()).toEqual(['id', 'kind', 'lastChanceFor', 'locked', 'phase', 'planning', 'revision', 'stakes', 'stakesApproved']);
        expect(JSON.stringify(beat)).not.toMatch(/"(rolls|total|band|faces|resolution)"/);
      }
      await ok(beatCommand('render_beat'));
      expect(snapshot.activeBeat!.phase).toBe('draft_review');
      expect((await publicBeat(stage)).lastChanceFor).toEqual([ids[0]]);
    });

    it('keeps a character a rescue saved on the list after the dice, so the list never gives a rescue away before the beat is published', async () => {
      await setCondition(ids[0]!, 'down', 5);
      await open('action');
      await line(1, 'Hold on, I am coming');
      await ok(beatCommand('plan_beat', { submissionIds: queuedFor(ids[1]!) }));
      expect((await publicBeat(stage)).lastChanceFor).toEqual([ids[0]]);
      const contracts = structuredClone(snapshot.activeBeat!.contracts);
      for (const contract of contracts) {
        contract.outcomes.clean.effects = [{ kind: 'character_rescue', characterId: ids[0]! }];
        contract.outcomes.costly.effects = [{ kind: 'character_rescue', characterId: ids[0]! }];
        contract.outcomes.setback.effects = [];
        if (contract.outcomes.critical) contract.outcomes.critical.effects = [];
      }
      await ok(beatCommand('approve_stakes', { classification: 'action', contracts }));
      dice.push(6, 6, 1, 1);
      await ok(beatCommand('lock_beat'));
      expect(snapshot.activeBeat!.resolution!.rolls.some((roll) => roll.lastChance)).toBe(false);
      for (const credential of [players[0]!, players[1]!, stage]) expect((await publicBeat(credential)).lastChanceFor).toEqual([ids[0]]);
      await ok(beatCommand('render_beat'));
      expect((await publicBeat(stage)).lastChanceFor).toEqual([ids[0]]);
    });

    it('is always empty for a Narrate the scene beat, even with someone down', async () => {
      await setCondition(ids[0]!, 'down');
      await ok({ type: 'narrate_scene', expectedInputEpoch: snapshot.session.inputEpoch });
      expect(snapshot.activeBeat!.phase).toBe('locked');
      for (const credential of [players[0]!, stage]) {
        const beat = await publicBeat(credential);
        expect(beat.lastChanceFor).toEqual([]);
        expect(beat.planning).toBe(false);
      }
    });
  });

  describe('a plan thrown away', () => {
    const insertEvent = async (kind: 'save_submission' | 'cancel_submission', data: Record<string, unknown>) => {
      await pool.query('INSERT INTO audit_events(id,session_id,actor_id,command_id,kind,data) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), sessionId, randomUUID(), randomUUID(), kind, data]);
    };
    const thrown = (overrides: Record<string, unknown> = {}) => ({ planThrownAway: { beatId: snapshot.activeBeat!.id, beatRevision: snapshot.activeBeat!.revision, characterId: ids[1], ...overrides } });
    const director = async () => viewAs<DirectorSnapshot>(host);

    beforeEach(async () => { await open(); await line(1, 'Stay with me, please'); });

    it('is absent when no player has changed a planned line', async () => {
      expect(await director()).not.toHaveProperty('planThrownAway');
    });

    it('names the player and says changed for a save_submission event', async () => {
      await insertEvent('save_submission', thrown());
      expect((await director()).planThrownAway).toEqual({ characterId: ids[1], change: 'changed' });
    });

    it('says took_back for a cancel_submission event', async () => {
      await insertEvent('cancel_submission', { submissionId: randomUUID(), ...thrown() });
      expect((await director()).planThrownAway).toEqual({ characterId: ids[1], change: 'took_back' });
    });

    it('is absent when the event belongs to an older revision of the round', async () => {
      await insertEvent('save_submission', thrown({ beatRevision: snapshot.activeBeat!.revision - 1 }));
      expect(await director()).not.toHaveProperty('planThrownAway');
    });

    it('is absent when the event is for another round', async () => {
      await insertEvent('save_submission', thrown({ beatId: randomUUID() }));
      expect(await director()).not.toHaveProperty('planThrownAway');
    });

    it('goes away by itself when the director moves the round on', async () => {
      await insertEvent('save_submission', thrown());
      expect((await director()).planThrownAway).toBeDefined();
      await ok(beatCommand('plan_beat', { submissionIds: queuedFor(ids[1]!) }));
      expect(await director()).not.toHaveProperty('planThrownAway');
    });

    it('is absent when the round is not taking lines, even for a matching event', async () => {
      await ok(beatCommand('plan_beat', { submissionIds: queuedFor(ids[1]!) }));
      expect(snapshot.activeBeat!.phase).toBe('stakes_review');
      await insertEvent('save_submission', thrown());
      expect(await director()).not.toHaveProperty('planThrownAway');
    });

    it('reads the newest event for this round only', async () => {
      await insertEvent('save_submission', thrown());
      await insertEvent('cancel_submission', { submissionId: randomUUID(), ...thrown({ beatRevision: snapshot.activeBeat!.revision - 1 }) });
      expect(await director()).not.toHaveProperty('planThrownAway');
      await insertEvent('cancel_submission', { submissionId: randomUUID(), ...thrown({ characterId: ids[0] }) });
      expect((await director()).planThrownAway).toEqual({ characterId: ids[0], change: 'took_back' });
    });

    it('ignores other event kinds that carry the same data', async () => {
      await pool.query('INSERT INTO audit_events(id,session_id,actor_id,command_id,kind,data) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), sessionId, randomUUID(), randomUUID(), 'rest', thrown()]);
      expect(await director()).not.toHaveProperty('planThrownAway');
    });

    it('never reaches a player or the stage', async () => {
      await insertEvent('save_submission', thrown());
      for (const credential of [players[0]!, players[1]!, stage]) {
        const view = await viewAs<Record<string, unknown>>(credential);
        expect(view).not.toHaveProperty('planThrownAway');
        expect(JSON.stringify(view)).not.toContain('beatRevision');
      }
    });
  });
});
