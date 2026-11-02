import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AiDraft, DirectorSnapshot, PlanResult, ProviderContext, SessionState } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool, transaction } from '../src/database';
import { readState, saveState } from '../src/repository';
import { FakeAiProvider } from '../src/fake-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'cast-and-rest-test-host-credential';
const messages = {
  castLobby: 'Start the show before changing who is here.',
  restLobby: 'Start the show before anyone rests.',
  rolled: 'Publish or abandon this round first.',
  running: 'The AI is planning or writing right now. Wait for it to finish, then try again.',
  stale: 'The show changed. Look again, then save.',
  unknownNpc: 'A chosen character is not in this show.',
  noChange: 'Nobody changed. Tick or untick someone first.',
  nobodyStrained: 'Nobody has strain to rest.',
};

suite('who is here and rest', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let host: string, player: string, stage: string, sessionId: string;
  let snapshot: DirectorSnapshot;
  let here: string, away: string, elsewhere: string;
  const fake = new FakeAiProvider();
  let plan: (context: ProviderContext) => Promise<PlanResult>;
  let render: (context: ProviderContext) => Promise<AiDraft>;
  const options = { databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, providerTimeoutMs: 5000, rollDie: () => 4,
    provider: { plan: (context: ProviderContext) => plan(context), render: (context: ProviderContext) => render(context) } };
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
  async function refused(value: Record<string, unknown>, status: number, message?: string) {
    const response = await command(value);
    expect(response.statusCode, response.body).toBe(status);
    if (message) expect(response.json().message).toBe(message);
    return response;
  }
  const beatCommand = (type: string, value: Record<string, unknown> = {}) => ({ type, beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, ...value });
  const cast = (ids: string[], value: Record<string, unknown> = {}) => ({ type: 'set_cast', expectedStateRevision: snapshot.session.stateRevision, presentNpcIds: ids, ...value });
  const rest = (value: Record<string, unknown> = {}) => ({ type: 'rest', expectedStateRevision: snapshot.session.stateRevision, ...value });
  const characterId = () => snapshot.characterDetails[0]!.id;
  const strain = () => snapshot.characters.find((item) => item.id === characterId())!.strain;
  const hereNow = () => snapshot.npcDetails.filter((npc) => npc.status === 'present' && npc.locationId === snapshot.session.scene.locationId).map((npc) => npc.id).sort();
  const npc = (id: string) => snapshot.npcDetails.find((item) => item.id === id)!;
  async function mutate(action: (state: SessionState) => void) {
    await transaction(pool, async (client) => { const state = await readState(client, sessionId); action(state); await saveState(client, state); });
    await refresh();
  }
  async function line(kind: 'say' | 'act') {
    const body = kind === 'say' ? { kind, text: 'A question for the room', recipientNpcIds: [] } : { kind, text: '', intent: 'Open the archive', approach: 'Study the latch' };
    const response = await command({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: snapshot.session.inputEpoch, contextBeatId: snapshot.activeBeat?.id ?? null, ...body }, player);
    expect(response.statusCode, response.body).toBe(200);
    await refresh();
  }
  const queued = () => snapshot.submissions.filter((item) => item.status === 'queued' || item.status === 'selected').map((item) => item.id);
  const auditRows = async (commandId: string) => (await pool.query('SELECT kind,data FROM audit_events WHERE command_id=$1', [commandId])).rows;
  const auditCount = async (kind: string) => Number((await pool.query('SELECT count(*) FROM audit_events WHERE session_id=$1 AND kind=$2', [sessionId, kind])).rows[0].count);

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp(options);
    host = cookie(await request('/api/auth/host', { token: hostToken }, ''));
  });
  beforeEach(async () => {
    plan = (value) => fake.plan(value); render = (value) => fake.render(value);
    const created = (await request('/api/sessions', { commandId: randomUUID() })).json(); sessionId = created.sessionId;
    player = cookie(await request('/api/auth/redeem', { token: created.invites[0].token }, ''));
    stage = cookie(await request('/api/auth/redeem', { token: created.invites.at(-1).token }, ''));
    await refresh();
    await ok({ type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });
    const otherLocation = randomUUID();
    await mutate((state) => {
      state.locations.push({ id: otherLocation, title: 'The far shore', description: '' });
      while (state.npcs.length < 3) state.npcs.push({ ...structuredClone(state.npcs[0]!), id: randomUUID(), displayName: `Extra ${state.npcs.length}` });
      const place = state.session.scene.locationId;
      for (const item of state.npcs) { item.status = 'offstage'; item.locationId = place; item.version = 1; }
      [here, away, elsewhere] = state.npcs.map((item) => item.id);
      state.npcs[0]!.status = 'present';
      state.npcs[2]!.status = 'present'; state.npcs[2]!.locationId = otherLocation;
      state.characters[0]!.strain = 3;
    });
  });
  afterAll(async () => { await app?.close(); await pool.end(); });

  it('moves one character on and another off at the current place without a new scene, a wipe or a line change', async () => {
    await line('say');
    const before = snapshot;
    expect(hereNow()).toEqual([here]);
    const response = await ok(cast([away]));
    expect(hereNow()).toEqual([away]);
    expect(npc(away).status).toBe('present'); expect(npc(away).locationId).toBe(before.session.scene.locationId); expect(npc(away).version).toBe(2);
    expect(npc(here).status).toBe('offstage'); expect(npc(here).version).toBe(2);
    expect(snapshot.session.scene.id).toBe(before.session.scene.id);
    expect(snapshot.session.inputEpoch).toBe(before.session.inputEpoch);
    expect(snapshot.session.stateRevision).toBe(before.session.stateRevision + 1);
    expect(snapshot.submissions).toEqual(before.submissions);
    expect(snapshot.activeBeat).toEqual(before.activeBeat);
    const rows = await auditRows(response.json().commandId);
    expect(rows).toHaveLength(1); expect(rows[0].kind).toBe('set_cast');
    expect(rows[0].data).toEqual({ before: [here], after: [away] });
  });

  it('leaves a character who is present at another place alone when they are not listed', async () => {
    await ok(cast([here, away]));
    expect(hereNow()).toEqual([here, away].sort());
    expect(npc(elsewhere).status).toBe('present');
    expect(npc(elsewhere).locationId).not.toBe(snapshot.session.scene.locationId);
    expect(npc(elsewhere).version).toBe(1);
    expect(npc(here).version).toBe(1);
  });

  it('brings a character from another place to the current one when they are listed', async () => {
    await ok(cast([here, elsewhere]));
    expect(hereNow()).toEqual([here, elsewhere].sort());
    expect(npc(elsewhere).locationId).toBe(snapshot.session.scene.locationId);
  });

  it('sends everybody offstage when nobody is listed', async () => {
    await ok(cast([]));
    expect(hereNow()).toEqual([]);
    expect(npc(here).status).toBe('offstage');
  });

  it('works while paused and while a round is collecting, and keeps the pause', async () => {
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    await line('say');
    const collecting = snapshot;
    await ok(cast([away]));
    expect(snapshot.activeBeat).toEqual(collecting.activeBeat);
    expect(snapshot.submissions).toEqual(collecting.submissions);
    await ok({ type: 'set_status', status: 'paused', expectedStateRevision: snapshot.session.stateRevision });
    await ok(cast([here]));
    expect(snapshot.session.status).toBe('paused');
    expect(hereNow()).toEqual([here]);
  });

  it('refuses a no-op, an unknown character, a stale revision and the lobby with the exact texts and changes nothing', async () => {
    const before = snapshot;
    await refused(cast([here]), 409, messages.noChange);
    await refused(cast([randomUUID()]), 409, messages.unknownNpc);
    await refused(cast([away], { expectedStateRevision: before.session.stateRevision - 1 }), 409, messages.stale);
    await refused(cast([away, away]), 400);
    await refresh();
    expect(snapshot.session.stateRevision).toBe(before.session.stateRevision);
    expect(hereNow()).toEqual([here]);
    expect(await auditCount('set_cast')).toBe(0);
    await pool.query("UPDATE sessions SET setup=NULL,status='lobby' WHERE id=$1", [sessionId]);
    await refused(cast([away]), 409, messages.castLobby);
  });

  it('refuses once the dice are rolled', async () => {
    await ok({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    await line('act');
    await ok(beatCommand('plan_beat', { submissionIds: queued() }));
    await refused(cast([away]), 409, messages.rolled);
    await ok(beatCommand('approve_stakes', { classification: 'action', contracts: snapshot.activeBeat!.contracts }));
    await ok(beatCommand('lock_beat'));
    await refused(cast([away]), 409, messages.rolled);
    await refused(rest(), 409, messages.rolled);
    await ok(beatCommand('render_beat'));
    await refused(cast([away]), 409, messages.rolled);
    expect(hereNow()).toEqual([here]);
  });

  it('refuses while the AI is planning, and works once it finishes', async () => {
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    await line('say');
    let finish!: (result: PlanResult) => void;
    let started: ProviderContext | undefined;
    plan = (context) => { started = context; return new Promise<PlanResult>((resolve) => { finish = resolve; }); };
    const pending = command(beatCommand('plan_beat', { submissionIds: queued() }));
    const deadline = Date.now() + 3000;
    while (!started && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toBeDefined();
    const response = await refused(cast([away]), 409, messages.running);
    expect(response.json().recoverable).toBe(true);
    await refused(rest(), 409, messages.running);
    finish(await fake.plan(started!));
    expect((await pending).statusCode).toBe(200);
    await refresh();
    expect(hereNow()).toEqual([here]);
    expect(strain()).toBe(3);
    await refused(cast([away]), 409, messages.rolled);
    await ok(beatCommand('abort_beat', { reason: 'Start this round over.' }));
    await ok(cast([away]));
    expect(hereNow()).toEqual([away]);
  });

  it('refuses players and stream pages for both commands and writes no audit row', async () => {
    for (const credential of [player, stage]) {
      expect((await command(cast([away]), credential)).statusCode).toBe(403);
      expect((await command(rest(), credential)).statusCode).toBe(403);
    }
    expect((await command(cast([away]), '')).statusCode).toBe(401);
    await refresh();
    expect(hereNow()).toEqual([here]);
    expect(strain()).toBe(3);
    expect(await auditCount('set_cast')).toBe(0);
    expect(await auditCount('rest')).toBe(0);
  });

  it('sets everyone\'s strain to 0 and keeps the lines, the epoch and the scene', async () => {
    await line('say');
    const before = snapshot;
    const response = await ok(rest());
    expect(strain()).toBe(0);
    for (const item of snapshot.characters) expect(item.strain).toBe(0);
    expect(snapshot.session.stateRevision).toBe(before.session.stateRevision + 1);
    expect(snapshot.session.inputEpoch).toBe(before.session.inputEpoch);
    expect(snapshot.session.scene.id).toBe(before.session.scene.id);
    expect(snapshot.submissions).toEqual(before.submissions);
    const rows = await auditRows(response.json().commandId);
    expect(rows).toHaveLength(1); expect(rows[0].kind).toBe('rest');
    expect(rows[0].data).toEqual({ before: [{ characterId: characterId(), strain: 3 }], after: [{ characterId: characterId(), strain: 0 }] });
  });

  it('rests several characters at once, lists only those who rested and leaves the strain-free alone', async () => {
    const ids = snapshot.characters.map((item) => item.id);
    if (ids.length < 2) return;
    await mutate((state) => { state.characters[1]!.strain = 4; });
    const response = await ok(rest());
    for (const item of snapshot.characters) expect(item.strain).toBe(0);
    const rows = await auditRows(response.json().commandId);
    expect(rows[0].data).toEqual({
      before: [{ characterId: ids[0], strain: 3 }, { characterId: ids[1], strain: 4 }],
      after: [{ characterId: ids[0], strain: 0 }, { characterId: ids[1], strain: 0 }],
    });
  });

  it('works while paused and while a round is collecting', async () => {
    await ok({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    await line('act');
    const collecting = snapshot;
    await ok(rest());
    expect(snapshot.activeBeat).toEqual(collecting.activeBeat);
    expect(snapshot.submissions).toEqual(collecting.submissions);
    expect(snapshot.session.inputEpoch).toBe(collecting.session.inputEpoch);
    await mutate((state) => { state.characters[0]!.strain = 2; });
    await ok({ type: 'set_status', status: 'paused', expectedStateRevision: snapshot.session.stateRevision });
    await ok(rest());
    expect(snapshot.session.status).toBe('paused');
    expect(strain()).toBe(0);
  });

  it('refuses when nobody has strain, a stale revision, an old body shape and the lobby with the exact texts', async () => {
    const before = snapshot;
    await refused(rest({ expectedStateRevision: before.session.stateRevision - 1 }), 409, messages.stale);
    await refused(rest({ rests: [{ characterId: characterId(), amount: 1 }] }), 400);
    await refused(rest({ reason: 'tired' }), 400);
    await refused(rest({ discardQueuedInput: true }), 400);
    await refresh();
    expect(strain()).toBe(3);
    expect(snapshot.session.stateRevision).toBe(before.session.stateRevision);
    expect(await auditCount('rest')).toBe(0);
    await ok(rest());
    await refused(rest(), 409, messages.nobodyStrained);
    expect(await auditCount('rest')).toBe(1);
    await pool.query("UPDATE sessions SET setup=NULL,status='lobby' WHERE id=$1", [sessionId]);
    await refused(rest(), 409, messages.restLobby);
  });
});
