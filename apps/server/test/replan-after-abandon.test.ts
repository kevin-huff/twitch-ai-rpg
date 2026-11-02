import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AiDraft, DirectorSnapshot, PlanResult, ProviderContext } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeAiProvider } from '../src/fake-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'replan-after-abandon-test-host-credential';

suite('re-planning a line returned by an abandoned round', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let host: string, player: string, sessionId: string;
  let snapshot: DirectorSnapshot;
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
    expect(response.statusCode, `${String(value.type)}: ${response.body}`).toBe(200);
    snapshot = response.json().snapshot;
    return response;
  }
  const beatCommand = (type: string, value: Record<string, unknown> = {}) => ({ type, beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, ...value });
  const queued = () => snapshot.submissions.filter((item) => item.kind !== 'ooc' && (item.status === 'queued' || item.status === 'selected')).map((item) => item.id);

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp(options);
    host = cookie(await request('/api/auth/host', { token: hostToken }, ''));
  });
  beforeEach(async () => {
    // Like the live AI, name each contract after the line it plans, so the same line gets the same name again.
    plan = async (context) => {
      const result = await fake.plan(context);
      return { ...result, contracts: result.contracts.map((contract) => ({ ...contract, id: `contract-for-${contract.submissionIds[0]}` })) };
    };
    render = (value) => fake.render(value);
    const created = (await request('/api/sessions', { commandId: randomUUID() })).json(); sessionId = created.sessionId;
    player = cookie(await request('/api/auth/redeem', { token: created.invites[0].token }, ''));
    await refresh();
    await ok({ type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });
  });
  afterAll(async () => { await app?.close(); await pool.end(); });

  const send = async (intent: string) => {
    const sent = await command({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: snapshot.session.inputEpoch, contextBeatId: snapshot.activeBeat!.id, kind: 'act', text: '', intent, approach: 'Go slowly', recipientNpcIds: [] }, player);
    expect(sent.statusCode, sent.body).toBe(200);
    await refresh();
  };
  const rollContractIds = async () => (await pool.query<{ contract_id: string }>('SELECT contract_id FROM rolls WHERE beat_id=$1', [snapshot.activeBeat!.id])).rows.map((row) => row.contract_id);

  it('locks a round that re-plans a line from an abandoned rolled round when the AI reuses the contract name', async () => {
    await ok({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    await send('Open the archive');
    await ok(beatCommand('plan_beat', { submissionIds: queued() }));
    await ok(beatCommand('approve_stakes', { classification: 'action', contracts: snapshot.activeBeat!.contracts }));
    await ok(beatCommand('lock_beat'));
    const firstIds = snapshot.activeBeat!.contracts.map((contract) => contract.id);
    await ok(beatCommand('abort_beat', { reason: 'Start this round over.' }));
    expect(queued()).toHaveLength(1);
    await ok({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    await ok(beatCommand('plan_beat', { submissionIds: queued() }));
    const planned = snapshot.activeBeat!.contracts.map((contract) => contract.id);
    expect(planned).toEqual(firstIds);
    await ok(beatCommand('approve_stakes', { classification: 'action', contracts: snapshot.activeBeat!.contracts }));
    const locked = await command(beatCommand('lock_beat'));
    expect(locked.statusCode, locked.body).toBe(200);
    snapshot = locked.json().snapshot;
    const currentIds = snapshot.activeBeat!.contracts.map((contract) => contract.id);
    expect(currentIds).toHaveLength(firstIds.length);
    for (const id of currentIds) expect(firstIds).not.toContain(id);
    const rolled = await rollContractIds();
    expect(rolled.length).toBeGreaterThan(0);
    for (const id of rolled) expect(currentIds).toContain(id);
  });

  it('renames director-typed stakes that reuse old ids and keeps a prerequisite pointing at the renamed parent', async () => {
    await ok({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    await send('Open the archive');
    await send('Read the ledger');
    await ok(beatCommand('plan_beat', { submissionIds: queued() }));
    expect(snapshot.activeBeat!.contracts.length).toBeGreaterThanOrEqual(2);
    const [a, b] = snapshot.activeBeat!.contracts;
    await ok(beatCommand('approve_stakes', { classification: 'action', contracts: snapshot.activeBeat!.contracts }));
    await ok(beatCommand('lock_beat'));
    await ok(beatCommand('abort_beat', { reason: 'Start this round over.' }));
    expect(queued()).toHaveLength(2);
    await ok({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    await ok(beatCommand('plan_beat', { submissionIds: queued() }));
    const typed = snapshot.activeBeat!.contracts.map((contract) => structuredClone(contract));
    expect(typed.map((contract) => contract.id)).toEqual([a!.id, b!.id]);
    typed[1]!.prerequisites = [{ contractId: a!.id, requirement: 'goal_achieved' }];
    await ok(beatCommand('approve_stakes', { classification: 'action', contracts: typed }));
    const locked = await command(beatCommand('lock_beat'));
    expect(locked.statusCode, locked.body).toBe(200);
    snapshot = locked.json().snapshot;
    const [newA, newB] = snapshot.activeBeat!.contracts;
    expect(newA!.id).not.toBe(a!.id);
    expect(newB!.id).not.toBe(b!.id);
    expect(newB!.prerequisites).toEqual([{ contractId: newA!.id, requirement: 'goal_achieved' }]);
  });
});
