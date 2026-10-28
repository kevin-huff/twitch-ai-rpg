import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  LineAssistInputSchema, type AiProvider, type CharacterCardDefinition, type DirectorSnapshot, type LineAssistInput, type ScenarioDefinition,
} from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeAiProvider } from '../src/fake-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const FAILED = 'The AI could not help this time. Your words are unchanged.';
const SENTINELS = {
  npcSecret: 'SENTINEL-NPC-SECRET', hiddenIdentity: 'SENTINEL-HIDDEN-IDENTITY', npcMotivation: 'SENTINEL-NPC-MOTIVATION',
  npcGoal: 'SENTINEL-NPC-GOAL', npcKnowledge: 'SENTINEL-NPC-KNOWLEDGE', directorNotes: 'SENTINEL-DIRECTOR-NOTES',
  otherSecret: 'SENTINEL-OTHER-SECRET', otherBackstory: 'SENTINEL-OTHER-BACKSTORY', otherSpecialty: 'SENTINEL-OTHER-SPECIALTY',
  directorFact: 'SENTINEL-DIRECTOR-FACT', hiddenTrack: 'SENTINEL-HIDDEN-TRACK', voiceText: 'SENTINEL-VOICE-TEXT',
};
const OWN_SECRET = 'I still carry the key to the archive.';
const OWN_BACKSTORY = 'Raised above the club by the owner.';

interface Show { sessionId: string; players: string[]; stage: string; director(): Promise<DirectorSnapshot>; send(payload: Record<string, unknown>, credential?: string, expected?: number): Promise<DirectorSnapshot> }

suite('player line assist', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let host: string;
  let starter: { scenario: ScenarioDefinition; characters: CharacterCardDefinition[] };
  const provider = new FakeAiProvider() as FakeAiProvider & AiProvider;
  const suggestLine = vi.fn<(input: LineAssistInput) => Promise<{ text: string }>>();
  const hostToken = `line-assist-test-${randomUUID()}`;

  const cookieOf = (headers: Record<string, unknown>) => {
    const values = headers['set-cookie'];
    return String(Array.isArray(values) ? values[0] : values).split(';')[0]!;
  };
  const request = (url: string, credential: string, payload?: unknown) => app.inject({
    method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, cookie: credential }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  const assist = (show: Show, credential: string, payload: Record<string, unknown> = { idea: 'tell her we mean no harm' }) =>
    request(`/api/sessions/${show.sessionId}/line-assist`, credential, payload);

  async function newShow(start: boolean): Promise<Show> {
    const scenario: ScenarioDefinition = {
      ...starter.scenario,
      directorNotes: SENTINELS.directorNotes,
      npcs: starter.scenario.npcs.map((npc, index) => ({
        ...npc, secrets: [`${SENTINELS.npcSecret}-${index}`], hiddenIdentity: `${SENTINELS.hiddenIdentity}-${index}`,
        motivation: SENTINELS.npcMotivation, goal: SENTINELS.npcGoal, knowledge: [{ statement: SENTINELS.npcKnowledge, category: 'fact' }],
      })),
      tracks: [...starter.scenario.tracks, { id: 'hidden-track', label: SENTINELS.hiddenTrack, kind: 'danger', current: 0, max: 4, visibility: 'director', trigger: null, enabled: true, completionText: '', completionEffects: [] }],
      facts: [...starter.scenario.facts, { id: 'hidden-fact', text: SENTINELS.directorFact, visibility: 'director' }],
    };
    const characters: CharacterCardDefinition[] = [
      { ...starter.characters[0]!, secret: OWN_SECRET, backstory: OWN_BACKSTORY },
      { ...starter.characters[1]!, secret: SENTINELS.otherSecret, backstory: SENTINELS.otherBackstory, specialty: SENTINELS.otherSpecialty },
    ];
    const saved = await request('/api/library/scenarios', host, { commandId: randomUUID(), expectedVersion: 0, definition: scenario });
    expect(saved.statusCode, saved.body).toBe(200);
    const refs = [];
    for (const definition of characters) {
      const template = await request('/api/library/characters', host, { commandId: randomUUID(), expectedVersion: 0, definition });
      expect(template.statusCode, template.body).toBe(200);
      refs.push({ templateId: template.json().id, version: template.json().version });
    }
    const created = await request('/api/sessions', host, { commandId: randomUUID(), scenario: { templateId: saved.json().id, version: saved.json().version }, characters: refs });
    expect(created.statusCode, created.body).toBe(200);
    const sessionId = created.json().sessionId as string;
    const players: string[] = [];
    let stage = '';
    for (const invite of created.json().invites as Array<{ role: string; token: string }>) {
      const redeemed = await request('/api/auth/redeem', '', { token: invite.token });
      expect(redeemed.statusCode, redeemed.body).toBe(200);
      if (invite.role === 'player') players.push(cookieOf(redeemed.headers)); else stage = cookieOf(redeemed.headers);
    }
    const director = async () => (await request(`/api/sessions/${sessionId}`, host)).json() as DirectorSnapshot;
    const send = async (payload: Record<string, unknown>, credential = host, expected = 200) => {
      const result = await request(`/api/sessions/${sessionId}/commands`, credential, { commandId: randomUUID(), ...payload });
      expect(result.statusCode, result.body).toBe(expected);
      return director();
    };
    const show = { sessionId, players, stage, director, send };
    if (start) await send({ type: 'start_session', expectedStateRevision: (await director()).session.stateRevision, overrideUnreadyReason: 'Testing the line helper.' });
    return show;
  }
  const npcId = async (show: Show, name: string) => (await show.director()).npcs.find(npc => npc.displayName === name)!.id;

  async function publishRound(show: Show) {
    let snapshot = await show.send({ type: 'open_beat', kind: 'action', expectedInputEpoch: (await show.director()).session.inputEpoch });
    await show.send({ type: 'save_submission', expectedSubmissionRevision: 0, contextBeatId: snapshot.activeBeat!.id, expectedInputEpoch: snapshot.session.inputEpoch, kind: 'say', text: 'We only want the ledger back.', recipientNpcIds: [] }, show.players[1]);
    snapshot = await show.director();
    const beat = (type: string, extras: Record<string, unknown> = {}) => show.send({ type, beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, ...extras }).then(next => { snapshot = next; });
    await beat('plan_beat', { submissionIds: snapshot.submissions.filter(item => item.status === 'queued').map(item => item.id) });
    await beat('approve_stakes', { classification: 'action', contracts: snapshot.activeBeat!.contracts });
    await beat('lock_beat');
    await beat('render_beat');
    await beat('approve_continuity', { updates: snapshot.activeBeat!.draft!.continuity });
    await beat('publish_beat', { expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat!.draftRevision, textOnly: true });
    await pool.query("UPDATE published_beats SET data=jsonb_set(data,'{segments,0,voiceText}',to_jsonb($2::text)) WHERE session_id=$1", [show.sessionId, `[softly] ${SENTINELS.voiceText}`]);
  }

  beforeAll(async () => {
    (provider as AiProvider).suggestLine = suggestLine;
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, provider, providerTimeoutMs: 2000, serveStatic: false, rollDie: () => 4 });
    const signedIn = await request('/api/auth/host', '', { token: hostToken });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    host = cookieOf(signedIn.headers);
    starter = (await request('/api/library/starter', host)).json();
  });
  beforeEach(() => {
    (provider as AiProvider).suggestLine = suggestLine;
    suggestLine.mockReset().mockImplementation(async input => ({ text: `[warmly] ${input.idea} That is what I mean.` }));
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  it('refuses everyone but a seated player, and refuses before the show starts or after it ends', async () => {
    const show = await newShow(false);
    expect((await assist(show, '')).statusCode).toBe(401);
    for (const credential of [host, show.stage]) {
      const refused = await assist(show, credential);
      expect(refused.statusCode, refused.body).toBe(403);
    }
    const early = await assist(show, show.players[0]!);
    expect(early.statusCode, early.body).toBe(409);
    expect(early.json().message).toBe('Start the session before joining in-character play.');
    const other = await newShow(true);
    expect((await assist(other, show.players[0]!)).statusCode).toBe(404);
    await other.send({ type: 'set_status', status: 'ended', expectedStateRevision: (await other.director()).session.stateRevision });
    const ended = await assist(other, other.players[0]!);
    expect(ended.statusCode, ended.body).toBe(409);
    expect(ended.json().message).toBe('This session has ended.');
    expect((await assist(other, other.players[0]!, { idea: '   ' })).statusCode).toBe(400);
    expect(suggestLine).not.toHaveBeenCalled();
  });

  it('builds the AI input only from what the player can see', async () => {
    const show = await newShow(true);
    await publishRound(show);
    const mara = await npcId(show, 'Mara Vale');
    const response = await assist(show, show.players[0]!, { idea: '  tell her we mean no harm ', recipientNpcIds: [mara] });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ text: '[warmly] tell her we mean no harm That is what I mean.' });
    expect(suggestLine).toHaveBeenCalledTimes(1);
    const input = suggestLine.mock.calls[0]![0];
    expect(LineAssistInputSchema.parse(input)).toEqual(input);
    const snapshot = await show.director();
    const [own, other] = snapshot.characters;
    expect(input.idea).toBe('tell her we mean no harm');
    expect(input.character).toMatchObject({ displayName: own!.displayName, secret: OWN_SECRET, backstory: OWN_BACKSTORY, possessions: starter.characters[0]!.possessions });
    expect(input.talkingTo).toEqual([expect.objectContaining({ displayName: 'Mara Vale', role: 'Bartender', mood: 'wary' })]);
    expect(input.present.npcs).toEqual([{ displayName: 'Inspector Dax', role: 'Visiting official' }]);
    expect(input.present.characters).toEqual([{ displayName: other!.displayName, appearance: other!.appearance }]);
    expect(input.scene).toEqual({ title: snapshot.session.scene.title, description: snapshot.session.scene.description });
    expect(input.story).toEqual({ premise: starter.scenario.premise, genre: starter.scenario.genre, tone: starter.scenario.tone });
    expect(input.facts).toEqual(starter.scenario.facts.map(fact => fact.text));
    expect(input.boundaries).toEqual(starter.scenario.boundaries);
    expect(input.recentRounds).toHaveLength(1);
    expect(input.recentRounds[0]!.beatNumber).toBe(snapshot.history[0]!.beatNumber);
    expect(input.recentRounds[0]!.lines).toContainEqual({ speaker: other!.displayName, text: 'We only want the ledger back.' });
    const text = JSON.stringify(input);
    for (const sentinel of Object.values(SENTINELS)) expect(text).not.toContain(sentinel);
  });

  it('refuses a recipient the player cannot reach', async () => {
    const show = await newShow(true);
    for (const recipient of [await npcId(show, 'Biscuit'), 'no-such-npc']) {
      const refused = await assist(show, show.players[0]!, { idea: 'Good dog.', recipientNpcIds: [recipient] });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().message).toBe('The addressed NPC is unavailable.');
    }
    expect(suggestLine).not.toHaveBeenCalled();
  });

  it('writes one suggestion at a time for a seat', async () => {
    const show = await newShow(true);
    let release!: () => void;
    suggestLine.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ text: 'We mean no harm.' }); }));
    const first = assist(show, show.players[0]!);
    await vi.waitFor(() => expect(suggestLine).toHaveBeenCalledTimes(1));
    const second = await assist(show, show.players[0]!);
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json().message).toBe('Already writing a suggestion.');
    const neighbour = await assist(show, show.players[1]!);
    expect(neighbour.statusCode, neighbour.body).toBe(200);
    release();
    expect((await first).json()).toEqual({ text: 'We mean no harm.' });
    expect((await assist(show, show.players[0]!)).statusCode).toBe(200);
  });

  it('gives the pinned message when the AI fails or replies with no words', async () => {
    const show = await newShow(true);
    const replies: Array<() => Promise<unknown>> = [
      async () => { throw new Error('upstream exploded'); },
      async () => ({ text: '[sighs] [pauses]' }),
      async () => ({ text: '   ' }),
      async () => ({ words: 'wrong shape' }),
      () => new Promise(() => {}),
    ];
    for (const reply of replies) {
      suggestLine.mockImplementationOnce(reply as () => Promise<{ text: string }>);
      const failed = await assist(show, show.players[0]!);
      expect(failed.statusCode, failed.body).toBe(502);
      expect(failed.json().message).toBe(FAILED);
    }
    (provider as AiProvider).suggestLine = undefined;
    const missing = await assist(show, show.players[0]!);
    expect(missing.statusCode, missing.body).toBe(503);
  });
});
