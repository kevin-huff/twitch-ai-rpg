import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Command, DirectorSnapshot, SessionSnapshot } from '@rpg/contracts';
import { buildApp } from '../src/app';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://localhost:3000';
const hostToken = 'session-integration-test-host-credential';
const suite = databaseUrl ? describe : describe.skip;

suite('durable multiplayer session', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let host: string;
  let sessionId: string;
  let players: string[];
  let stage: string;
  let snapshot: DirectorSnapshot;
  let diceCalls = 0;
  const options = { databaseUrl: databaseUrl!, hostToken, origin, rollDie: () => { diceCalls++; return 4; } };
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  async function request(path: string, credential: string, payload?: unknown) {
    return app.inject({ method: payload ? 'POST' : 'GET', url: path, headers: { origin, cookie: credential }, ...(payload ? { payload } : {}) });
  }
  async function command(value: Omit<Command, 'commandId'> | Record<string, unknown>, credential = host) {
    const result = await request(`/api/sessions/${sessionId}/commands`, credential, { commandId: crypto.randomUUID(), ...value });
    expect(result.statusCode, result.body).toBe(200);
    const next = result.json().snapshot as SessionSnapshot;
    if (next.role === 'director') snapshot = next;
    return next;
  }
  async function beat(type: string, extras: Record<string, unknown> = {}) {
    return command({ type, beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, ...extras });
  }
  async function publishConversation(text: string, playerIndex = 0) {
    await command({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    await command({ type: 'save_submission', expectedSubmissionRevision: 0, contextBeatId: snapshot.activeBeat!.id, expectedInputEpoch: snapshot.session.inputEpoch, kind: 'say', text, recipientNpcIds: [snapshot.npcs[0]!.id] }, players[playerIndex]);
    snapshot = (await request(`/api/sessions/${sessionId}`, host)).json();
    await beat('plan_beat', { submissionIds: snapshot.submissions.filter((s) => s.status === 'queued').map((s) => s.id) });
    await beat('approve_stakes', { classification: 'ordinary', contracts: [] });
    await beat('lock_beat');
    await beat('render_beat');
    await beat('approve_continuity', { updates: snapshot.activeBeat!.draft!.continuity });
    await beat('publish_beat', { expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat!.draftRevision, textOnly: true });
  }

  beforeAll(async () => {
    app = await buildApp(options);
    const auth = await request('/api/auth/host', '', { token: hostToken });
    host = cookie(auth);
    const creation = await request('/api/sessions', host, { commandId: crypto.randomUUID() });
    expect(creation.statusCode, creation.body).toBe(200);
    const created = creation.json();
    sessionId = created.sessionId;
    players = [];
    for (const invite of created.invites) {
      const redemption = await request('/api/auth/redeem', '', { token: invite.token });
      expect(redemption.statusCode).toBe(200);
      if (invite.role === 'player') players.push(cookie(redemption)); else stage = cookie(redemption);
      expect((await request('/api/auth/redeem', '', { token: invite.token })).statusCode).toBe(401);
    }
    snapshot = (await request(`/api/sessions/${sessionId}`, host)).json();
  });
  afterAll(async () => { await app?.close(); });

  it('creates four isolated seats and a read-only stage with allowlisted data', async () => {
    expect(players).toHaveLength(4);
    expect(snapshot.characterDetails).toHaveLength(4);
    const player = (await request(`/api/sessions/${sessionId}`, players[0]!)).json();
    expect(player.ownCharacter.secret).toBeTruthy();
    for (const other of snapshot.characterDetails.slice(1)) expect(JSON.stringify(player)).not.toContain(other.secret);
    const publicState = (await request(`/api/sessions/${sessionId}?view=stage`, host)).json();
    expect(publicState.role).toBe('stage');
    expect(publicState).not.toHaveProperty('npcDetails');
    expect(publicState).not.toHaveProperty('submissions');
    expect(JSON.stringify(publicState)).not.toContain(snapshot.npcDetails[0]!.secrets[0]);
    expect((await request(`/api/sessions/${sessionId}/commands`, stage, { commandId: crypto.randomUUID(), type: 'open_beat', kind: 'action', expectedInputEpoch: 0 })).statusCode).toBe(403);
  });

  it('publishes exact player lines, remembers two Mara exchanges and survives restart', async () => {
    const first = 'You knew the previous owner. What happened to him?';
    const second = 'Because someone just offered to sell it to us.';
    await publishConversation(first);
    await publishConversation(second, 1);
    expect(snapshot.history).toHaveLength(2);
    expect(snapshot.history[0]!.segments.find((s) => s.kind === 'player_dialogue')!.text).toBe(first);
    expect(snapshot.history[1]!.segments.find((s) => s.kind === 'npc_dialogue')!.text).toContain('paperwork');
    const before = snapshot.npcDetails[0]!;
    expect(before.knowledge.some((item) => item.statement.includes('sale'))).toBe(true);
    expect(snapshot.session.actionRoundNumber).toBe(0);
    expect(diceCalls).toBe(0);
    await app.close();
    app = await buildApp(options);
    snapshot = (await request(`/api/sessions/${sessionId}`, host)).json();
    expect(snapshot.npcDetails[0]).toEqual(before);
    expect(snapshot.history).toHaveLength(2);
  });

  it('accepts four independent inputs and rolls/publishes exactly once under duplicate commands', async () => {
    await command({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    await Promise.all(players.map((credential, i) => command({ type: 'save_submission', expectedSubmissionRevision: 0, contextBeatId: snapshot.activeBeat!.id, expectedInputEpoch: snapshot.session.inputEpoch, kind: 'act', text: '', intent: `Open archive mechanism ${i}`, approach: 'Careful investigation' }, credential)));
    snapshot = (await request(`/api/sessions/${sessionId}`, host)).json();
    await beat('plan_beat', { submissionIds: snapshot.submissions.filter((s) => s.status === 'queued').map((s) => s.id) });
    await beat('approve_stakes', { classification: 'action', contracts: snapshot.activeBeat!.contracts });
    const lock = { commandId: crypto.randomUUID(), type: 'lock_beat', beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision };
    const responses = await Promise.all([request(`/api/sessions/${sessionId}/commands`, host, lock), request(`/api/sessions/${sessionId}/commands`, host, lock)]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    snapshot = responses[0]!.json().snapshot;
    expect(diceCalls).toBe(8);
    const fixedRolls = snapshot.activeBeat!.resolution!.rolls;
    await beat('render_beat');
    await beat('render_beat');
    expect(snapshot.activeBeat!.resolution!.rolls).toEqual(fixedRolls);
    expect(diceCalls).toBe(8);
    const publication = { commandId: crypto.randomUUID(), type: 'publish_beat', beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat!.draftRevision, textOnly: true };
    const commits = await Promise.all([request(`/api/sessions/${sessionId}/commands`, host, publication), request(`/api/sessions/${sessionId}/commands`, host, publication)]);
    expect(commits.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(commits[0]!.json()).toEqual(commits[1]!.json());
    snapshot = commits[0]!.json().snapshot;
    expect(snapshot.session.actionRoundNumber).toBe(1);
    expect(snapshot.history).toHaveLength(3);
    const reused = await request(`/api/sessions/${sessionId}/commands`, host, { ...publication, textOnly: false });
    expect(reused.statusCode).toBeGreaterThanOrEqual(400);
  });
});
