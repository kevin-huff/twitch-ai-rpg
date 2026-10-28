import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionContract, Command, DirectorSnapshot, PlayerSnapshot, SessionSnapshot, SessionState, StageSnapshot } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool, transaction } from '../src/database';
import { readState, saveState } from '../src/repository';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://localhost:3000';
const hostToken = 'every-line-rolls-test-host-credential';
const suite = databaseUrl ? describe : describe.skip;

suite('every line rolls, and a double 1 is a critical failure', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let host: string;
  let diceCalls = 0;
  const queue: number[] = [];
  const options = { databaseUrl: databaseUrl!, hostToken, origin, rollDie: () => { diceCalls++; return queue.shift() ?? 4; } };
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  async function request(path: string, credential: string, payload?: unknown) {
    return app.inject({ method: payload ? 'POST' : 'GET', url: path, headers: { origin, cookie: credential }, ...(payload ? { payload } : {}) });
  }

  async function newTable() {
    const creation = await request('/api/sessions', host, { commandId: crypto.randomUUID() });
    expect(creation.statusCode, creation.body).toBe(200);
    const created = creation.json();
    const sessionId: string = created.sessionId;
    const players: string[] = [];
    let stage = '';
    for (const invite of created.invites) {
      const redemption = await request('/api/auth/redeem', '', { token: invite.token });
      expect(redemption.statusCode).toBe(200);
      if (invite.role === 'player') players.push(cookie(redemption));
      if (invite.role === 'stage') stage = cookie(redemption);
    }
    let snapshot: DirectorSnapshot = (await request(`/api/sessions/${sessionId}`, host)).json();
    const send = async (value: Omit<Command, 'commandId'> | Record<string, unknown>, credential = host, expected = 200) => {
      const result = await request(`/api/sessions/${sessionId}/commands`, credential, { commandId: crypto.randomUUID(), ...value });
      expect(result.statusCode, result.body).toBe(expected);
      if (expected !== 200) return result;
      const next = result.json().snapshot as SessionSnapshot;
      if (next.role === 'director') snapshot = next;
      return result;
    };
    const table = {
      sessionId,
      players,
      stage,
      get snapshot() { return snapshot; },
      send,
      beat: (type: string, extras: Record<string, unknown> = {}, expected = 200) =>
        send({ type, beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, ...extras }, host, expected),
      async open(kind: 'action' | 'conversation') { await send({ type: 'open_beat', kind, expectedInputEpoch: snapshot.session.inputEpoch }); },
      async say(player: number, text: string) {
        await send({ type: 'save_submission', expectedSubmissionRevision: 0, contextBeatId: snapshot.activeBeat!.id, expectedInputEpoch: snapshot.session.inputEpoch, kind: 'say', text, recipientNpcIds: [] }, players[player]);
      },
      async act(player: number, intent: string, approach: string) {
        await send({ type: 'save_submission', expectedSubmissionRevision: 0, contextBeatId: snapshot.activeBeat!.id, expectedInputEpoch: snapshot.session.inputEpoch, kind: 'act', text: '', intent, approach }, players[player]);
      },
      async refresh() { snapshot = (await request(`/api/sessions/${sessionId}`, host)).json(); },
      async view(credential: string) { return (await request(`/api/sessions/${sessionId}`, credential)).json() as PlayerSnapshot | StageSnapshot; },
      queuedIds: () => snapshot.submissions.filter((s) => s.status === 'queued').map((s) => s.id),
      async plan() { await table.refresh(); await table.beat('plan_beat', { submissionIds: table.queuedIds() }); },
      async mutate(action: (state: SessionState) => void) {
        await transaction(pool, async (client) => { const state = await readState(client, sessionId); action(state); await saveState(client, state); });
        await table.refresh();
      },
      async enableCountdown() {
        const countdown = snapshot.tracks.find((track) => track.kind === 'countdown')!;
        const data = (await pool.query('SELECT data FROM tracks WHERE id=$1', [countdown.id])).rows[0].data;
        await pool.query('UPDATE tracks SET data=$2 WHERE id=$1', [countdown.id, { ...data, current: 1, enabled: true }]);
        await table.refresh();
        return countdown.id;
      },
      async finish() {
        await table.beat('render_beat');
        await table.beat('approve_continuity', { updates: table.snapshot.activeBeat!.draft!.continuity });
        await table.beat('publish_beat', { expectedStateRevision: table.snapshot.session.stateRevision, draftRevision: table.snapshot.activeBeat!.draftRevision, textOnly: true });
      },
    };
    return table;
  }

  const withoutCritical = (contracts: ActionContract[]) => contracts.map((contract) => {
    const { critical: _critical, ...outcomes } = contract.outcomes;
    return { ...contract, outcomes };
  });

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp(options);
    host = cookie(await request('/api/auth/host', '', { token: hostToken }));
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  it('rolls a conversation round once, keeps its kind and does not tick the countdown', async () => {
    const table = await newTable();
    queue.length = 0;
    const countdownId = await table.enableCountdown();
    await table.open('conversation');
    await table.say(0, 'What do you know about the owner?');
    await table.plan();
    const planned = table.snapshot.activeBeat!;
    expect(planned.classification).toBe('action');
    expect(planned.contracts).toHaveLength(1);
    expect(planned.contracts[0]!.ruling).toBe('check');
    expect(planned.contracts[0]!.outcomes.critical?.publicText.length).toBeGreaterThan(0);

    await table.beat('approve_stakes', { classification: 'action', contracts: planned.contracts });
    expect(table.snapshot.activeBeat!.kind).toBe('conversation');
    expect(table.snapshot.session.mode).toBe('conversation');

    const critical = planned.contracts[0]!.outcomes.critical!.publicText;
    const playerView = await table.view(table.players[0]!);
    const stageView = await table.view(table.stage);
    for (const view of [playerView, stageView]) {
      expect(view.activeBeat!.stakes).toHaveLength(1);
      expect(view.activeBeat!.stakes[0]!.outcomes.critical).toBe(critical);
    }

    const before = diceCalls;
    await table.beat('lock_beat');
    expect(diceCalls - before).toBe(2);
    expect(table.snapshot.activeBeat!.resolution!.rolls).toHaveLength(1);
    expect(table.snapshot.activeBeat!.kind).toBe('conversation');
    expect(table.snapshot.activeBeat!.resolution!.effects.some((effect) => effect.kind === 'track_delta' && effect.trackId === countdownId)).toBe(false);

    await table.finish();
    expect(diceCalls - before).toBe(2);
    expect(table.snapshot.session.actionRoundNumber).toBe(0);
    expect(table.snapshot.session.mode).toBe('conversation');
    expect(table.snapshot.history.at(-1)!.kind).toBe('conversation');
    expect(table.snapshot.tracks.find((track) => track.id === countdownId)!.current).toBe(1);
  });

  it('turns dice 1 and 1 into a critical failure and applies its effects at publish', async () => {
    const table = await newTable();
    await table.open('conversation');
    await table.say(0, 'I demand the ledger right now.');
    await table.plan();
    const contract = table.snapshot.activeBeat!.contracts[0]!;
    const critical = contract.outcomes.critical!;
    expect(critical.effects.length).toBeGreaterThan(0);
    await table.beat('approve_stakes', { classification: 'action', contracts: table.snapshot.activeBeat!.contracts });
    const strainBefore = table.snapshot.characters.map((character) => character.strain);
    const tracksBefore = table.snapshot.tracks.map((track) => track.current);

    queue.splice(0, queue.length, 1, 1);
    await table.beat('lock_beat');
    const resolution = table.snapshot.activeBeat!.resolution!;
    expect(resolution.rolls).toHaveLength(1);
    expect(resolution.rolls[0]!.band).toBe('critical');
    expect(resolution.outcomes[0]!.band).toBe('critical');
    expect(resolution.outcomes[0]!.goalAchieved).toBe(false);
    expect(resolution.outcomes[0]!.publicText).toBe(critical.publicText);
    expect(resolution.effects).toEqual(expect.arrayContaining(critical.effects));

    await table.finish();
    const history = table.snapshot.history.at(-1)!;
    expect(history.rolls[0]!.band).toBe('critical');
    for (const effect of critical.effects) {
      if (effect.kind === 'strain_delta') {
        const index = table.snapshot.characters.findIndex((character) => character.id === effect.characterId);
        expect(table.snapshot.characters[index]!.strain).toBe(Math.min(4, strainBefore[index]! + effect.delta));
      }
      if (effect.kind === 'track_delta') {
        const index = table.snapshot.tracks.findIndex((track) => track.id === effect.trackId);
        expect(table.snapshot.tracks[index]!.current).toBe(Math.min(table.snapshot.tracks[index]!.max, tracksBefore[index]! + effect.delta));
      }
    }
  });

  it('falls back to a setback on dice 1 and 1 when the contract has no critical branch, and shows no critical text', async () => {
    const table = await newTable();
    await table.open('conversation');
    await table.say(0, 'I ask again, a little louder.');
    await table.plan();
    const contracts = withoutCritical(table.snapshot.activeBeat!.contracts);
    await table.beat('approve_stakes', { classification: 'action', contracts });
    const playerView = await table.view(table.players[0]!);
    expect(playerView.activeBeat!.stakes).toHaveLength(1);
    expect(Object.keys(playerView.activeBeat!.stakes[0]!.outcomes)).not.toContain('critical');
    expect('critical' in (await table.view(table.stage)).activeBeat!.stakes[0]!.outcomes).toBe(false);

    queue.splice(0, queue.length, 1, 1);
    await table.beat('lock_beat');
    const resolution = table.snapshot.activeBeat!.resolution!;
    expect(resolution.rolls[0]!.band).toBe('setback');
    expect(resolution.outcomes[0]!.band).toBe('setback');
    expect(resolution.outcomes[0]!.goalAchieved).toBe(false);
    expect(resolution.outcomes[0]!.publicText).toBe(contracts[0]!.outcomes.setback.publicText);
  });

  it('lets a Say-led check approve and refuses a Do-led check at four strain', async () => {
    const table = await newTable();
    await table.open('conversation');
    await table.say(0, 'Please, just tell me.');
    await table.plan();
    const sayContracts = table.snapshot.activeBeat!.contracts;
    expect(sayContracts[0]!.ruling).toBe('check');
    const actorId = sayContracts[0]!.actorCharacterId;
    await table.mutate((state) => { state.characters.find((character) => character.id === actorId)!.strain = 4; });
    await table.beat('approve_stakes', { classification: 'action', contracts: table.snapshot.activeBeat!.contracts });
    expect(table.snapshot.activeBeat!.stakesApproved).toBe(true);

    const second = await newTable();
    await second.open('action');
    await second.act(0, 'I pick the lock', 'With a steady hand');
    await second.plan();
    const doContracts = second.snapshot.activeBeat!.contracts;
    expect(doContracts[0]!.ruling).toBe('check');
    const doer = doContracts[0]!.actorCharacterId;
    await second.mutate((state) => { state.characters.find((character) => character.id === doer)!.strain = 4; });
    const refused = await second.beat('approve_stakes', { classification: 'action', contracts: doContracts }, 400);
    expect(refused.json().message).toContain('four strain');
  });
});
