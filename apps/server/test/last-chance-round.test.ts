import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ActionContract, DirectorSnapshot, OutcomeBand, SessionState } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool, transaction } from '../src/database';
import { readState, saveState } from '../src/repository';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'last-chance-round-test-host-credential';

suite('the last-chance roll through a round', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let host: string, sessionId: string;
  let players: string[];
  let ids: string[];
  let snapshot: DirectorSnapshot;
  const dice: number[] = [];
  const options = { databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, providerTimeoutMs: 5000, rollDie: () => dice.shift() ?? 4 };
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
  const character = (id: string) => snapshot.characterDetails.find((item) => item.id === id)!;
  const nameOf = (id: string) => character(id).displayName;
  async function mutate(action: (state: SessionState) => void) {
    await transaction(pool, async (client) => { const state = await readState(client, sessionId); action(state); await saveState(client, state); });
    await refresh();
  }
  const putDown = (id: string, strain = 8) => mutate((state) => { const item = state.characters.find((entry) => entry.id === id)!; item.condition = 'down'; item.strain = strain; });
  async function line(index: number, text: string, kind: 'say' | 'act' = 'say') {
    const response = await command({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: snapshot.session.inputEpoch, contextBeatId: snapshot.activeBeat?.id ?? null,
      kind, text, recipientNpcIds: [], ...(kind === 'act' ? { intent: 'Open the archive', approach: 'Study the latch' } : {}) }, players[index]);
    expect(response.statusCode, response.body).toBe(200);
    await refresh();
  }
  const queuedFor = (characterId: string) => snapshot.submissions.filter((item) => item.characterId === characterId && item.status === 'queued').map((item) => item.id);
  const rollRows = async (beatId: string) => (await pool.query('SELECT id,data FROM rolls WHERE beat_id=$1', [beatId])).rows;
  const lockEvent = async (commandId: string) => (await pool.query("SELECT data FROM audit_events WHERE command_id=$1 AND kind='lock_beat'", [commandId])).rows[0]?.data;
  async function renderAndPublish() {
    await ok(beatCommand('render_beat'));
    await ok(beatCommand('publish_beat', { expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat!.draftRevision, textOnly: true }));
  }
  // A conversation round with no contracts: the only dice are the last chance.
  async function ordinaryRound(speaker: number) {
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    await line(speaker, 'Stay with me, please');
    await ok(beatCommand('plan_beat', { submissionIds: queuedFor(ids[speaker]!) }));
    await ok(beatCommand('approve_stakes', { classification: 'ordinary', contracts: [] }));
  }

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp(options);
    host = cookie(await request('/api/auth/host', { token: hostToken }, ''));
  });
  beforeEach(async () => {
    dice.length = 0;
    const created = (await request('/api/sessions', { commandId: randomUUID() })).json(); sessionId = created.sessionId;
    const seats = created.invites.filter((invite: { role: string }) => invite.role === 'player').slice(0, 2);
    players = []; ids = [];
    for (const invite of seats) { players.push(cookie(await request('/api/auth/redeem', { token: invite.token }, ''))); ids.push(invite.characterId); }
    await refresh();
    await ok({ type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });
  });
  afterAll(async () => { await app?.close(); await pool.end(); });

  it.each([
    [[6, 5], 11, 'clean', true],
    [[4, 4], 8, 'costly', true],
    [[2, 3], 5, 'setback', false],
    [[1, 1], 2, 'critical', false],
  ] as const)('rolls %j as %i (%s) at lock, keeps it out of the rolls table, and applies it on publish', async (faces, total, band: OutcomeBand, survives) => {
    await putDown(ids[0]!);
    const name = nameOf(ids[0]!);
    await ordinaryRound(1);
    dice.push(...faces);
    const lock = await ok(beatCommand('lock_beat'));
    const beatId = snapshot.activeBeat!.id;
    const roll = { id: `last-chance:${ids[0]}`, contractId: `last-chance:${ids[0]}`, contractVersion: 1, actorCharacterId: ids[0], faces, trait: 'force', traitModifier: 0, edge: 0, total, band, lastChance: true };
    const outcome = { contractId: `last-chance:${ids[0]}`, actorCharacterId: ids[0], status: 'resolved', band, goalAchieved: survives,
      publicText: survives ? `${name}'s last chance: ${name} pulls through at 7 of 8.` : `${name}'s last chance: ${name} dies.` };
    expect(snapshot.activeBeat!.resolution!.rolls).toEqual([roll]);
    expect(snapshot.activeBeat!.resolution!.outcomes).toEqual([outcome]);
    expect(await rollRows(beatId)).toEqual([]);
    expect((await lockEvent(lock.json().commandId)).lastChances).toEqual([{ characterId: ids[0], faces, total, band }]);
    // Nothing changes until publish.
    expect(character(ids[0]!).condition).toBe('down');
    await renderAndPublish();
    const published = snapshot.history.at(-1)!;
    expect(published.id).toBe(beatId);
    expect(published.rolls).toEqual([roll]);
    expect(published.outcomes).toEqual([outcome]);
    if (survives) {
      expect('condition' in character(ids[0]!)).toBe(false);
      expect(character(ids[0]!).strain).toBe(7);
    } else {
      expect(character(ids[0]!).condition).toBe('dead');
      expect(character(ids[0]!).strain).toBe(8);
    }
    expect(await rollRows(beatId)).toEqual([]);
  });

  it('rolls the last chance after the contract dice in an action round, and stores only the contract rolls', async () => {
    await putDown(ids[0]!, 5);
    await ok({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    await line(1, '', 'act');
    await ok(beatCommand('plan_beat', { submissionIds: queuedFor(ids[1]!) }));
    const contracts = structuredClone(snapshot.activeBeat!.contracts) as ActionContract[];
    for (const contract of contracts) for (const branch of Object.values(contract.outcomes)) if (branch) branch.effects = [];
    await ok(beatCommand('approve_stakes', { classification: 'action', contracts }));
    dice.push(...Array.from({ length: contracts.filter((contract) => contract.ruling === 'check').length * 2 }, () => 3), 1, 2);
    const lock = await ok(beatCommand('lock_beat'));
    const beatId = snapshot.activeBeat!.id;
    const rolls = snapshot.activeBeat!.resolution!.rolls;
    expect(rolls.at(-1)).toMatchObject({ actorCharacterId: ids[0], lastChance: true, faces: [1, 2], total: 3, band: 'setback' });
    expect(rolls.filter((roll) => roll.lastChance)).toHaveLength(1);
    const stored = await rollRows(beatId);
    expect(stored.map((row) => row.id).sort()).toEqual(rolls.filter((roll) => !roll.lastChance).map((roll) => roll.id).sort());
    expect((await lockEvent(lock.json().commandId)).lastChances).toEqual([{ characterId: ids[0], faces: [1, 2], total: 3, band: 'setback' }]);
    await renderAndPublish();
    expect(character(ids[0]!).condition).toBe('dead');
    expect(snapshot.history.at(-1)!.rolls).toEqual(rolls);
  });

  it('rolls no last chance for a character a clean rescue saves', async () => {
    await putDown(ids[0]!, 5);
    await ok({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    await line(1, 'Hold on, I am coming');
    await ok(beatCommand('plan_beat', { submissionIds: queuedFor(ids[1]!) }));
    const contracts = structuredClone(snapshot.activeBeat!.contracts) as ActionContract[];
    for (const contract of contracts) {
      contract.outcomes.clean.effects = [{ kind: 'character_rescue', characterId: ids[0]! }];
      contract.outcomes.costly.effects = [{ kind: 'character_rescue', characterId: ids[0]! }];
      contract.outcomes.setback.effects = [];
      if (contract.outcomes.critical) contract.outcomes.critical.effects = [];
    }
    await ok(beatCommand('approve_stakes', { classification: 'action', contracts }));
    dice.push(6, 6, 1, 1);
    const lock = await ok(beatCommand('lock_beat'));
    expect(snapshot.activeBeat!.resolution!.rolls.some((roll) => roll.lastChance)).toBe(false);
    expect((await lockEvent(lock.json().commandId)).lastChances).toBeUndefined();
    await renderAndPublish();
    expect('condition' in character(ids[0]!)).toBe(false);
    expect(character(ids[0]!).strain).toBe(6);
  });

  it('rolls no last chance in a Narrate the scene beat, and the character stays down', async () => {
    await putDown(ids[0]!);
    await ok({ type: 'narrate_scene', expectedInputEpoch: snapshot.session.inputEpoch });
    dice.push(1, 1);
    expect(snapshot.activeBeat!.resolution!.rolls).toEqual([]);
    await renderAndPublish();
    expect(snapshot.history.at(-1)!.rolls).toEqual([]);
    expect(character(ids[0]!).condition).toBe('down');
    expect(dice).toEqual([1, 1]);
  });
});
