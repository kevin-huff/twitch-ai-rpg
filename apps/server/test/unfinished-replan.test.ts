import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AiCallOptions, AiDraft, DirectorSnapshot, PlanResult, ProviderContext } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeAiProvider } from '../src/fake-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'unfinished-replan-test-host-credential-32';
const noStakes = 'A picked line has no stakes yet, so it would go into the story with no roll. Press Plan again so every picked line gets its stakes.';

// Stakes are on the table, a late line arrives, and the director plans again with it. Whatever stops that second plan from
// finishing, the earlier stakes must keep exactly the lines they cover, so no line can be rolled into the story without stakes.
suite('a second plan that does not finish leaves the round as it was', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let host: string, player: string, sessionId: string;
  let snapshot: DirectorSnapshot;
  const fake = new FakeAiProvider();
  let plan: (context: ProviderContext, options?: AiCallOptions) => Promise<PlanResult>;
  const options = { databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, providerTimeoutMs: null, rollDie: () => 4,
    provider: { plan: (context: ProviderContext, callOptions?: AiCallOptions) => plan(context, callOptions), render: (context: ProviderContext, callOptions?: AiCallOptions): Promise<AiDraft> => fake.render(context, callOptions) },
  };
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (path: string, payload?: Record<string, unknown>, credential = host) => app.inject({ method: payload === undefined ? 'GET' : 'POST', url: path, headers: { origin, cookie: credential }, ...(payload === undefined ? {} : { payload }) });
  const command = (value: Record<string, unknown>, credential = host) => request(`/api/sessions/${sessionId}/commands`, { commandId: randomUUID(), ...value }, credential);
  const refresh = async () => { snapshot = (await request(`/api/sessions/${sessionId}`)).json(); };
  async function ok(value: Record<string, unknown>) {
    const response = await command(value);
    expect(response.statusCode, response.body).toBe(200);
    snapshot = response.json().snapshot;
    return response;
  }
  const beatCommand = (type: string, value: Record<string, unknown> = {}) => ({ type, beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, ...value });
  const stopAi = () => command({ type: 'stop_ai', beatId: snapshot.activeBeat!.id });
  const statusOf = (id: string) => snapshot.submissions.find((item) => item.id === id)?.status;
  async function submit(kind: 'say' | 'act') {
    const known = new Set(snapshot.submissions.map((item) => item.id));
    const response = await command({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: snapshot.session.inputEpoch, contextBeatId: snapshot.activeBeat?.id ?? null, kind,
      text: kind === 'act' ? '' : 'A question asked aloud', intent: kind === 'act' ? 'Open the archive' : '', approach: kind === 'act' ? 'Study the latch' : '' }, player);
    expect(response.statusCode, response.body).toBe(200);
    await refresh();
    return snapshot.submissions.find((item) => !known.has(item.id))!.id;
  }
  // A provider call that never answers and remembers the signal it was handed.
  function never() {
    const call: { signal?: AbortSignal } = {};
    const run = (_context: ProviderContext, callOptions?: AiCallOptions) => { call.signal = callOptions?.signal; return new Promise<PlanResult>(() => undefined); };
    return { call, run };
  }
  // A provider call that answers only when the test lets it.
  function held() {
    const call: { started: boolean; release: () => void } = { started: false, release: () => undefined };
    const run = (context: ProviderContext, callOptions?: AiCallOptions) => new Promise<PlanResult>((resolve, reject) => {
      call.started = true;
      call.release = () => { fake.plan(context, callOptions).then(resolve, reject); };
    });
    return { call, run };
  }
  // An action round whose first line has stakes on the table, then a late line of the other kind.
  async function stakesThenLateLine() {
    await ok({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    const first = await submit('act');
    await ok(beatCommand('plan_beat', { submissionIds: [first] }));
    expect(snapshot.activeBeat).toMatchObject({ phase: 'stakes_review', selectedSubmissionIds: [first] });
    const contracts = structuredClone(snapshot.activeBeat!.contracts);
    expect(contracts.map((contract) => contract.submissionIds)).toEqual([[first]]);
    const late = await submit('say');
    return { first, late, contracts };
  }
  async function expectEarlierPlanStands(first: string, late: string, contracts: unknown) {
    await refresh();
    expect(snapshot.activeBeat).toMatchObject({ phase: 'stakes_review', selectedSubmissionIds: [first], stakesApproved: false });
    expect(snapshot.activeBeat!.contracts).toEqual(contracts);
    expect(statusOf(first)).toBe('selected');
    expect(statusOf(late)).toBe('queued');
    await ok(beatCommand('approve_stakes', { classification: 'action', contracts: snapshot.activeBeat!.contracts }));
    await ok(beatCommand('lock_beat'));
    expect(snapshot.activeBeat!.lockedSubmissions.map((item) => item.id)).toEqual([first]);
    expect(snapshot.activeBeat!.resolution!.rolls).toHaveLength(1);
    expect(statusOf(late)).toBe('queued');
  }

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp(options);
    host = cookie(await request('/api/auth/host', { token: hostToken }, ''));
  });
  beforeEach(async () => {
    plan = (value, callOptions) => fake.plan(value, callOptions);
    const created = (await request('/api/sessions', { commandId: randomUUID() })).json(); sessionId = created.sessionId;
    player = cookie(await request('/api/auth/redeem', { token: created.invites[0].token }, ''));
    await refresh();
    await ok({ type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  it('stopped: the earlier stakes keep their own line and the late line goes back to waiting', async () => {
    const { first, late, contracts } = await stakesThenLateLine();
    const stalled = never(); plan = stalled.run;
    const pending = command(beatCommand('plan_beat', { submissionIds: [first, late] }));
    await vi.waitFor(() => expect(stalled.call.signal).toBeDefined(), { timeout: 2000, interval: 10 });
    await refresh();
    expect(snapshot.activeBeat!.selectedSubmissionIds).toEqual([first, late]);
    const stopped = await stopAi();
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect((await pending).statusCode).toBe(409);
    expect(stopped.json().snapshot.activeBeat).toMatchObject({ phase: 'stakes_review', selectedSubmissionIds: [first], lastError: null });
    await expectEarlierPlanStands(first, late, contracts);
  });

  it('failed: the earlier stakes keep their own line, the late line goes back to waiting and the failure shows', async () => {
    const { first, late, contracts } = await stakesThenLateLine();
    plan = async () => { throw new Error('The provider fell over.'); };
    await ok(beatCommand('plan_beat', { submissionIds: [first, late] }));
    expect(snapshot.activeBeat!.lastError).toBeTruthy();
    await expectEarlierPlanStands(first, late, contracts);
  });

  it('thrown away by a pause: the earlier stakes keep their own line, and every page is told when the AI answers', async () => {
    const { first, late, contracts } = await stakesThenLateLine();
    const slow = held(); plan = slow.run;
    const commandId = randomUUID();
    const pending = request(`/api/sessions/${sessionId}/commands`, { commandId, ...beatCommand('plan_beat', { submissionIds: [first, late] }) });
    await vi.waitFor(() => expect(slow.call.started).toBe(true), { timeout: 2000, interval: 10 });
    await refresh();
    await ok({ type: 'set_status', status: 'paused', expectedStateRevision: snapshot.session.stateRevision });
    await ok({ type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });
    slow.call.release();
    expect((await pending).statusCode).toBe(409);
    const kinds = (await pool.query<{ kind: string }>('SELECT kind FROM audit_events WHERE session_id=$1 AND command_id=$2 ORDER BY sequence', [sessionId, commandId])).rows.map((row) => row.kind);
    expect(kinds).toEqual(['job.started', 'job.discarded']);
    plan = (value, callOptions) => fake.plan(value, callOptions);
    await expectEarlierPlanStands(first, late, contracts);
  });

  it('stopped after the director dropped a line the stakes cover: the round goes back to planning with the new picks', async () => {
    await ok({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    const first = await submit('act');
    const second = await submit('say');
    await ok(beatCommand('plan_beat', { submissionIds: [first, second] }));
    expect(snapshot.activeBeat!.contracts).toHaveLength(2);
    const stalled = never(); plan = stalled.run;
    const pending = command(beatCommand('plan_beat', { submissionIds: [second] }));
    await vi.waitFor(() => expect(stalled.call.signal).toBeDefined(), { timeout: 2000, interval: 10 });
    expect((await stopAi()).statusCode).toBe(200);
    expect((await pending).statusCode).toBe(409);
    await refresh();
    expect(snapshot.activeBeat).toMatchObject({ phase: 'collecting', selectedSubmissionIds: [second], contracts: [], stakesApproved: false, lastError: null });
    expect(statusOf(first)).toBe('queued');
    expect(statusOf(second)).toBe('selected');
    plan = (value, callOptions) => fake.plan(value, callOptions);
    await ok(beatCommand('plan_beat', { submissionIds: [second] }));
    expect(snapshot.activeBeat).toMatchObject({ phase: 'stakes_review', selectedSubmissionIds: [second] });
    expect(snapshot.activeBeat!.contracts.map((contract) => contract.submissionIds)).toEqual([[second]]);
  });

  it('failed after the director dropped a line the stakes cover: the round is a failed plan with the new picks', async () => {
    await ok({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    const first = await submit('act');
    const second = await submit('say');
    await ok(beatCommand('plan_beat', { submissionIds: [first, second] }));
    plan = async () => { throw new Error('The provider fell over.'); };
    await ok(beatCommand('plan_beat', { submissionIds: [second] }));
    expect(snapshot.activeBeat).toMatchObject({ phase: 'collecting', selectedSubmissionIds: [second], contracts: [], stakesApproved: false });
    expect(snapshot.activeBeat!.lastError).toBeTruthy();
  });

  it('failed its checks after the AI answered: the AI\'s cards and the director\'s picks both stay for fixing by hand, and approval waits for every line', async () => {
    const { first, late } = await stakesThenLateLine();
    // The reply covers only the first line and names an actor who is not in the show, so the app's own checks refuse it.
    plan = async (context, callOptions) => {
      const made = await fake.plan(context, callOptions);
      const kept = made.contracts.filter((contract) => contract.submissionIds.includes(first));
      return { ...made, contracts: kept.map((contract) => ({ ...contract, actorCharacterId: randomUUID() })) };
    };
    await ok(beatCommand('plan_beat', { submissionIds: [first, late] }));
    expect(snapshot.activeBeat!.lastError).toBeTruthy();
    expect(snapshot.activeBeat).toMatchObject({ phase: 'stakes_review', selectedSubmissionIds: [first, late], stakesApproved: false });
    expect(statusOf(late)).toBe('selected');
    const refused = await command(beatCommand('approve_stakes', { classification: 'action', contracts: snapshot.activeBeat!.contracts }));
    expect(refused.statusCode, refused.body).not.toBe(200);
  });

  it('a first plan that is stopped is untouched by this rule', async () => {
    await ok({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    const first = await submit('act');
    const stalled = never(); plan = stalled.run;
    const pending = command(beatCommand('plan_beat', { submissionIds: [first] }));
    await vi.waitFor(() => expect(stalled.call.signal).toBeDefined(), { timeout: 2000, interval: 10 });
    await refresh();
    const before = snapshot.activeBeat!;
    expect((await stopAi()).statusCode).toBe(200);
    expect((await pending).statusCode).toBe(409);
    await refresh();
    expect(snapshot.activeBeat).toEqual(before);
  });

  it('refuses to approve stakes that leave a picked line without any, and says how to fix it', async () => {
    await ok({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    const first = await submit('act');
    const second = await submit('say');
    await ok(beatCommand('plan_beat', { submissionIds: [first, second] }));
    const onlyFirst = snapshot.activeBeat!.contracts.filter((contract) => contract.submissionIds.includes(first));
    expect(onlyFirst).toHaveLength(1);
    const refused = await command(beatCommand('approve_stakes', { classification: 'action', contracts: onlyFirst }));
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().message).toBe(noStakes);
    await ok(beatCommand('approve_stakes', { classification: 'action', contracts: snapshot.activeBeat!.contracts }));
  });
});
