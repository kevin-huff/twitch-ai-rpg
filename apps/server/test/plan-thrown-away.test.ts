import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AiCallOptions, AiDraft, DirectorSnapshot, PlanResult, ProviderContext } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool, transaction } from '../src/database';
import { readState, saveState } from '../src/repository';
import { FakeAiProvider } from '../src/fake-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'plan-thrown-away-test-host-credential-32';

suite('a player changing a line that is in the plan throws the plan away and says who', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let host: string, sessionId: string;
  let players: string[];
  let snapshot: DirectorSnapshot;
  const fake = new FakeAiProvider();
  let plan: (context: ProviderContext, options?: AiCallOptions) => Promise<PlanResult>;
  let render: (context: ProviderContext, options?: AiCallOptions) => Promise<AiDraft>;
  // No time limit, as on the live show: a call that never answers waits until something stops it.
  const options = { databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, providerTimeoutMs: null,
    provider: { plan: (context: ProviderContext, callOptions?: AiCallOptions) => plan(context, callOptions), render: (context: ProviderContext, callOptions?: AiCallOptions) => render(context, callOptions) },
  };
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (path: string, payload?: Record<string, unknown>, credential = host) => app.inject({ method: payload === undefined ? 'GET' : 'POST', url: path, headers: { origin, cookie: credential }, ...(payload === undefined ? {} : { payload }) });
  const command = (value: Record<string, unknown>, credential = host, commandId = randomUUID()) => request(`/api/sessions/${sessionId}/commands`, { commandId, ...value }, credential);
  const refresh = async () => { snapshot = (await request(`/api/sessions/${sessionId}`)).json(); };
  async function ok(value: Record<string, unknown>, credential = host) {
    const response = await command(value, credential);
    expect(response.statusCode, response.body).toBe(200);
    if (credential === host) snapshot = response.json().snapshot;
    return response;
  }
  const beatCommand = (type: string, value: Record<string, unknown> = {}) => ({ type, beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, ...value });
  const queued = () => snapshot.submissions.filter((item) => ['queued', 'selected'].includes(item.status) && item.kind !== 'ooc').map((item) => item.id);
  const lineOf = (seat: number) => snapshot.submissions.find((item) => item.characterId === snapshot.characters[seat]!.id && ['queued', 'selected'].includes(item.status))!;
  async function send(seat: number, text = 'A queued question') {
    const response = await command({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: snapshot.session.inputEpoch, contextBeatId: snapshot.activeBeat?.id ?? null, kind: 'say', text, recipientNpcIds: [] }, players[seat]);
    expect(response.statusCode, response.body).toBe(200);
    await refresh();
  }
  const change = async (seat: number, text = 'A changed question') => {
    const line = lineOf(seat);
    const response = await command({ type: 'save_submission', submissionId: line.id, expectedSubmissionRevision: line.revision, expectedInputEpoch: snapshot.session.inputEpoch, contextBeatId: snapshot.activeBeat?.id ?? null, kind: 'say', text, recipientNpcIds: [] }, players[seat]);
    expect(response.statusCode, response.body).toBe(200);
    await refresh();
    return response;
  };
  const takeBack = async (seat: number) => {
    const line = lineOf(seat);
    const response = await command({ type: 'cancel_submission', submissionId: line.id, expectedSubmissionRevision: line.revision }, players[seat]);
    expect(response.statusCode, response.body).toBe(200);
    await refresh();
    return response;
  };
  const notices = async () => (await pool.query<{ kind: string; data: Record<string, unknown> }>("SELECT kind,data FROM audit_events WHERE session_id=$1 AND data ? 'planThrownAway' ORDER BY sequence", [sessionId])).rows;
  async function openAndPlan(lines: number) {
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    for (let seat = 0; seat < lines; seat++) await send(seat);
    await ok(beatCommand('plan_beat', { submissionIds: queued() }));
    expect(snapshot.activeBeat!.phase).toBe('stakes_review');
  }
  function never<T>() {
    const call: { signal?: AbortSignal } = {};
    const run = (_context: ProviderContext, callOptions?: AiCallOptions) => { call.signal = callOptions?.signal; return new Promise<T>(() => undefined); };
    return { call, run };
  }

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp(options);
    host = cookie(await request('/api/auth/host', { token: hostToken }, ''));
  });
  beforeEach(async () => {
    plan = (value, callOptions) => fake.plan(value, callOptions); render = (value, callOptions) => fake.render(value, callOptions);
    const created = (await request('/api/sessions', { commandId: randomUUID() })).json(); sessionId = created.sessionId;
    players = [];
    for (const invite of created.invites) { const redeemed = await request('/api/auth/redeem', { token: invite.token }, ''); if (invite.role === 'player') players.push(cookie(redeemed)); }
    await refresh();
    await ok({ type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  it('ends the waiting plan within a second, aborts the provider call and names the player who changed a line', async () => {
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    await send(0);
    const held = never<PlanResult>(); plan = held.run;
    const lines = queued();
    const pending = command(beatCommand('plan_beat', { submissionIds: lines }));
    await vi.waitFor(() => expect(held.call.signal).toBeDefined(), { timeout: 2000, interval: 10 });
    expect(held.call.signal!.aborted).toBe(false);
    const at = Date.now();
    await change(0);
    expect((await pending).statusCode).toBe(409);
    expect(Date.now() - at).toBeLessThan(1000);
    expect(held.call.signal!.aborted).toBe(true);
    expect(snapshot.activeBeat!.phase).toBe('collecting');
    expect(snapshot.planThrownAway).toEqual({ characterId: snapshot.characters[0]!.id, change: 'changed' });
    expect(snapshot.jobs.at(-1)).toMatchObject({ task: 'plan', status: 'cancelled' });
    const written = await notices();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ kind: 'save_submission', data: { planThrownAway: { beatId: snapshot.activeBeat!.id, beatRevision: snapshot.activeBeat!.revision, characterId: snapshot.characters[0]!.id } } });
  });

  it('puts the round back to taking lines with no stakes when a planned line is taken back, and says so', async () => {
    await openAndPlan(1);
    expect(snapshot.activeBeat!.contracts.length + snapshot.activeBeat!.selectedSubmissionIds.length).toBeGreaterThan(0);
    const line = lineOf(0);
    await takeBack(0);
    expect(snapshot.activeBeat!.phase).toBe('collecting');
    expect(snapshot.activeBeat!.contracts).toEqual([]);
    expect(snapshot.activeBeat!.stakesApproved).toBe(false);
    expect(snapshot.planThrownAway).toEqual({ characterId: snapshot.characters[0]!.id, change: 'took_back' });
    const written = await notices();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ kind: 'cancel_submission', data: { submissionId: line.id, planThrownAway: { characterId: snapshot.characters[0]!.id } } });
  });

  it('keeps the notice and names the second player when another line changes before the director plans again, then clears it', async () => {
    await openAndPlan(2);
    await change(0);
    expect(snapshot.planThrownAway).toMatchObject({ characterId: snapshot.characters[0]!.id, change: 'changed' });
    await takeBack(1);
    expect(snapshot.activeBeat!.phase).toBe('collecting');
    expect(snapshot.planThrownAway).toEqual({ characterId: snapshot.characters[1]!.id, change: 'took_back' });
    expect(await notices()).toHaveLength(2);
    await ok(beatCommand('plan_beat', { submissionIds: queued() }));
    expect(snapshot.activeBeat!.phase).toBe('stakes_review');
    expect(snapshot.planThrownAway).toBeUndefined();
  });

  it('leaves the plan alone and writes no notice when the changed line is not in the plan', async () => {
    await openAndPlan(1);
    await send(1);
    const before = snapshot.activeBeat!;
    await change(1);
    await takeBack(1);
    expect(snapshot.activeBeat!.phase).toBe('stakes_review');
    expect(snapshot.activeBeat!.revision).toBe(before.revision);
    expect(snapshot.activeBeat!.contracts).toEqual(before.contracts);
    expect(snapshot.planThrownAway).toBeUndefined();
    expect(await notices()).toEqual([]);
  });

  it('writes no notice for Who is here, and the plan it throws away leaves the director no player to blame', async () => {
    await openAndPlan(1);
    await ok({ type: 'set_cast', expectedStateRevision: snapshot.session.stateRevision, presentNpcIds: [] });
    expect(snapshot.activeBeat!.phase).toBe('collecting');
    expect(snapshot.planThrownAway).toBeUndefined();
    expect(await notices()).toEqual([]);
  });

  it('writes no notice for a correction', async () => {
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    await send(0);
    await ok(beatCommand('plan_beat', { submissionIds: queued() }));
    await ok(beatCommand('approve_stakes', { classification: 'ordinary', contracts: [] }));
    await ok(beatCommand('lock_beat')); await ok(beatCommand('render_beat'));
    await ok(beatCommand('publish_beat', { expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat!.draftRevision, textOnly: true }));
    await openAndPlan(1);
    const response = await command({ type: 'record_correction', expectedStateRevision: snapshot.session.stateRevision, publishedBeatId: snapshot.history[0]!.id, publicText: 'The director clarifies the previous scene.', reason: 'Private reason', discardQueuedInput: false, changes: [] });
    expect(response.statusCode, response.body).toBe(200);
    snapshot = response.json().snapshot;
    expect(snapshot.activeBeat!.phase).toBe('collecting');
    expect(snapshot.planThrownAway).toBeUndefined();
    expect(await notices()).toEqual([]);
  });

  it('writes no notice for Rest', async () => {
    await openAndPlan(1);
    await transaction(pool, async (client) => { const state = await readState(client, sessionId); state.characters[0]!.strain = 3; await saveState(client, state); });
    await refresh();
    await ok({ type: 'rest', expectedStateRevision: snapshot.session.stateRevision });
    expect(snapshot.activeBeat!.phase).toBe('collecting');
    expect(snapshot.planThrownAway).toBeUndefined();
    expect(await notices()).toEqual([]);
  });
});
