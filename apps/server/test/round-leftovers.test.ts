import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Command, DirectorSnapshot, ProviderContext, SessionSnapshot } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { FakeAiProvider } from '../src/fake-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://localhost:3000';
const hostToken = 'round-leftovers-test-host-credential';
const suite = databaseUrl ? describe : describe.skip;

class BlankCriticalProvider extends FakeAiProvider {
  override async plan(context: ProviderContext) {
    const plan = await super.plan(context);
    for (const contract of plan.contracts) contract.outcomes.critical = { publicText: '   ', effects: [] };
    return plan;
  }
}

suite('round leftovers: blank criticals and selected-line edits', () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;

  async function start(provider?: FakeAiProvider) {
    const app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, rollDie: () => 1, ...(provider ? { provider } : {}) });
    apps.push(app);
    const request = (path: string, credential: string, payload?: unknown) =>
      app.inject({ method: payload ? 'POST' : 'GET', url: path, headers: { origin, cookie: credential }, ...(payload ? { payload } : {}) });
    const host = cookie(await request('/api/auth/host', '', { token: hostToken }));
    const creation = await request('/api/sessions', host, { commandId: crypto.randomUUID() });
    expect(creation.statusCode, creation.body).toBe(200);
    const created = creation.json();
    const sessionId: string = created.sessionId;
    const players: string[] = [];
    for (const invite of created.invites) {
      const redemption = await request('/api/auth/redeem', '', { token: invite.token });
      if (invite.role === 'player') players.push(cookie(redemption));
    }
    let snapshot: DirectorSnapshot = (await request(`/api/sessions/${sessionId}`, host)).json();
    const send = async (value: Omit<Command, 'commandId'> | Record<string, unknown>, credential = host) => {
      const result = await request(`/api/sessions/${sessionId}/commands`, credential, { commandId: crypto.randomUUID(), ...value });
      expect(result.statusCode, result.body).toBe(200);
      const next = result.json().snapshot as SessionSnapshot;
      if (next.role === 'director') snapshot = next;
      return result;
    };
    const table = {
      get snapshot() { return snapshot; },
      send,
      beat: (type: string, extras: Record<string, unknown> = {}) =>
        send({ type, beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, ...extras }),
      async open() { await send({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch }); },
      async say(text: string, revision = 0, submissionId?: string) {
        await send({ type: 'save_submission', ...(submissionId ? { submissionId } : {}), expectedSubmissionRevision: revision, contextBeatId: snapshot.activeBeat!.id, expectedInputEpoch: snapshot.session.inputEpoch, kind: 'say', text, recipientNpcIds: [] }, players[0]);
      },
      async refresh() { snapshot = (await request(`/api/sessions/${sessionId}`, host)).json(); },
      async view(credential: string) { return (await request(`/api/sessions/${sessionId}`, credential)).json(); },
      players,
      async planFresh() {
        await table.open();
        await table.say('Tell me what you saw.');
        await table.refresh();
        await table.beat('plan_beat', { submissionIds: snapshot.submissions.filter((s) => s.status === 'queued').map((s) => s.id) });
      },
    };
    return table;
  }

  afterAll(async () => { for (const app of apps) await app.close(); });

  it('stores no critical branch when the approved one is only spaces, and a double 1 is a setback', async () => {
    const table = await start();
    await table.planFresh();
    const planned = table.snapshot.activeBeat!;
    const contracts = planned.contracts.map((contract) => ({ ...contract, outcomes: { ...contract.outcomes, critical: { publicText: '   ', effects: [] } } }));
    await table.beat('approve_stakes', { classification: 'action', contracts });
    const approved = table.snapshot.activeBeat!;
    expect(approved.contracts.every((contract) => contract.outcomes.critical === undefined)).toBe(true);
    const playerView = await table.view(table.players[0]!);
    expect(playerView.activeBeat.stakes.every((stake: { outcomes: { critical?: string } }) => stake.outcomes.critical === undefined)).toBe(true);
    await table.beat('lock_beat');
    const rolls = table.snapshot.activeBeat!.resolution!.rolls;
    expect(rolls).toHaveLength(1);
    expect(rolls[0]!.band).toBe('setback');
  });

  it('resets the plan when a selected line is edited', async () => {
    const table = await start();
    await table.planFresh();
    await table.beat('approve_stakes', { classification: 'action', contracts: table.snapshot.activeBeat!.contracts });
    const line = table.snapshot.submissions.find((s) => s.status === 'selected' || s.status === 'queued')!;
    await table.say('Tell me what you really saw.', line.revision, line.id);
    await table.refresh();
    const beat = table.snapshot.activeBeat!;
    expect(beat.classification).toBeNull();
    expect(beat.phase).toBe('collecting');
    expect(beat.contracts).toEqual([]);
  });

  it('resets the plan when a selected line is cancelled', async () => {
    const table = await start();
    await table.planFresh();
    await table.beat('approve_stakes', { classification: 'action', contracts: table.snapshot.activeBeat!.contracts });
    const line = table.snapshot.submissions.find((s) => s.status === 'selected' || s.status === 'queued')!;
    await table.send({ type: 'cancel_submission', submissionId: line.id, expectedSubmissionRevision: line.revision }, table.players[0]);
    await table.refresh();
    const beat = table.snapshot.activeBeat!;
    expect(beat.classification).toBeNull();
    expect(beat.phase).toBe('collecting');
    expect(beat.contracts).toEqual([]);
  });

  it('stores a plan whose critical branch is blank without it', async () => {
    const table = await start(new BlankCriticalProvider());
    await table.planFresh();
    const beat = table.snapshot.activeBeat!;
    expect(beat.phase).toBe('stakes_review');
    expect(beat.contracts).toHaveLength(1);
    expect(beat.contracts[0]!.outcomes.critical).toBeUndefined();
  });
});
