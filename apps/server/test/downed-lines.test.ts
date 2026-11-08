import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ActionContract, DirectorSnapshot, Effect, SessionState, Submission } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool, transaction } from '../src/database';
import { readState, saveState, saveSubmission } from '../src/repository';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'downed-lines-test-host-credential';
const goingDown = 'Going down can only come from a setback or a critical failure.';

suite('downed and dead characters on the server', () => {
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
  async function ok(value: Record<string, unknown>, credential = host) {
    const response = await command(value, credential);
    expect(response.statusCode, response.body).toBe(200);
    if (credential === host) snapshot = response.json().snapshot;
    return response;
  }
  async function refused(value: Record<string, unknown>, status: number, message?: string, credential = host) {
    const response = await command(value, credential);
    expect(response.statusCode, response.body).toBe(status);
    if (message) expect(response.json().message).toBe(message);
    return response;
  }
  const beatCommand = (type: string, value: Record<string, unknown> = {}) => ({ type, beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, ...value });
  const character = (id: string) => snapshot.characterDetails.find((item) => item.id === id)!;
  const nameOf = (id: string) => character(id).displayName;
  async function mutate(action: (state: SessionState) => void) {
    await transaction(pool, async (client) => { const state = await readState(client, sessionId); action(state); await saveState(client, state); });
    await refresh();
  }
  const say = (index: number, text: string, kind: 'say' | 'act' | 'ooc' = 'say') => command({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: snapshot.session.inputEpoch, contextBeatId: snapshot.activeBeat?.id ?? null,
    kind, text, recipientNpcIds: [], ...(kind === 'act' ? { intent: 'Open the archive', approach: 'Study the latch' } : {}) }, players[index]);
  const queued = () => snapshot.submissions.filter((item) => item.status === 'queued' || item.status === 'selected').map((item) => item.id);
  const queuedFor = (characterId: string) => snapshot.submissions.filter((item) => item.characterId === characterId && item.status === 'queued').map((item) => item.id);
  // Plans the lines of the given characters, then swaps the clean and costly branches (and others) the director would approve.
  async function planWith(characterIds: string[], edit: (contract: ActionContract) => void) {
    await refresh();
    await ok(beatCommand('plan_beat', { submissionIds: characterIds.flatMap(queuedFor) }));
    const contracts = structuredClone(snapshot.activeBeat!.contracts) as ActionContract[];
    for (const contract of contracts) edit(contract);
    return contracts;
  }
  const approve = (contracts: ActionContract[]) => beatCommand('approve_stakes', { classification: 'action', contracts });
  async function publishRound() {
    await ok(beatCommand('lock_beat')); await ok(beatCommand('render_beat'));
    await ok(beatCommand('publish_beat', { expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat!.draftRevision, textOnly: true }));
  }
  const openRound = async () => ok({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });

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

  it('refuses a downed character\'s Do lines and long Say lines in plain words, and lets short Say lines and out-of-character notes through', async () => {
    await openRound();
    await mutate((state) => { state.characters.find((item) => item.id === ids[0])!.condition = 'down'; });
    const name = nameOf(ids[0]!);
    const act = await say(0, '', 'act');
    expect(act.statusCode, act.body).toBe(400);
    expect(act.json().message).toBe(`${name} is down, so they cannot do anything. They can say a few words, up to 8.`);
    const long = await say(0, 'one two three four five six seven eight nine');
    expect(long.statusCode, long.body).toBe(400);
    expect(long.json().message).toBe(`${name} is down, so they can say only a few words, up to 8. This line has 9.`);
    expect((await say(0, 'one two three four five six seven eight')).statusCode).toBe(200);
    expect((await say(0, 'Please, I need a moment to say this', 'ooc')).statusCode).toBe(200);
    // Another character is not affected.
    expect((await say(1, 'one two three four five six seven eight nine ten')).statusCode).toBe(200);
  });

  it('refuses every line from a dead character except out-of-character notes', async () => {
    await openRound();
    await mutate((state) => { state.characters.find((item) => item.id === ids[0])!.condition = 'dead'; });
    const message = `${nameOf(ids[0]!)} has died, so they cannot send lines. You can keep watching the story.`;
    for (const [kind, text] of [['say', 'Hello'], ['act', '']] as const) {
      const response = await say(0, text, kind);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().message).toBe(message);
    }
    expect((await say(0, 'A note for the director', 'ooc')).statusCode).toBe(200);
  });

  it('brings a downed character back at 6 strain when a clean or costly rescue publishes', async () => {
    for (const [faces, band] of [[[6, 6], 'clean'], [[4, 3], 'costly']] as const) {
      await refresh();
      await openRound();
      await mutate((state) => { const item = state.characters.find((entry) => entry.id === ids[0])!; item.condition = 'down'; item.strain = 5; });
      expect((await say(1, 'Hold on, I am coming')).statusCode).toBe(200);
      const contracts = await planWith([ids[1]!], (contract) => {
        const rescue: Effect = { kind: 'character_rescue', characterId: ids[0]! };
        contract.outcomes.clean.effects = [rescue]; contract.outcomes.costly.effects = [rescue];
      });
      await ok(approve(contracts));
      dice.push(...faces);
      await ok(beatCommand('lock_beat'));
      expect(snapshot.activeBeat!.resolution!.rolls).toHaveLength(1);
      expect(snapshot.activeBeat!.resolution!.rolls[0]!.band).toBe(band);
      await ok(beatCommand('render_beat'));
      await ok(beatCommand('publish_beat', { expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat!.draftRevision, textOnly: true }));
      expect(character(ids[0]!).condition).toBeUndefined();
      expect('condition' in character(ids[0]!)).toBe(false);
      expect(character(ids[0]!).strain).toBe(6);
    }
  });

  it('puts an up character who takes strain at 8 of 8 down at publish, and stops one below 8 at 8', async () => {
    await openRound();
    await mutate((state) => { state.characters.find((item) => item.id === ids[0])!.strain = 8; state.characters.find((item) => item.id === ids[1])!.strain = 7; });
    expect((await say(0, 'I push on regardless')).statusCode).toBe(200);
    expect((await say(1, 'I push on as well')).statusCode).toBe(200);
    const contracts = await planWith(ids, (contract) => { contract.outcomes.clean.effects = [{ kind: 'strain_delta', characterId: contract.actorCharacterId, delta: contract.actorCharacterId === ids[0] ? 1 : 2 }]; });
    await ok(approve(contracts));
    dice.push(6, 6, 6, 6);
    await publishRound();
    expect(character(ids[0]!)).toMatchObject({ condition: 'down', strain: 8 });
    expect(character(ids[1]!).strain).toBe(8);
    expect(character(ids[1]!).condition).toBeUndefined();
  });

  it('refuses going down in a clean branch when the stakes are approved', async () => {
    await openRound();
    expect((await say(0, 'I step into the dark')).statusCode).toBe(200);
    const contracts = await planWith([ids[0]!], (contract) => { contract.outcomes.clean.effects = [{ kind: 'character_down', characterId: ids[0]! }]; });
    const response = await refused(approve(contracts), 400);
    expect(response.json().message).toBe(goingDown);
    // The same effect on a setback is accepted.
    contracts[0]!.outcomes.clean.effects = [];
    contracts[0]!.outcomes.setback.effects = [{ kind: 'character_down', characterId: ids[0]! }];
    await ok(approve(contracts));
    dice.push(1, 2);
    await publishRound();
    expect(character(ids[0]!).condition).toBe('down');
  });

  it('refuses to plan lines from a dead character, a downed character\'s Do line or long Say line, and too many rolls', async () => {
    await openRound();
    expect((await say(0, 'I search the room very carefully today for clues')).statusCode).toBe(200);
    expect((await say(1, '', 'act')).statusCode).toBe(200);
    await refresh();
    const first = queuedFor(ids[0]!), second = queuedFor(ids[1]!);

    await mutate((state) => { state.characters.find((item) => item.id === ids[0])!.condition = 'dead'; });
    await refused(beatCommand('plan_beat', { submissionIds: [...first, ...second] }), 409, `${nameOf(ids[0]!)} has died, so their lines cannot be used. Untick them.`);

    await mutate((state) => { state.characters.find((item) => item.id === ids[0])!.condition = 'down'; });
    const downMessage = (id: string) => `${nameOf(id)} is down, so only a Say line of up to 8 words can be used. Untick their other lines.`;
    await refused(beatCommand('plan_beat', { submissionIds: first }), 409, downMessage(ids[0]!));
    await mutate((state) => { delete state.characters.find((item) => item.id === ids[0])!.condition; state.characters.find((item) => item.id === ids[1])!.condition = 'down'; });
    await refused(beatCommand('plan_beat', { submissionIds: second }), 409, downMessage(ids[1]!));

    // Eleven selected lines plus two downed characters need 13 rolls.
    await mutate((state) => { for (const item of state.characters.slice(0, 2)) item.condition = 'down'; });
    const beatId = snapshot.activeBeat!.id;
    const extra: Submission[] = Array.from({ length: 11 }, () => ({ id: randomUUID(), sessionId, characterId: ids[0]!, contextBeatId: beatId, inputEpoch: snapshot.session.inputEpoch, revision: 1, kind: 'say', text: 'A short line', recipientNpcIds: [], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: true, status: 'queued' }));
    await transaction(pool, async (client) => { for (const item of extra) await saveSubmission(client, item); });
    await refresh();
    const response = await refused(beatCommand('plan_beat', { submissionIds: extra.map((item) => item.id) }), 409);
    expect(response.json().message).toContain('needs 13');
    // Ten lines plus two downed characters is exactly the limit.
    await ok(beatCommand('plan_beat', { submissionIds: extra.slice(0, 10).map((item) => item.id) }));
    expect(queued().length).toBeGreaterThan(0);
  });
});
