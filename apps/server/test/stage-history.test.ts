import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Command, DirectorSnapshot, SessionSnapshot } from '@rpg/contracts';
import { buildApp } from '../src/app';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://localhost:3000';
const hostToken = 'stage-history-test-host-credential';
const suite = databaseUrl ? describe : describe.skip;

suite('stage snapshots carry only the newest beat', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let host: string;
  let sessionId: string;
  let players: string[];
  let stage: string;
  let snapshot: DirectorSnapshot;
  const options = { databaseUrl: databaseUrl!, hostToken, origin, rollDie: () => 4 };
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
    host = cookie(await request('/api/auth/host', '', { token: hostToken }));
    const creation = await request('/api/sessions', host, { commandId: crypto.randomUUID() });
    expect(creation.statusCode, creation.body).toBe(200);
    const created = creation.json();
    sessionId = created.sessionId;
    players = [];
    for (const invite of created.invites) {
      const redemption = await request('/api/auth/redeem', '', { token: invite.token });
      if (invite.role === 'player') players.push(cookie(redemption)); else stage = cookie(redemption);
    }
    snapshot = (await request(`/api/sessions/${sessionId}`, host)).json();
  });
  afterAll(async () => { await app?.close(); });

  it('sends an empty history to the stage when nothing is published', async () => {
    expect((await request(`/api/sessions/${sessionId}?view=stage`, host)).json().history).toEqual([]);
    expect((await request(`/api/sessions/${sessionId}?view=stage`, stage)).json().history).toEqual([]);
  });

  it('sends the stage only the newest beat while director and player keep all three', async () => {
    await publishConversation('First line for the table.');
    await publishConversation('Second line for the table.', 1);
    await publishConversation('Third line for the table.', 2);
    const director = (await request(`/api/sessions/${sessionId}`, host)).json() as DirectorSnapshot;
    expect(director.history).toHaveLength(3);
    const newest = director.history[2]!;
    for (const credential of [host, stage]) {
      const view = (await request(`/api/sessions/${sessionId}?view=stage`, credential)).json();
      expect(view.role).toBe('stage');
      expect(view.history).toHaveLength(1);
      expect(view.history[0]).toEqual(newest);
    }
    for (const credential of players) {
      expect((await request(`/api/sessions/${sessionId}`, credential)).json().history).toHaveLength(3);
    }
  });
});
