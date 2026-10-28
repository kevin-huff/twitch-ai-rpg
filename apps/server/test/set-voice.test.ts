import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Command, DirectorSnapshot, PlayerSnapshot, SessionSnapshot } from '@rpg/contracts';
import { buildApp } from '../src/app';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://localhost:3000';
const hostToken = 'set-voice-test-host-credential';
const suite = databaseUrl ? describe : describe.skip;
const unlisted = 'That voice is not on the voice list. Pick another.';

suite('players choosing their own voice', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let host: string;
  const options = { databaseUrl: databaseUrl!, hostToken, origin, rollDie: () => 4 };
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
    return {
      sessionId, players, stage,
      get snapshot() { return snapshot; },
      send,
      beat: (type: string, extras: Record<string, unknown> = {}, expected = 200) =>
        send({ type, beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, ...extras }, host, expected),
      async refresh() { snapshot = (await request(`/api/sessions/${sessionId}`, host)).json(); },
      ownSeat: async (player: number) => ((await request(`/api/sessions/${sessionId}`, players[player]!)).json() as PlayerSnapshot).ownCharacter!,
      async openAction() { await send({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch }); },
      say: (player: number, text: string, expected = 200) =>
        send({ type: 'save_submission', expectedSubmissionRevision: 0, contextBeatId: snapshot.activeBeat!.id, expectedInputEpoch: snapshot.session.inputEpoch, kind: 'say', text, recipientNpcIds: [] }, players[player], expected),
      act: (player: number, intent: string, approach: string, expected = 200) =>
        send({ type: 'save_submission', expectedSubmissionRevision: 0, contextBeatId: snapshot.activeBeat!.id, expectedInputEpoch: snapshot.session.inputEpoch, kind: 'act', text: '', intent, approach }, players[player], expected),
    };
  }

  beforeAll(async () => {
    app = await buildApp(options);
    const auth = await request('/api/auth/host', '', { token: hostToken });
    host = cookie(auth);
  });
  afterAll(async () => { await app?.close(); });

  it('lets a player set and reset their voice without changing any revision, in the lobby', async () => {
    const table = await newTable();
    expect(table.snapshot.session.status).toBe('lobby');
    const before = await table.ownSeat(0);
    expect(before.voiceProfileId).toBeNull();
    const stateRevision = table.snapshot.session.stateRevision;

    const set = await table.send({ type: 'set_voice', voiceProfileId: 'eleven:fake-ada' }, table.players[0]);
    const own = (set.json().snapshot as PlayerSnapshot).ownCharacter!;
    expect(own.voiceProfileId).toBe('eleven:fake-ada');
    expect(own.cardRevision).toBe(before.cardRevision);
    await table.refresh();
    expect(table.snapshot.session.stateRevision).toBe(stateRevision);
    expect(table.snapshot.characterDetails.find((character) => character.id === own.id)!.voiceProfileId).toBe('eleven:fake-ada');
    expect(table.snapshot.characterDetails.find((character) => character.id === own.id)!.cardRevision).toBe(before.cardRevision);

    const reset = await table.send({ type: 'set_voice', voiceProfileId: null }, table.players[0]);
    expect((reset.json().snapshot as PlayerSnapshot).ownCharacter!.voiceProfileId).toBeNull();
    await table.refresh();
    expect(table.snapshot.session.stateRevision).toBe(stateRevision);
  });

  it('only changes the speaking player\'s own character', async () => {
    const table = await newTable();
    await table.send({ type: 'set_voice', voiceProfileId: 'eleven:fake-bram' }, table.players[1]);
    expect((await table.ownSeat(0)).voiceProfileId).toBeNull();
    expect((await table.ownSeat(1)).voiceProfileId).toBe('eleven:fake-bram');
  });

  it('refuses a voice that is not on the list', async () => {
    const table = await newTable();
    const refused = await table.send({ type: 'set_voice', voiceProfileId: 'eleven:not-listed' }, table.players[0], 409);
    expect(refused.json().message).toBe(unlisted);
    expect((await table.ownSeat(0)).voiceProfileId).toBeNull();
  });

  it('refuses the director and the stage view', async () => {
    const table = await newTable();
    await table.send({ type: 'set_voice', voiceProfileId: 'eleven:fake-ada' }, host, 403);
    await table.send({ type: 'set_voice', voiceProfileId: 'eleven:fake-ada' }, table.stage, 403);
  });

  it('works while the show is live and paused, and is refused after it ends', async () => {
    const table = await newTable();
    await table.openAction();
    expect(table.snapshot.session.status).toBe('live');
    await table.send({ type: 'set_voice', voiceProfileId: 'eleven:fake-cyd' }, table.players[0]);
    await table.refresh();
    await table.send({ type: 'set_status', status: 'paused', expectedStateRevision: table.snapshot.session.stateRevision });
    await table.refresh();
    expect(table.snapshot.session.status).toBe('paused');
    const revision = table.snapshot.session.stateRevision;
    await table.send({ type: 'set_voice', voiceProfileId: 'eleven:fake-ada' }, table.players[0]);
    expect((await table.ownSeat(0)).voiceProfileId).toBe('eleven:fake-ada');
    await table.refresh();
    expect(table.snapshot.session.stateRevision).toBe(revision);
    await table.beat('abort_beat', { reason: 'Closing the table.' }).catch(() => undefined);
    await table.refresh();
    await table.send({ type: 'set_status', status: 'ended', expectedStateRevision: table.snapshot.session.stateRevision });
    const refused = await table.send({ type: 'set_voice', voiceProfileId: null }, table.players[0], 409);
    expect(refused.json().message).toBe('This session has ended.');
  });

  it('refuses a line that holds only tags and accepts one with words', async () => {
    const table = await newTable();
    await table.openAction();
    const sayRefused = await table.say(0, '[laughs]', 400);
    expect(sayRefused.json().message).toBe('Write some words as well as the tags.');
    const doRefused = await table.act(0, '[sighs]', '[softly]', 400);
    expect(doRefused.json().message).toBe('Write some words as well as the tags.');
    await table.say(0, '[laughs] Fine, you win.');
    await table.refresh();
    expect(table.snapshot.submissions.filter((line) => line.status === 'queued')).toHaveLength(1);
  });

  it('drops a voice copy whose words differ and keeps one that matches', async () => {
    const table = await newTable();
    await table.openAction();
    await table.say(0, 'Hold the door.');
    await table.refresh();
    await table.beat('plan_beat', { submissionIds: table.snapshot.submissions.filter((line) => line.status === 'queued').map((line) => line.id) });
    await table.beat('approve_stakes', { classification: table.snapshot.activeBeat!.classification, contracts: table.snapshot.activeBeat!.contracts });
    await table.beat('lock_beat');
    await table.beat('render_beat');
    const segment = (text: string, voiceText?: string) => ({ kind: 'narration', text, recipientCharacterIds: [], delivery: 'neutral', ...(voiceText === undefined ? {} : { voiceText }) });
    await table.beat('edit_script', { segments: [segment('The door creaks open.', '[whispers] The door creaks shut.'), segment('A cold wind follows.', '[softly] A cold wind follows.')] });
    const [mismatched, matching] = table.snapshot.activeBeat!.draft!.segments;
    expect(mismatched!.voiceText).toBeUndefined();
    expect(matching!.voiceText).toBe('[softly] A cold wind follows.');
  });
});
