import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Command, DirectorSnapshot, SessionSnapshot } from '@rpg/contracts';
import { tooManyRollsMessage } from '@rpg/rules';
import { buildApp } from '../src/app';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://localhost:3000';
const hostToken = 'player-lines-test-host-credential';
const suite = databaseUrl ? describe : describe.skip;

suite('player lines and actions in one round', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let host: string;
  let diceCalls = 0;
  const options = { databaseUrl: databaseUrl!, hostToken, origin, rollDie: () => { diceCalls++; return 4; } };
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
    for (const invite of created.invites) {
      const redemption = await request('/api/auth/redeem', '', { token: invite.token });
      expect(redemption.statusCode).toBe(200);
      if (invite.role === 'player') players.push(cookie(redemption));
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
      players,
      get snapshot() { return snapshot; },
      send,
      beat: (type: string, extras: Record<string, unknown> = {}, expected = 200) =>
        send({ type, beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, ...extras }, host, expected),
      async openAction() { await send({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch }); },
      async say(player: number, text: string) {
        await send({ type: 'save_submission', expectedSubmissionRevision: 0, contextBeatId: snapshot.activeBeat!.id, expectedInputEpoch: snapshot.session.inputEpoch, kind: 'say', text, recipientNpcIds: [] }, players[player]);
      },
      async act(player: number, intent: string, approach: string) {
        await send({ type: 'save_submission', expectedSubmissionRevision: 0, contextBeatId: snapshot.activeBeat!.id, expectedInputEpoch: snapshot.session.inputEpoch, kind: 'act', text: '', intent, approach }, players[player]);
      },
      async refresh() { snapshot = (await request(`/api/sessions/${sessionId}`, host)).json(); },
      queuedIds: () => snapshot.submissions.filter((s) => s.status === 'queued').map((s) => s.id),
    };
    return table;
  }

  beforeAll(async () => {
    app = await buildApp(options);
    const auth = await request('/api/auth/host', '', { token: hostToken });
    host = cookie(auth);
  });
  afterAll(async () => { await app?.close(); });

  it('lets one player do and say in a round, rolls twice and publishes both lines in order', async () => {
    const table = await newTable();
    await table.openAction();
    await table.act(0, 'I climb the fire escape', 'Quietly and slowly');
    await table.say(0, 'Stay here, I will be right back.');
    await table.refresh();
    const lines = table.snapshot.submissions.filter((s) => s.status === 'queued');
    expect(lines).toHaveLength(2);
    const characterId = lines[0]!.characterId;
    await table.beat('plan_beat', { submissionIds: table.queuedIds() });
    const contracts = table.snapshot.activeBeat!.contracts;
    expect(contracts).toHaveLength(2);
    expect(contracts.every((contract) => contract.actorCharacterId === characterId)).toBe(true);
    await table.beat('approve_stakes', { classification: 'action', contracts });
    const before = diceCalls;
    await table.beat('lock_beat');
    expect(diceCalls - before).toBe(4);
    expect(table.snapshot.activeBeat!.resolution!.rolls).toHaveLength(2);
    await table.beat('render_beat');
    await table.beat('approve_continuity', { updates: table.snapshot.activeBeat!.draft!.continuity });
    await table.beat('publish_beat', { expectedStateRevision: table.snapshot.session.stateRevision, draftRevision: table.snapshot.activeBeat!.draftRevision, textOnly: true });
    const published = table.snapshot.history.at(-1)!;
    const kinds = published.segments.map((segment) => segment.kind);
    expect(kinds.slice(0, 2)).toEqual(['player_action', 'player_dialogue']);
    expect(kinds.slice(2).every((kind) => kind === 'narration' || kind === 'npc_dialogue')).toBe(true);
    const [action, said] = published.segments;
    const doLine = lines.find((line) => line.kind === 'act')!;
    const sayLine = lines.find((line) => line.kind === 'say')!;
    expect(action!.text).toBe('I climb the fire escape\nQuietly and slowly');
    expect(action!.sourceSubmissionIds).toEqual([doLine.id]);
    expect(action!.speaker!.entityId).toBe(characterId);
    expect(said!.text).toBe('Stay here, I will be right back.');
    expect(said!.sourceSubmissionIds).toEqual([sayLine.id]);
    expect(said!.speaker!.entityId).toBe(characterId);
    expect(published.segments.every((segment) => segment.ttsEnabled === false)).toBe(true);
  });

  it('refuses a helper who is the actor of the same action', async () => {
    const table = await newTable();
    await table.openAction();
    await table.act(0, 'I pick the lock', 'With a steady hand');
    await table.refresh();
    await table.beat('plan_beat', { submissionIds: table.queuedIds() });
    const contract = table.snapshot.activeBeat!.contracts[0]!;
    const selfHelp = { ...contract, helperCharacterIds: [contract.actorCharacterId], edge: 1, edgeReason: 'They steady their own hand.' };
    const refused = await table.beat('approve_stakes', { classification: 'action', contracts: [selfHelp] }, 400);
    expect(refused.json().message).toContain('cannot help their own action');
  });

  it('plans eight rolls in one round now that a round holds twelve', async () => {
    const table = await newTable();
    await table.openAction();
    for (const [index] of table.players.entries()) {
      await table.act(index, `Do the thing ${index}`, 'Carefully');
      await table.say(index, `Say the thing ${index}`);
    }
    await table.refresh();
    expect(table.queuedIds()).toHaveLength(8);
    await table.beat('plan_beat', { submissionIds: table.queuedIds() });
    expect(table.snapshot.activeBeat!.lastError).toBeNull();
    expect(table.snapshot.activeBeat!.phase).toBe('stakes_review');
    expect(table.snapshot.activeBeat!.contracts).toHaveLength(8);
    expect(tooManyRollsMessage(13)).toContain('at most 12 rolls');
  });

  it('narrates the scene before the first round, with no lines and no dice, and again after it', async () => {
    const table = await newTable();
    await table.send({ type: 'narrate_scene', expectedInputEpoch: table.snapshot.session.inputEpoch });
    expect(table.snapshot.activeBeat).toMatchObject({ kind: 'conversation', phase: 'locked', selectedSubmissionIds: [], contracts: [] });
    await table.beat('render_beat');
    expect(table.snapshot.activeBeat!.phase).toBe('draft_review');
    const scene = table.snapshot.session.scene;
    expect(table.snapshot.activeBeat!.draft!.segments).toEqual([expect.objectContaining({ kind: 'narration', text: scene.description.trim() || `The story opens at ${scene.title}.` })]);
    await table.beat('publish_beat', { expectedStateRevision: table.snapshot.session.stateRevision, draftRevision: table.snapshot.activeBeat!.draftRevision, textOnly: true });
    expect(table.snapshot.history).toHaveLength(1);
    expect(table.snapshot.history[0]!.rolls).toEqual([]);
    expect(table.snapshot.history[0]!.segments.map((segment) => segment.kind)).toEqual(['narration']);
    await table.send({ type: 'narrate_scene', expectedInputEpoch: table.snapshot.session.inputEpoch });
    expect(table.snapshot.activeBeat!.phase).toBe('locked');
    await table.send({ type: 'narrate_scene', expectedInputEpoch: table.snapshot.session.inputEpoch }, undefined, 409);
  });
});
