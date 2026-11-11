import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import type { AiCallOptions, AiDraft, DirectorSnapshot, PlanResult, ProviderContext } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeAiProvider } from '../src/fake-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'ai-start-stop-test-host-credential-32-chars';
const finished = 'The AI had already finished, so there was nothing to stop.';
const inactive = 'This beat is no longer active. Refresh before continuing.';

suite('a starting plan or script tells every page, and the director can stop the AI', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let base: string;
  let host: string, player: string, stage: string, sessionId: string;
  let snapshot: DirectorSnapshot;
  let diceCalls: number;
  const fake = new FakeAiProvider();
  let plan: (context: ProviderContext, options?: AiCallOptions) => Promise<PlanResult>;
  let render: (context: ProviderContext, options?: AiCallOptions) => Promise<AiDraft>;
  // No time limit, as on the live show: a call that never answers waits until something stops it.
  const options = { databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, providerTimeoutMs: null,
    rollDie: () => { diceCalls++; return 4; },
    provider: { plan: (context: ProviderContext, callOptions?: AiCallOptions) => plan(context, callOptions), render: (context: ProviderContext, callOptions?: AiCallOptions) => render(context, callOptions) },
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
  const stopAi = (credential = host, beatId = snapshot.activeBeat!.id) => command({ type: 'stop_ai', beatId }, credential);
  const queued = () => snapshot.submissions.filter((item) => ['queued', 'selected'].includes(item.status) && item.kind !== 'ooc').map((item) => item.id);
  async function submit(kind: 'say' | 'act') {
    const response = await command({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: snapshot.session.inputEpoch, contextBeatId: snapshot.activeBeat?.id ?? null, kind,
      text: kind === 'act' ? '' : 'A queued question', intent: kind === 'act' ? 'Open the archive' : '', approach: kind === 'act' ? 'Study the latch' : '' }, player);
    expect(response.statusCode, response.body).toBe(200);
    await refresh();
  }
  async function takeLines(kind: 'action' | 'conversation' = 'conversation') {
    await ok({ type: 'open_beat', kind, expectedInputEpoch: snapshot.session.inputEpoch });
    await submit(kind === 'action' ? 'act' : 'say');
  }
  async function rollDice() {
    await takeLines('action');
    await ok(beatCommand('plan_beat', { submissionIds: queued() }));
    await ok(beatCommand('approve_stakes', { classification: 'action', contracts: snapshot.activeBeat!.contracts }));
    await ok(beatCommand('lock_beat'));
  }
  // A provider call that never answers and remembers the signal it was handed.
  function never<T>() {
    const call: { signal?: AbortSignal } = {};
    const run = (_context: ProviderContext, callOptions?: AiCallOptions) => { call.signal = callOptions?.signal; return new Promise<T>(() => undefined); };
    return { call, run };
  }
  const waiting = (call: { signal?: AbortSignal }) => vi.waitFor(() => expect(call.signal).toBeDefined(), { timeout: 2000, interval: 10 });
  const kinds = async (commandId: string) => (await pool.query<{ kind: string }>('SELECT kind FROM audit_events WHERE session_id=$1 AND command_id=$2 ORDER BY sequence', [sessionId, commandId])).rows.map((row) => row.kind);
  const attempts = async (jobId: string) => (await pool.query('SELECT r.status FROM usage_attempts a JOIN usage_attempt_results r ON r.attempt_id=a.id WHERE a.operation_id=$1', [jobId])).rows;
  // Starts the command, then proves a connected page is told about it while the AI call is still waiting.
  async function noticeWhileWaiting(type: 'plan_beat' | 'render_beat', task: 'plan' | 'render', call: { signal?: AbortSignal }) {
    const client = io(base, { transports: ['polling'], auth: { sessionId }, extraHeaders: { cookie: host }, reconnection: false, timeout: 2000 });
    const seen: { eventId: string }[] = [];
    client.on('session.snapshot_available', (value) => { seen.push(value); });
    let settled = false;
    try {
      await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
      const commandId = randomUUID();
      const sentAt = Date.now();
      const pending = request(`/api/sessions/${sessionId}/commands`, { commandId, ...beatCommand(type, type === 'plan_beat' ? { submissionIds: queued() } : {}) });
      void pending.then(() => { settled = true; });
      await waiting(call);
      await vi.waitFor(async () => {
        const started = (await pool.query<{ id: string }>("SELECT id FROM audit_events WHERE session_id=$1 AND command_id=$2 AND kind='job.started'", [sessionId, commandId])).rows;
        expect(started).toHaveLength(1);
        expect(seen.map((event) => event.eventId)).toContain(started[0]!.id);
      }, { timeout: 2000, interval: 20 });
      expect(Date.now() - sentAt).toBeLessThan(2000);
      expect(settled).toBe(false);
      await refresh();
      expect(snapshot.jobs.at(-1)).toMatchObject({ beatId: snapshot.activeBeat!.id, task, status: 'running' });
      const data = (await pool.query("SELECT data FROM audit_events WHERE session_id=$1 AND command_id=$2 AND kind='job.started'", [sessionId, commandId])).rows[0].data;
      expect(data).toEqual({ beatId: snapshot.activeBeat!.id, jobId: snapshot.jobs.at(-1)!.id, task });
      expect((await stopAi()).statusCode).toBe(200);
      expect((await pending).statusCode).toBe(409);
    } finally { client.disconnect(); }
  }

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp(options);
    host = cookie(await request('/api/auth/host', { token: hostToken }, ''));
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  });
  beforeEach(async () => {
    diceCalls = 0; plan = (value, callOptions) => fake.plan(value, callOptions); render = (value, callOptions) => fake.render(value, callOptions);
    const created = (await request('/api/sessions', { commandId: randomUUID() })).json(); sessionId = created.sessionId;
    player = cookie(await request('/api/auth/redeem', { token: created.invites[0].token }, ''));
    stage = cookie(await request('/api/auth/redeem', { token: created.invites.at(-1).token }, ''));
    await refresh();
    await ok({ type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  it('tells a connected page that a plan has started while the AI is still working', async () => {
    await takeLines();
    const held = never<PlanResult>(); plan = held.run;
    await noticeWhileWaiting('plan_beat', 'plan', held.call);
  });

  it('tells a connected page that a script has started while the AI is still working', async () => {
    await rollDice();
    const held = never<AiDraft>(); render = held.run;
    await noticeWhileWaiting('render_beat', 'render', held.call);
  });

  it('records the start before the result, and a replay returns the same receipt with no new audit row', async () => {
    await takeLines();
    const commandId = randomUUID();
    const payload = { commandId, ...beatCommand('plan_beat', { submissionIds: queued() }) };
    const first = await request(`/api/sessions/${sessionId}/commands`, payload);
    expect(first.statusCode, first.body).toBe(200);
    expect(await kinds(commandId)).toEqual(['job.started', 'plan_beat']);
    const replay = await request(`/api/sessions/${sessionId}/commands`, payload);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(await kinds(commandId)).toEqual(['job.started', 'plan_beat']);
    expect(first.json().eventSeq).toBe(first.json().snapshot.eventSeq);
  });

  it('records the start before a failure', async () => {
    await takeLines();
    plan = async () => { throw new Error('The provider fell over.'); };
    const commandId = randomUUID();
    const failed = await request(`/api/sessions/${sessionId}/commands`, { commandId, ...beatCommand('plan_beat', { submissionIds: queued() }) });
    expect(failed.statusCode, failed.body).toBe(200);
    expect(failed.json().snapshot.activeBeat.lastError).toBeTruthy();
    expect(await kinds(commandId)).toEqual(['job.started', 'job.failed']);
  });

  it('refuses a repeat of a plan that is still running and records its start only once', async () => {
    await takeLines();
    const held = never<PlanResult>(); plan = held.run;
    const payload = { commandId: randomUUID(), ...beatCommand('plan_beat', { submissionIds: queued() }) };
    const pending = request(`/api/sessions/${sessionId}/commands`, payload);
    await waiting(held.call);
    const repeat = await request(`/api/sessions/${sessionId}/commands`, payload);
    expect(repeat.statusCode, repeat.body).toBe(409);
    expect(await kinds(payload.commandId)).toEqual(['job.started']);
    expect((await stopAi()).statusCode).toBe(200);
    expect((await pending).statusCode).toBe(409);
    expect(await kinds(payload.commandId)).toEqual(['job.started']);
  });

  it('stops a waiting plan at once and keeps the lines and ticks', async () => {
    await takeLines();
    const lines = queued();
    const held = never<PlanResult>(); plan = held.run;
    const pending = command(beatCommand('plan_beat', { submissionIds: lines }));
    await waiting(held.call);
    expect(held.call.signal!.aborted).toBe(false);
    await refresh();
    const job = snapshot.jobs.at(-1)!;
    expect(job).toMatchObject({ task: 'plan', status: 'running' });
    const before = snapshot.activeBeat!;
    const pressedAt = Date.now();
    const stopped = await stopAi();
    const planned = await pending;
    expect(Date.now() - pressedAt).toBeLessThan(1000);
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(planned.statusCode, planned.body).toBe(409);
    expect(planned.json()).toMatchObject({ code: 'superseded' });
    expect(held.call.signal!.aborted).toBe(true);
    await refresh();
    expect(snapshot.activeBeat).toEqual(before);
    expect(snapshot.activeBeat).toMatchObject({ phase: 'collecting', selectedSubmissionIds: lines, lastError: null, contracts: [] });
    expect(stopped.json().snapshot.activeBeat).toEqual(before);
    expect(snapshot.submissions.filter((item) => lines.includes(item.id)).map((item) => item.status)).toEqual(lines.map(() => 'selected'));
    expect(snapshot.jobs.at(-1)).toMatchObject({ id: job.id, status: 'cancelled' });
    expect(await attempts(job.id)).toEqual([{ status: 'interrupted' }]);
    const audit = (await pool.query("SELECT data FROM audit_events WHERE session_id=$1 AND command_id=$2 AND kind='stop_ai'", [sessionId, stopped.json().commandId])).rows;
    expect(audit).toEqual([{ data: { beatId: before.id, stopped: [{ id: job.id, task: 'plan' }] } }]);
    plan = (value, callOptions) => fake.plan(value, callOptions);
    await ok(beatCommand('plan_beat', { submissionIds: lines }));
    expect(snapshot.activeBeat).toMatchObject({ phase: 'stakes_review', selectedSubmissionIds: lines, lastError: null });
  });

  it('stops a waiting script at once and keeps the dice', async () => {
    await rollDice();
    const rolls = structuredClone(snapshot.activeBeat!.resolution!.rolls);
    expect(rolls.length).toBeGreaterThan(0);
    const rolledDice = diceCalls;
    const held = never<AiDraft>(); render = held.run;
    const pending = command(beatCommand('render_beat'));
    await waiting(held.call);
    await refresh();
    const job = snapshot.jobs.at(-1)!;
    expect(job).toMatchObject({ task: 'render', status: 'running' });
    const before = snapshot.activeBeat!;
    const pressedAt = Date.now();
    const stopped = await stopAi();
    const written = await pending;
    expect(Date.now() - pressedAt).toBeLessThan(1000);
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(written.statusCode, written.body).toBe(409);
    expect(held.call.signal!.aborted).toBe(true);
    await refresh();
    expect(snapshot.activeBeat).toEqual(before);
    expect(snapshot.activeBeat).toMatchObject({ phase: 'locked', draft: null, lastError: null });
    expect(snapshot.activeBeat!.resolution!.rolls).toEqual(rolls);
    expect(diceCalls).toBe(rolledDice);
    expect(snapshot.jobs.at(-1)).toMatchObject({ id: job.id, status: 'cancelled' });
    expect(await attempts(job.id)).toEqual([{ status: 'interrupted' }]);
    await ok(beatCommand('edit_script', { segments: [{ kind: 'narration', text: 'The director writes this part by hand.', recipientCharacterIds: [], delivery: 'neutral' }] }));
    expect(snapshot.activeBeat!.draft).not.toBeNull();
    expect(snapshot.activeBeat!.resolution!.rolls).toEqual(rolls);
    expect(diceCalls).toBe(rolledDice);
  });

  it('lets the director draft the scene again after stopping a script', async () => {
    await rollDice();
    const held = never<AiDraft>(); render = held.run;
    const pending = command(beatCommand('render_beat'));
    await waiting(held.call);
    await refresh();
    expect((await stopAi()).statusCode).toBe(200);
    expect((await pending).statusCode).toBe(409);
    render = (value, callOptions) => fake.render(value, callOptions);
    await refresh();
    await ok(beatCommand('render_beat'));
    expect(snapshot.activeBeat).toMatchObject({ phase: 'draft_review', lastError: null });
  });

  it('clears work left marked as running with no call behind it, keeps the stakes, and then has nothing to stop', async () => {
    await takeLines('action');
    await ok(beatCommand('plan_beat', { submissionIds: queued() }));
    const before = snapshot.activeBeat!;
    expect(before.phase).toBe('stakes_review');
    expect(before.contracts.length).toBeGreaterThan(0);
    const job = snapshot.jobs.at(-1)!;
    await pool.query("UPDATE generation_jobs SET status='running',finished_at=NULL WHERE id=$1", [job.id]);
    const stopped = await stopAi();
    expect(stopped.statusCode, stopped.body).toBe(200);
    await refresh();
    expect(snapshot.jobs.at(-1)).toMatchObject({ id: job.id, status: 'cancelled' });
    expect(snapshot.activeBeat).toEqual(before);
    const again = await stopAi();
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().message).toBe(finished);
    await ok(beatCommand('approve_stakes', { classification: 'action', contracts: snapshot.activeBeat!.contracts }));
  });

  it('answers that there was nothing to stop when no AI work is waiting', async () => {
    await takeLines();
    const events = Number((await pool.query('SELECT count(*) AS count FROM audit_events WHERE session_id=$1', [sessionId])).rows[0].count);
    const response = await stopAi();
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().message).toBe(finished);
    expect(Number((await pool.query('SELECT count(*) AS count FROM audit_events WHERE session_id=$1', [sessionId])).rows[0].count)).toBe(events);
  });

  it('refuses a stop for a round that is not the open one', async () => {
    const none = await command({ type: 'stop_ai', beatId: randomUUID().replaceAll('-', '') });
    expect(none.statusCode, none.body).toBe(409);
    expect(none.json().message).toBe(inactive);
    await takeLines();
    const other = await stopAi(host, randomUUID().replaceAll('-', ''));
    expect(other.statusCode, other.body).toBe(409);
    expect(other.json().message).toBe(inactive);
  });

  it('is the director\'s alone: a player or a stream page cannot stop the AI', async () => {
    await takeLines();
    const held = never<PlanResult>(); plan = held.run;
    const pending = command(beatCommand('plan_beat', { submissionIds: queued() }));
    await waiting(held.call);
    await refresh();
    expect((await stopAi(player)).statusCode).toBe(403);
    expect((await stopAi(stage)).statusCode).toBe(403);
    expect(held.call.signal!.aborted).toBe(false);
    expect(snapshot.jobs.at(-1)).toMatchObject({ status: 'running' });
    expect((await stopAi()).statusCode).toBe(200);
    expect((await pending).statusCode).toBe(409);
  });

  it('works while the show is paused', async () => {
    await takeLines();
    const lines = queued();
    const held = never<PlanResult>(); plan = held.run;
    const pending = command(beatCommand('plan_beat', { submissionIds: lines }));
    await waiting(held.call);
    await refresh();
    await ok({ type: 'set_status', status: 'paused', expectedStateRevision: snapshot.session.stateRevision });
    const stopped = await stopAi();
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect((await pending).statusCode).toBe(409);
    expect(held.call.signal!.aborted).toBe(true);
    await refresh();
    expect(snapshot.session.status).toBe('paused');
    expect(snapshot.activeBeat).toMatchObject({ phase: 'collecting', selectedSubmissionIds: lines });
    expect(snapshot.jobs.at(-1)).toMatchObject({ status: 'cancelled' });
  });

  it('is refused once the show has ended', async () => {
    await takeLines();
    const beatId = snapshot.activeBeat!.id;
    await ok({ type: 'set_status', status: 'ended', expectedStateRevision: snapshot.session.stateRevision });
    const response = await command({ type: 'stop_ai', beatId });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().message).toBe('This session has ended.');
  });
});
