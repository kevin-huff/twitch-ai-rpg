import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AiDraft, DirectorSnapshot, LineAssistInput, PlanResult, ProviderContext, SessionState } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool, transaction } from '../src/database';
import { readState, saveState } from '../src/repository';
import { FakeAiProvider } from '../src/fake-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'conditions-and-dead-npcs-test-host-credential';
const sameCondition = 'A condition correction must change the current condition.';
const diedFirst = (name: string) => `${name} has died. Bring them back with a correction first.`;

suite('conditions, corrections and dead non-player characters', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let host: string, player: string, sessionId: string;
  let snapshot: DirectorSnapshot;
  let contexts: ProviderContext[];
  let assistInputs: LineAssistInput[];
  let speakerId: string;
  const fake = new FakeAiProvider();
  const options = { databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, providerTimeoutMs: 5000, rollDie: () => 4,
    provider: {
      plan: (context: ProviderContext): Promise<PlanResult> => { contexts.push(context); return fake.plan(context); },
      render: (context: ProviderContext): Promise<AiDraft> => fake.render(context),
      suggestLine: async (input: LineAssistInput) => { assistInputs.push(input); return { text: 'A suggestion.' }; },
    } };
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (path: string, payload?: Record<string, unknown>, credential = host) => app.inject({ method: payload === undefined ? 'GET' : 'POST', url: path, headers: { origin, cookie: credential }, ...(payload === undefined ? {} : { payload }) });
  const command = (value: Record<string, unknown>, credential = host) => request(`/api/sessions/${sessionId}/commands`, { commandId: randomUUID(), ...value }, credential);
  const refresh = async () => { const response = await request(`/api/sessions/${sessionId}`); expect(response.statusCode, response.body).toBe(200); snapshot = response.json(); };
  async function ok(value: Record<string, unknown>, credential = host) {
    const response = await command(value, credential);
    expect(response.statusCode, response.body).toBe(200);
    snapshot = response.json().snapshot;
    return response;
  }
  async function refused(value: Record<string, unknown>, status: number, message?: string, credential = host) {
    const response = await command(value, credential);
    expect(response.statusCode, response.body).toBe(status);
    if (message) expect(response.json().message).toBe(message);
    return response;
  }
  const beatCommand = (type: string, value: Record<string, unknown> = {}) => ({ type, beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, ...value });
  const correction = (changes: Record<string, unknown>[], value: Record<string, unknown> = {}) => ({ type: 'record_correction', expectedStateRevision: snapshot.session.stateRevision, publishedBeatId: snapshot.history[0]!.id,
    publicText: 'The director clarifies the previous scene.', reason: 'Private reason for this correction', discardQueuedInput: true, changes, ...value });
  const conditionSet = (characterId: string, condition: string) => ({ kind: 'condition_set', characterId, condition });
  const npcConditionSet = (npcId: string, condition: string) => ({ kind: 'npc_condition_set', npcId, condition });
  const characterId = () => snapshot.characterDetails[0]!.id;
  const character = () => snapshot.characterDetails.find((item) => item.id === characterId())!;
  const npc = (id: string) => snapshot.npcDetails.find((item) => item.id === id)!;
  const auditData = async (commandId: string) => (await pool.query('SELECT data FROM audit_events WHERE command_id=$1', [commandId])).rows[0].data;
  async function mutate(action: (state: SessionState) => void) {
    await transaction(pool, async (client) => { const state = await readState(client, sessionId); action(state); await saveState(client, state); });
    await refresh();
  }
  const say = (value: Record<string, unknown> = {}) => command({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: snapshot.session.inputEpoch, contextBeatId: snapshot.activeBeat?.id ?? null,
    kind: 'say', text: 'A question for the room', recipientNpcIds: [], ...value }, player);
  const queued = () => snapshot.submissions.filter((item) => item.status === 'queued' || item.status === 'selected').map((item) => item.id);
  async function killNpc(id: string) { await ok(correction([npcConditionSet(id, 'dead')])); }

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp(options);
    host = cookie(await request('/api/auth/host', { token: hostToken }, ''));
  });
  beforeEach(async () => {
    contexts = []; assistInputs = [];
    const created = (await request('/api/sessions', { commandId: randomUUID() })).json(); sessionId = created.sessionId;
    player = cookie(await request('/api/auth/redeem', { token: created.invites[0].token }, ''));
    await refresh();
    await ok({ type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });
    // One published round that holds a line spoken by a non-player character, so corrections have something to cite.
    await ok({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    const act = await say({ kind: 'act', text: '', intent: 'Open the archive', approach: 'Study the latch' });
    expect(act.statusCode, act.body).toBe(200);
    await refresh();
    await ok(beatCommand('plan_beat', { submissionIds: queued() }));
    await ok(beatCommand('approve_stakes', { classification: 'action', contracts: snapshot.activeBeat!.contracts }));
    await ok(beatCommand('lock_beat')); await ok(beatCommand('render_beat'));
    await ok(beatCommand('publish_beat', { expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat!.draftRevision, textOnly: true }));
    speakerId = snapshot.npcDetails.find((item) => snapshot.history[0]!.segments.some((segment) => segment.speaker?.displayName === item.displayName))!.id;
    const place = snapshot.session.scene.locationId;
    await mutate((state) => {
      while (state.npcs.length < 3) state.npcs.push({ ...structuredClone(state.npcs[0]!), id: randomUUID(), displayName: `Extra ${state.npcs.length}` });
      for (const item of state.npcs) { item.status = 'offstage'; item.locationId = place; item.communicationChannel = null; item.version = 1; }
      state.npcs.find((item) => item.id === speakerId)!.status = 'present';
    });
    contexts = [];
  });
  afterAll(async () => { await app?.close(); await pool.end(); });

  it('sets a player character down, dead and up again with before and after recorded', async () => {
    await mutate((state) => { state.characters[0]!.strain = 5; });
    const revision = snapshot.session.stateRevision;
    const down = await ok(correction([conditionSet(characterId(), 'down')]));
    expect(character().condition).toBe('down');
    expect(character().strain).toBe(5);
    expect(snapshot.session.stateRevision).toBe(revision + 1);
    let audit = await auditData(down.json().commandId);
    expect(audit.before.characters.find((item: { id: string }) => item.id === characterId()).condition).toBeUndefined();
    expect(audit.after.characters.find((item: { id: string }) => item.id === characterId()).condition).toBe('down');
    expect(audit.changes).toEqual([conditionSet(characterId(), 'down')]);
    expect(snapshot.characters.find((item) => item.id === characterId())!.condition).toBe('down');

    const dead = await ok(correction([conditionSet(characterId(), 'dead')]));
    expect(character().condition).toBe('dead');
    audit = await auditData(dead.json().commandId);
    expect(audit.before.characters.find((item: { id: string }) => item.id === characterId()).condition).toBe('down');
    expect(audit.after.characters.find((item: { id: string }) => item.id === characterId()).condition).toBe('dead');

    const up = await ok(correction([conditionSet(characterId(), 'up')]));
    expect('condition' in character()).toBe(false);
    expect(character().strain).toBe(5);
    audit = await auditData(up.json().commandId);
    expect(audit.before.characters.find((item: { id: string }) => item.id === characterId()).condition).toBe('dead');
    expect('condition' in audit.after.characters.find((item: { id: string }) => item.id === characterId())).toBe(false);
    expect('condition' in snapshot.characters.find((item) => item.id === characterId())!).toBe(false);
  });

  it('refuses a condition that does not change, an unknown character and the same character twice', async () => {
    await refused(correction([conditionSet(characterId(), 'up')]), 409, sameCondition);
    await ok(correction([conditionSet(characterId(), 'down')]));
    await refused(correction([conditionSet(characterId(), 'down')]), 409, sameCondition);
    await refused(correction([conditionSet(randomUUID(), 'dead')]), 409, 'That character no longer exists.');
    await refused(correction([conditionSet(characterId(), 'dead'), conditionSet(characterId(), 'up')]), 400);
    expect(character().condition).toBe('down');
    // The same id under two different kinds is two different targets.
    await ok(correction([conditionSet(characterId(), 'up'), { kind: 'strain_set', characterId: characterId(), value: 2 }]));
    expect(character().strain).toBe(2);
  });

  it('kills a non-player character and takes them off stage, then brings them back off stage, recording both', async () => {
    const before = npc(speakerId);
    expect(before.status).toBe('present');
    const killed = await ok(correction([npcConditionSet(speakerId, 'dead')]));
    expect(npc(speakerId)).toMatchObject({ condition: 'dead', status: 'offstage', version: before.version + 1 });
    let audit = await auditData(killed.json().commandId);
    expect(audit.before.npcs.find((item: { id: string }) => item.id === speakerId)).toMatchObject({ status: 'present', version: before.version });
    expect(audit.before.npcs.find((item: { id: string }) => item.id === speakerId).condition).toBeUndefined();
    expect(audit.after.npcs.find((item: { id: string }) => item.id === speakerId)).toMatchObject({ condition: 'dead', status: 'offstage', version: before.version + 1 });
    await refused(correction([npcConditionSet(speakerId, 'dead')]), 409, sameCondition);

    const revived = await ok(correction([npcConditionSet(speakerId, 'alive')]));
    expect('condition' in npc(speakerId)).toBe(false);
    expect(npc(speakerId)).toMatchObject({ status: 'offstage', version: before.version + 2 });
    audit = await auditData(revived.json().commandId);
    expect(audit.before.npcs.find((item: { id: string }) => item.id === speakerId).condition).toBe('dead');
    expect('condition' in audit.after.npcs.find((item: { id: string }) => item.id === speakerId)).toBe(false);
    await refused(correction([npcConditionSet(speakerId, 'alive')]), 409, sameCondition);
    await refused(correction([npcConditionSet(randomUUID(), 'dead')]), 409, 'That non-player character no longer exists.');
  });

  it('applies a character and a non-player character condition in one correction', async () => {
    await ok(correction([conditionSet(characterId(), 'down'), npcConditionSet(speakerId, 'dead')]));
    expect(character().condition).toBe('down');
    expect(npc(speakerId).condition).toBe('dead');
  });

  it('keeps a dead non-player character off the stage through Who is here, a new scene and an NPC edit', async () => {
    await killNpc(speakerId);
    const name = npc(speakerId).displayName;
    const revision = () => snapshot.session.stateRevision;
    await refused({ type: 'set_cast', expectedStateRevision: revision(), presentNpcIds: [speakerId] }, 409, diedFirst(name));
    await refused({ type: 'change_scene', expectedStateRevision: revision(), title: 'Somewhere else', description: 'A new place.', location: { kind: 'new', title: 'Elsewhere', description: '' }, presentNpcIds: [speakerId], reason: 'Move on' }, 409, diedFirst(name));
    const { id: _id, version: _version, knowledge: _knowledge, relationships: _relationships, ...profile } = npc(speakerId);
    await refused({ type: 'save_npc', expectedStateRevision: revision(), npcId: speakerId, expectedNpcVersion: npc(speakerId).version, reason: 'Edit', profile: { ...profile, status: 'present' } }, 409, diedFirst(name));
    expect(npc(speakerId)).toMatchObject({ status: 'offstage', condition: 'dead' });
    // The form of a dead character carries condition 'dead'; saving it offstage keeps it dead and cannot raise it.
    await ok({ type: 'save_npc', expectedStateRevision: revision(), npcId: speakerId, expectedNpcVersion: npc(speakerId).version, reason: 'Edit', profile: { ...profile, role: 'Gone but not forgotten', status: 'offstage' } });
    expect(npc(speakerId)).toMatchObject({ condition: 'dead', role: 'Gone but not forgotten' });
    // A new character cannot be made dead through the form.
    await ok({ type: 'save_npc', expectedStateRevision: revision(), expectedNpcVersion: 0, reason: 'Add', profile: { ...profile, displayName: 'Newcomer', condition: 'dead', status: 'offstage' } });
    expect(snapshot.npcDetails.find((item) => item.displayName === 'Newcomer')!.condition).toBeUndefined();
    const stage = snapshot.npcDetails.filter((item) => item.status === 'present' && item.locationId === snapshot.session.scene.locationId);
    expect(stage.map((item) => item.id)).not.toContain(speakerId);
  });

  it('refuses a new line addressed to a dead non-player character even when they have a way to be reached', async () => {
    await mutate((state) => { const target = state.npcs.find((item) => item.id === speakerId)!; target.status = 'present'; target.communicationChannel = 'Radio'; });
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    const alive = await say({ recipientNpcIds: [speakerId] });
    expect(alive.statusCode, alive.body).toBe(200);
    await mutate((state) => { state.npcs.find((item) => item.id === speakerId)!.condition = 'dead'; });
    const dead = await say({ recipientNpcIds: [speakerId] });
    expect(dead.statusCode, dead.body).toBe(409);
    expect(dead.json().message).toBe('The addressed NPC is unavailable.');
  });

  it('refuses to plan a round that holds a line addressed to a non-player character who has died since', async () => {
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    const sent = await say({ recipientNpcIds: [speakerId] });
    expect(sent.statusCode, sent.body).toBe(200);
    await refresh();
    const name = npc(speakerId).displayName;
    await mutate((state) => { state.npcs.find((item) => item.id === speakerId)!.condition = 'dead'; });
    await refused(beatCommand('plan_beat', { submissionIds: queued() }), 409, `A selected line speaks to ${name}, who has died. Untick it.`);
    await refresh();
    expect(snapshot.activeBeat!.phase).toBe('collecting');
    expect(snapshot.submissions.filter((item) => queued().includes(item.id)).every((item) => item.status === 'queued')).toBe(true);
    expect(queued()).toHaveLength(1);
    expect(contexts).toHaveLength(0);
  });

  it('refuses a script line spoken by a dead non-player character and a dead witness, while a published line still plays', async () => {
    await ok({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    expect((await say({ kind: 'act', text: '', intent: 'Open the archive', approach: 'Study the latch' })).statusCode).toBe(200);
    await refresh();
    await ok(beatCommand('plan_beat', { submissionIds: queued() }));
    await ok(beatCommand('approve_stakes', { classification: 'action', contracts: snapshot.activeBeat!.contracts }));
    await ok(beatCommand('lock_beat')); await ok(beatCommand('render_beat'));
    const segments = (npcId: string) => [{ kind: 'npc_dialogue', speakerNpcId: npcId, text: 'I have more to say.', delivery: 'neutral', recipientCharacterIds: [] }];
    await ok(beatCommand('edit_script', { segments: segments(speakerId) }));
    await mutate((state) => { const target = state.npcs.find((item) => item.id === speakerId)!; target.condition = 'dead'; target.status = 'present'; target.communicationChannel = 'Radio'; });
    await refused(beatCommand('edit_script', { segments: segments(speakerId) }), 409, 'An NPC speaker is unknown or unavailable.');
    const witness = { kind: 'npc_knowledge', npcId: speakerId, statement: 'Someone opened the archive.', category: 'fact', acquisition: 'witnessed', sourceSubmissionIds: snapshot.activeBeat!.lockedSubmissions.map((item) => item.id), sourceEntityId: characterId() };
    await refresh();
    await refused(beatCommand('approve_continuity', { updates: [witness] }), 409, 'That NPC cannot witness this exchange.');
    await mutate((state) => { delete state.npcs.find((item) => item.id === speakerId)!.condition; });
    await ok(beatCommand('approve_continuity', { updates: [witness] }));
    await mutate((state) => { state.npcs.find((item) => item.id === speakerId)!.condition = 'dead'; });
    // The round that was published before the death is untouched.
    expect(snapshot.history[0]!.segments.some((segment) => segment.speaker?.displayName === npc(speakerId).displayName)).toBe(true);
  });

  it('refuses a dead witness when revealing a secret', async () => {
    const target = snapshot.npcDetails.find((item) => item.id !== speakerId)!;
    await mutate((state) => {
      const subject = state.npcs.find((item) => item.id === target.id)!; subject.status = 'present'; subject.secrets = ['A private secret'];
      const witness = state.npcs.find((item) => item.id === speakerId)!; witness.condition = 'dead'; witness.status = 'present';
    });
    const reveal = (witnessNpcIds: string[]) => ({ type: 'reveal_npc', expectedStateRevision: snapshot.session.stateRevision, npcId: target.id, expectedNpcVersion: npc(target.id).version,
      source: { kind: 'secret', index: 0 }, publicText: 'It comes out.', witnessNpcIds, reason: 'Reveal' });
    await refused(reveal([speakerId]), 409, 'Every witness must be physically present in the current scene.');
    await ok(reveal([target.id]));
  });

  it('keeps the story history, with the dead character\'s earlier line, after they die', async () => {
    const before = structuredClone(snapshot.history);
    await killNpc(speakerId);
    expect(snapshot.history).toEqual(before);
    const published = (await pool.query('SELECT data FROM published_beats WHERE session_id=$1', [sessionId])).rows[0].data;
    expect(JSON.stringify(published)).toContain(npc(speakerId).displayName);
  });

  it('sends the names of dead non-player characters to the provider and nothing when nobody has died', async () => {
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    expect((await say()).statusCode).toBe(200);
    await refresh();
    await ok(beatCommand('plan_beat', { submissionIds: queued() }));
    expect(contexts).toHaveLength(1);
    expect('deadNpcNames' in contexts[0]!).toBe(false);
    await killNpc(speakerId);
    await refresh();
    await ok(beatCommand('plan_beat', { submissionIds: queued() }));
    expect(contexts).toHaveLength(2);
    expect(contexts[1]!.deadNpcNames).toEqual([npc(speakerId).displayName]);
    expect(contexts[1]!.state.npcs.map((item) => item.id)).not.toContain(speakerId);
  });

  describe('Help me say it', () => {
    const assist = (credential = player) => request(`/api/sessions/${sessionId}/line-assist`, { idea: 'tell her we mean no harm' }, credential);

    it('refuses a downed character and a dead character with plain reasons, and calls the helper for neither', async () => {
      const name = character().displayName;
      await ok(correction([conditionSet(characterId(), 'down')]));
      let response = await assist();
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().message).toBe(`${name} is down, so Help me say it is off. Write up to 8 words yourself.`);
      await ok(correction([conditionSet(characterId(), 'dead')]));
      response = await assist();
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().message).toBe(`${name} has died, so there is no line to help with.`);
      expect(assistInputs).toHaveLength(0);
      await ok(correction([conditionSet(characterId(), 'up')]));
      response = await assist();
      expect(response.statusCode, response.body).toBe(200);
      expect(assistInputs).toHaveLength(1);
    });

    it('refuses to address a dead non-player character and leaves the dead out of who is here', async () => {
      await mutate((state) => {
        const target = state.npcs.find((item) => item.id === speakerId)!; target.status = 'present'; target.communicationChannel = 'Radio';
        const second = state.npcs.find((item) => item.id !== speakerId)!; second.status = 'present';
        if (state.characters.length < 2) state.characters.push({ ...structuredClone(state.characters[0]!), id: randomUUID(), displayName: 'Second seat' });
      });
      const request1 = await request(`/api/sessions/${sessionId}/line-assist`, { idea: 'a word', recipientNpcIds: [speakerId] }, player);
      expect(request1.statusCode, request1.body).toBe(200);
      expect(assistInputs.at(-1)!.talkingTo.map((item) => item.displayName)).toEqual([npc(speakerId).displayName]);
      const second = snapshot.npcDetails.find((item) => item.id !== speakerId && item.status === 'present')!;
      const others = snapshot.characterDetails.find((item) => item.id !== characterId())!;
      await mutate((state) => { state.npcs.find((item) => item.id === speakerId)!.condition = 'dead'; state.npcs.find((item) => item.id === second.id)!.condition = 'dead'; state.characters.find((item) => item.id === others.id)!.condition = 'dead'; });
      const dead = await request(`/api/sessions/${sessionId}/line-assist`, { idea: 'a word', recipientNpcIds: [speakerId] }, player);
      expect(dead.statusCode, dead.body).toBe(409);
      expect(dead.json().message).toBe('The addressed NPC is unavailable.');
      const plain = await request(`/api/sessions/${sessionId}/line-assist`, { idea: 'a word' }, player);
      expect(plain.statusCode, plain.body).toBe(200);
      const input = assistInputs.at(-1)!;
      expect(input.present.npcs.map((item) => item.displayName)).not.toContain(second.displayName);
      expect(input.present.npcs.map((item) => item.displayName)).not.toContain(npc(speakerId).displayName);
      expect(input.present.characters.map((item) => item.displayName)).not.toContain(others.displayName);
    });
  });
});
