import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderContext } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { FakeAiProvider } from '../src/fake-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const ada = 'eleven:fake-ada';
const bram = 'eleven:fake-bram';
const cyd = 'eleven:fake-cyd';
const audio = () => ({ bytes: new Uint8Array([73, 68, 51, 1]), contentType: 'audio/mpeg' });

// Adds hidden voice copies to the storyteller's lines when asked to.
class TaggedProvider extends FakeAiProvider {
  tagged = false;
  async render(context: ProviderContext) {
    const draft = await super.render(context);
    if (!this.tagged) return draft;
    return { ...draft, segments: draft.segments.map(segment => segment.kind === 'narration' ? { ...segment, voiceText: `[hushed] ${segment.text}` }
      : segment.kind === 'npc_dialogue' ? { ...segment, voiceText: `[curious] ${segment.text}` } : segment) };
  }
}

suite('voices on prepared and published speech', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let directory: string;
  let host: string;
  let stage: string;
  let player: string;
  let sessionId: string;
  let snapshot: any;
  let bramId: string;
  let provider: TaggedProvider;
  const synthesize = vi.fn(async (_input: { text: string; voiceProfileId: string }) => audio());
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (path: string, payload?: object, credential = host) => app.inject({ method: payload === undefined ? 'GET' : 'POST', url: path, headers: { origin, cookie: credential }, ...(payload === undefined ? {} : { payload }) });
  const refresh = async () => { snapshot = (await request(`/api/sessions/${sessionId}`)).json(); };
  async function command(type: string, fields: Record<string, unknown> = {}, credential = host) {
    const response = await request(`/api/sessions/${sessionId}/commands`, { commandId: randomUUID(), type, ...fields }, credential);
    expect(response.statusCode, response.body).toBe(200);
    if (credential === host) snapshot = response.json().snapshot;
    return response;
  }
  const beat = (type: string, fields: Record<string, unknown> = {}) => command(type, { beatId: snapshot.activeBeat.id, expectedBeatRevision: snapshot.activeBeat.revision, ...fields });
  const setVoice = (voiceProfileId: string | null) => command('set_voice', { voiceProfileId }, player);
  const draftPath = () => `/api/sessions/${sessionId}/beats/${snapshot.activeBeat.id}/draft-audio`;
  async function prepare() {
    const result = await request(draftPath(), { commandId: randomUUID(), expectedBeatRevision: snapshot.activeBeat.revision, draftRevision: snapshot.activeBeat.draftRevision, generation: snapshot.activeBeat.generation });
    expect(result.statusCode, result.body).toBe(200);
    const body = result.json();
    expect(body.status).toBe('ready');
    return body.manifest as { preparationId: string; segments: { index: number; text: string; speaker: string; voiceProfileId: string }[] };
  }
  const publish = (preparationId?: string) => beat('publish_beat', { expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat.draftRevision, textOnly: !preparationId, ...(preparationId ? { audioPreparationId: preparationId } : {}) });
  // Opens an action round, saves the player's lines, and runs it through to the saved draft.
  async function round(lines: { say?: string; act?: boolean; recipients?: string[] }) {
    await command('open_beat', { kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    const save = async (fields: Record<string, unknown>) => {
      await command('save_submission', { expectedSubmissionRevision: 0, contextBeatId: snapshot.activeBeat.id, expectedInputEpoch: snapshot.session.inputEpoch, ...fields }, player);
    };
    if (lines.act) await save({ kind: 'act', text: '', intent: 'Open the archive mechanism', approach: 'Careful investigation' });
    if (lines.say) await save({ kind: 'say', text: lines.say, recipientNpcIds: lines.recipients ?? [] });
    await refresh();
    await beat('plan_beat', { submissionIds: snapshot.submissions.filter((submission: any) => submission.status === 'queued').map((submission: any) => submission.id) });
    await beat('approve_stakes', { classification: 'action', contracts: snapshot.activeBeat.contracts });
    await beat('lock_beat');
    await beat('render_beat');
  }
  const calls = () => synthesize.mock.calls.map(call => call[0]);
  const publishedSegments = () => snapshot.history.at(-1).segments.filter((segment: any) => segment.kind !== 'system');
  const characterName = () => snapshot.characters.find((character: any) => character.id === snapshot.activeBeat?.lockedSubmissions?.[0]?.characterId)?.displayName as string;
  async function preparedAssets(preparationId: string) {
    return (await pool.query('SELECT segments FROM draft_audio_preparations WHERE id=$1', [preparationId])).rows[0].segments as { kind: string; voiceProfileId: string; assetId: string }[];
  }

  beforeEach(async () => {
    synthesize.mockReset(); synthesize.mockImplementation(async () => audio());
    directory = await mkdtemp(join(tmpdir(), 'rpg-voiced-speech-'));
    const hostToken = `voiced-speech-host-${randomUUID()}`;
    pool = createPool(databaseUrl!);
    provider = new TaggedProvider();
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, provider, rollDie: () => 4, speech: { synthesize }, speechModel: 'voiced-test-model', speechVoiceId: 'voiced-test-narrator', assetDir: directory });
    host = cookie(await request('/api/auth/host', { token: hostToken }, ''));
    const creation = (await request('/api/sessions', { commandId: randomUUID() })).json();
    sessionId = creation.sessionId;
    for (const role of ['stage', 'player']) {
      const credential = cookie(await request('/api/auth/redeem', { token: creation.invites.find((invite: any) => invite.role === role).token }, ''));
      if (role === 'stage') stage = credential; else player = credential;
    }
    await refresh();
    // A character with its own voice, saved before any round opens (saving discards queued lines).
    await pool.query("UPDATE sessions SET status='live' WHERE id=$1", [sessionId]);
    await refresh();
    const { id: _id, version: _version, knowledge: _knowledge, relationships: _relationships, ...profile } = snapshot.npcDetails[0];
    await command('save_npc', { expectedStateRevision: snapshot.session.stateRevision, reason: 'Give a character a voice', discardQueuedInput: true, expectedNpcVersion: 0, profile: { ...profile, displayName: 'Bram Voss', voiceProfileId: bram } });
    bramId = snapshot.npcs.find((npc: any) => npc.displayName === 'Bram Voss').id;
    expect(snapshot.npcDetails.find((npc: any) => npc.id === bramId).voiceProfileId).toBe(bram);
  });
  afterEach(async () => { await app?.close(); await pool?.end(); await rm(directory, { recursive: true, force: true }); });

  it('reads each kind of line in its own voice and publishes segments that match the recording one to one', async () => {
    await setVoice(ada);
    await round({ act: true, say: 'Stay here, I will be right back.', recipients: [bramId] });
    const name = characterName();
    const manifest = await prepare();
    const voices = manifest.segments.map(segment => segment.voiceProfileId);
    expect(voices).toEqual(['voice_narrator', ada, 'voice_narrator', bram]);
    expect(calls()).toHaveLength(4);
    const doText = manifest.segments[0]!.text;
    expect(calls()[0]).toEqual({ text: `${name}: ${doText}`, voiceProfileId: 'voice_narrator' });
    expect(calls()[1]).toEqual({ text: 'Stay here, I will be right back.', voiceProfileId: ada });
    expect(calls()[2]).toEqual({ text: manifest.segments[2]!.text, voiceProfileId: 'voice_narrator' });
    expect(calls()[3]).toEqual({ text: manifest.segments[3]!.text, voiceProfileId: bram });
    expect(manifest.segments[3]!.speaker).toBe('Bram Voss');

    await publish(manifest.preparationId);
    const segments = publishedSegments();
    expect(segments.map((segment: any) => segment.kind)).toEqual(['player_action', 'player_dialogue', 'narration', 'npc_dialogue']);
    const publication = snapshot.history.at(-1);
    expect(publication.textOnly).toBe(false);
    const recorded = (await request(`/api/sessions/${sessionId}/audio/${publication.id}`, undefined, stage)).json();
    expect(recorded.status).toBe('ready');
    expect(recorded.manifest.segments.map((segment: any) => segment.id)).toEqual(segments.map((segment: any) => segment.id));
    expect(recorded.manifest.segments.map((segment: any) => segment.voiceProfileId)).toEqual(voices);
    expect(segments[1].voiceProfileId).toBe(ada);
    expect(segments[0].voiceProfileId).toBeNull();
    expect(segments[3].voiceProfileId).toBe(bram);
    expect(calls()).toHaveLength(4);
  });

  it('reads a Say line without a chosen voice as the narrator with the name in front', async () => {
    await round({ say: 'Nobody gave me a voice.' });
    const name = characterName();
    const manifest = await prepare();
    expect(calls()[0]).toEqual({ text: `${name}: Nobody gave me a voice.`, voiceProfileId: 'voice_narrator' });
    expect(manifest.segments[0]!.voiceProfileId).toBe('voice_narrator');
    await publish(manifest.preparationId);
    expect(publishedSegments()[0].voiceProfileId).toBeNull();
  });

  it('keeps publishing with the prepared recording after the voice changes, and uses the new voice from the next preparation', async () => {
    await setVoice(ada);
    await round({ say: 'The same words in any voice.' });
    const first = await prepare();
    expect(calls()).toHaveLength(3);
    await setVoice(cyd);
    await publish(first.preparationId);
    const publication = snapshot.history.at(-1);
    expect(publication.textOnly).toBe(false);
    expect(publishedSegments().find((segment: any) => segment.kind === 'player_dialogue').voiceProfileId).toBe(ada);
    const recorded = (await request(`/api/sessions/${sessionId}/audio/${publication.id}`, undefined, stage)).json();
    expect(recorded.status).toBe('ready');
    expect(recorded.manifest.segments.map((segment: any) => segment.id)).toEqual(publishedSegments().map((segment: any) => segment.id));
    expect(calls()).toHaveLength(3);

    await round({ say: 'The same words in any voice.' });
    const second = await prepare();
    const sayCalls = calls().filter(call => call.text === 'The same words in any voice.');
    expect(sayCalls.map(call => call.voiceProfileId)).toEqual([ada, cyd]);
    expect(second.segments[0]!.voiceProfileId).toBe(cyd);

    const firstAssets = await preparedAssets(first.preparationId);
    const secondAssets = await preparedAssets(second.preparationId);
    const firstSay = firstAssets.find(line => line.kind === 'player_dialogue')!;
    const secondSay = secondAssets.find(line => line.kind === 'player_dialogue')!;
    expect(firstSay.voiceProfileId).toBe(ada);
    expect(secondSay.voiceProfileId).toBe(cyd);
    expect(firstSay.assetId).toMatch(/^[a-f0-9]{64}$/);
    expect(secondSay.assetId).not.toBe(firstSay.assetId);
  });

  it('voices a tagged Say line with its tags while the published text stays plain', async () => {
    await setVoice(ada);
    await round({ say: '[laughs] Fine, I will do it.' });
    const manifest = await prepare();
    expect(calls()[0]).toEqual({ text: '[laughs] Fine, I will do it.', voiceProfileId: ada });
    expect(manifest.segments[0]!.text).toBe('Fine, I will do it.');
    await publish(manifest.preparationId);
    const say = publishedSegments()[0];
    expect(say.text).toBe('Fine, I will do it.');
    expect(publishedSegments().map((segment: any) => segment.text).join(' ')).not.toContain('[');
    const stored = (await pool.query('SELECT data FROM published_beats WHERE session_id=$1', [sessionId])).rows[0].data;
    expect(stored.segments.find((segment: any) => segment.kind === 'player_dialogue')).toMatchObject({ text: 'Fine, I will do it.', voiceText: '[laughs] Fine, I will do it.' });
    expect(JSON.stringify((await request(`/api/sessions/${sessionId}/audio/${snapshot.history.at(-1).id}`, undefined, stage)).json())).not.toContain('[laughs]');
  });

  it('keeps the tags in a tagged Say line when the narrator reads it with the name in front', async () => {
    await round({ say: '[laughs] Fine, I will do it.' });
    const name = characterName();
    await prepare();
    expect(calls()[0]).toEqual({ text: `${name}: [laughs] Fine, I will do it.`, voiceProfileId: 'voice_narrator' });
  });

  it('speaks the storyteller\'s hidden voice copy while the published text stays plain', async () => {
    provider.tagged = true;
    await round({ say: 'Tell me what you saw.', recipients: [bramId] });
    expect(snapshot.activeBeat.draft.segments.every((segment: any) => !/\[/.test(segment.text))).toBe(true);
    const manifest = await prepare();
    const narration = snapshot.activeBeat.draft.segments.find((segment: any) => segment.kind === 'narration');
    const dialogue = snapshot.activeBeat.draft.segments.find((segment: any) => segment.kind === 'npc_dialogue');
    expect(calls().map(call => call.text)).toEqual([expect.stringContaining('Tell me what you saw.'), `[hushed] ${narration.text}`, `[curious] ${dialogue.text}`]);
    expect(calls()[2]!.voiceProfileId).toBe(bram);
    expect(manifest.segments.map(segment => segment.text)).toEqual([expect.stringContaining('Tell me what you saw.'), narration.text, dialogue.text]);
    await publish(manifest.preparationId);
    expect(publishedSegments().map((segment: any) => segment.text).join(' ')).not.toContain('[');
    const stored = (await pool.query('SELECT data FROM published_beats WHERE session_id=$1', [sessionId])).rows[0].data;
    expect(stored.segments.find((segment: any) => segment.kind === 'narration').voiceText).toBe(`[hushed] ${narration.text}`);
  });

  it('turns a manual line\'s delivery into a leading tag, and drops the hidden copy of an edited line', async () => {
    provider.tagged = true;
    await round({ say: 'Tell me what you saw.' });
    await beat('edit_script', { segments: [
      { kind: 'narration', text: 'The room goes still.', delivery: 'quiet', recipientCharacterIds: [] },
      { kind: 'narration', text: 'Footsteps hurry closer.', delivery: 'urgent', recipientCharacterIds: [] },
      { kind: 'narration', text: 'Someone chuckles.', delivery: 'amused', recipientCharacterIds: [] },
      { kind: 'narration', text: 'Nothing special.', delivery: 'neutral', recipientCharacterIds: [] },
    ] });
    const manifest = await prepare();
    expect(calls().slice(1).map(call => call.text)).toEqual(['[quietly] The room goes still.', '[urgently] Footsteps hurry closer.', '[amused] Someone chuckles.', 'Nothing special.']);
    expect(manifest.segments.slice(1).map(segment => segment.text)).toEqual(['The room goes still.', 'Footsteps hurry closer.', 'Someone chuckles.', 'Nothing special.']);
    expect(calls().some(call => /hushed|curious/.test(call.text))).toBe(false);
    await publish(manifest.preparationId);
    expect(publishedSegments().map((segment: any) => segment.text).join(' ')).not.toContain('[');
  });

  it('gives the same words in two voices different recordings', async () => {
    await setVoice(ada);
    await round({ say: 'Meet me at the docks.' });
    const first = await prepare();
    await beat('abort_beat', { reason: 'Try the same line again in another voice.' });
    await setVoice(cyd);
    await round({ say: 'Meet me at the docks.' });
    const second = await prepare();
    const [firstSay, secondSay] = [(await preparedAssets(first.preparationId))[0]!, (await preparedAssets(second.preparationId))[0]!];
    expect(firstSay.voiceProfileId).toBe(ada);
    expect(secondSay.voiceProfileId).toBe(cyd);
    expect(secondSay.assetId).not.toBe(firstSay.assetId);
    const sayCalls = calls().filter(call => call.text === 'Meet me at the docks.');
    expect(sayCalls.map(call => call.voiceProfileId)).toEqual([ada, cyd]);
    const assets = await pool.query('SELECT id FROM audio_assets WHERE id=ANY($1)', [[firstSay.assetId, secondSay.assetId]]);
    expect(assets.rowCount).toBe(2);
  });
});
