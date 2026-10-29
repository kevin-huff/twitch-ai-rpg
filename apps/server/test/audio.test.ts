import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DELIVERY_TAGS, isSpokenSegmentKind } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { ProviderError } from '@rpg/providers';
import { createPool } from '../src/database';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite('SHOW-02/04 reviewed speech cache and authorization', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let directory: string;
  let host: string;
  let stage: string;
  let sessionId: string;
  let beatId: string;
  let draftId: string;
  const origin = 'http://localhost:3000';
  const fakeAudio = async (_input: { text: string; voiceProfileId: string }) => ({ bytes: new Uint8Array([73, 68, 51, 0]), contentType: 'audio/mpeg' });
  const synthesize = vi.fn(fakeAudio);
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0];
  const request = (url: string, credential = host, payload?: unknown) => app.inject({ method: payload ? 'POST' : 'GET', url, headers: { cookie: credential, origin }, ...(payload ? { payload } : {}) });
  let snapshot: any;
  async function command(type: string, extra = {}) {
    const result = await request(`/api/sessions/${sessionId}/commands`, host, { commandId: crypto.randomUUID(), type, ...extra });
    expect(result.statusCode, result.body).toBe(200);
    snapshot = result.json().snapshot;
  }
  async function beat(type: string, extra = {}) { await command(type, { beatId: snapshot.activeBeat.id, expectedBeatRevision: snapshot.activeBeat.revision, ...extra }); }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rpg-audio-'));
    const hostToken = 'audio-test-host-token-at-least-32-characters';
    app = await buildApp({ databaseUrl: process.env.TEST_DATABASE_URL!, origin, hostToken, speech: { synthesize }, speechModel: 'test-model', speechVoiceId: 'test-voice', assetDir: directory });
    host = cookie(await request('/api/auth/host', '', { token: hostToken }));
    const creation = (await request('/api/sessions', host, { commandId: crypto.randomUUID() })).json();
    sessionId = creation.sessionId;
    stage = cookie(await request('/api/auth/redeem', '', { token: creation.invites.find((invite: any) => invite.role === 'stage').token }));
    const player = cookie(await request('/api/auth/redeem', '', { token: creation.invites.find((invite: any) => invite.role === 'player').token }));
    await command('open_beat', { kind: 'conversation', expectedInputEpoch: 0 });
    beatId = snapshot.activeBeat.id;
    const saved = await request(`/api/sessions/${sessionId}/commands`, player, { commandId: crypto.randomUUID(), type: 'save_submission', contextBeatId: beatId, expectedInputEpoch: snapshot.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'say', text: 'My exact player words stay silent.', recipientNpcIds: [snapshot.npcs[0].id] });
    expect(saved.statusCode).toBe(200);
    await beat('plan_beat', { submissionIds: saved.json().snapshot.submissions.map((s: any) => s.id) });
    await beat('approve_stakes', { classification: 'ordinary', contracts: [] });
    await beat('lock_beat');
    await beat('render_beat');
    await beat('publish_beat', { expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat.draftRevision, textOnly: true });
    await command('open_beat', { kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    draftId = snapshot.activeBeat.id;
  });
  afterAll(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }); });

  it('rejects stage preparation and unpublished drafts before any paid request', async () => {
    expect((await request(`/api/sessions/${sessionId}/audio/${beatId}`, stage, { commandId: crypto.randomUUID() })).statusCode).toBe(403);
    expect((await request(`/api/sessions/${sessionId}/audio/${draftId}`, host, { commandId: crypto.randomUUID() })).statusCode).toBe(404);
    expect(synthesize).not.toHaveBeenCalled();
  });
  it('voices player lines with the name in front, never private text, and caches identical requests', async () => {
    const first = await request(`/api/sessions/${sessionId}/audio/${beatId}`, host, { commandId: crypto.randomUUID() });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().status).toBe('ready');
    expect(synthesize).toHaveBeenCalledTimes(3);
    const sent = synthesize.mock.calls.map(call => call[0].text);
    const lookup = createPool(process.env.TEST_DATABASE_URL!);
    const published = (await lookup.query('SELECT data FROM published_beats WHERE session_id=$1 AND id=$2', [sessionId, beatId]).finally(() => lookup.end())).rows[0].data;
    const playerSegment = published.segments.find((s: any) => s.kind === 'player_dialogue');
    expect(playerSegment.text).toBe('My exact player words stay silent.');
    expect(sent).toContain(`${playerSegment.speaker.displayName}: My exact player words stay silent.`);
    const story = published.segments.filter((s: any) => s.kind === 'narration' || s.kind === 'npc_dialogue');
    for (const segment of story) {
      const tag = DELIVERY_TAGS[segment.delivery as keyof typeof DELIVERY_TAGS];
      expect(sent).toContain(segment.voiceText ?? (tag ? `${tag} ${segment.text}` : segment.text));
    }
    const quiet = story.find((s: any) => s.delivery === 'quiet');
    expect(quiet, 'the test AI gives Mara a quiet line').toBeTruthy();
    expect(sent).toContain(`[quietly] ${quiet.text}`);
    expect(sent).not.toContain(quiet.text);
    expect(first.json().manifest.segments.find((s: any) => s.id === playerSegment.id)).toMatchObject({ text: 'My exact player words stay silent.', speaker: playerSegment.speaker.displayName });
    expect(JSON.stringify(synthesize.mock.calls)).not.toContain('archive safe');
    expect(JSON.stringify(synthesize.mock.calls)).not.toContain('brass key');
    const repeated = await request(`/api/sessions/${sessionId}/audio/${beatId}`, host, { commandId: crypto.randomUUID() });
    expect(repeated.json()).toEqual(first.json());
    expect(synthesize).toHaveBeenCalledTimes(3);
  });
  it('allows authorized stage assets and denies anonymous access without changing canon', async () => {
    const publicManifest = await request(`/api/sessions/${sessionId}/audio/${beatId}`, stage);
    expect(publicManifest.statusCode).toBe(200);
    const assetUrl = publicManifest.json().manifest.segments[0].url;
    expect((await request(assetUrl, '')).statusCode).toBe(401);
    const audio = await request(assetUrl, stage);
    expect(audio.statusCode).toBe(200);
    expect(audio.headers['content-type']).toContain('audio/mpeg');
    const current = (await request(`/api/sessions/${sessionId}`)).json();
    expect(current.session.beatNumber).toBe(1);
    expect(current.session.actionRoundNumber).toBe(0);
  });

  it('serves clips with byte ranges and long-lived caching, while everything else stays no-store', async () => {
    const manifest = await request(`/api/sessions/${sessionId}/audio/${beatId}`, stage);
    const assetUrl = manifest.json().manifest.segments[0].url;
    const bytes = Uint8Array.from({ length: 26 }, (_, i) => 65 + i);
    await writeFile(join(directory, `${assetUrl.split('/').pop()}.mp3`), bytes);
    const whole = await request(assetUrl, stage);
    expect(whole.statusCode).toBe(200);
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(whole.rawPayload.length).toBe(26);
    const ranged = (range: string) => app.inject({ method: 'GET', url: assetUrl, headers: { cookie: stage, origin, range } });
    const first = await ranged('bytes=0-9');
    expect(first.statusCode).toBe(206);
    expect(first.headers['content-range']).toBe('bytes 0-9/26');
    expect(first.headers['accept-ranges']).toBe('bytes');
    expect(first.headers['content-length']).toBe('10');
    expect(first.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(first.body).toBe('ABCDEFGHIJ');
    const last = await ranged('bytes=-5');
    expect(last.statusCode).toBe(206);
    expect(last.headers['content-range']).toBe('bytes 21-25/26');
    expect(last.body).toBe('VWXYZ');
    const beyond = await ranged('bytes=26-');
    expect(beyond.statusCode).toBe(416);
    expect(beyond.headers['content-range']).toBe('bytes */26');
    expect(beyond.headers['accept-ranges']).toBe('bytes');
    expect(beyond.headers['cache-control']).toBe('no-store');
    expect((await request(assetUrl, '')).headers['cache-control']).toBe('no-store');
    expect((await request(`/api/sessions/${sessionId}/audio/${beatId}`, stage)).headers['cache-control']).toBe('no-store');
    expect((await request(`/api/sessions/${sessionId}/audio/assets/${'d'.repeat(64)}`, stage)).headers['cache-control']).toBe('no-store');
    expect((await request(`/api/sessions/${sessionId}/beats/${draftId}/draft-audio`, host)).headers['cache-control']).toBe('no-store');
  });

  it('denies cached audio with no ready published reference even when the asset hash is known', async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL!);
    const assetId = 'b'.repeat(64);
    try {
      await pool.query("INSERT INTO audio_assets(id,session_id,content_type,byte_length) VALUES($1,$2,'audio/mpeg',4) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id", [assetId, sessionId]);
      await writeFile(join(directory, `${assetId}.mp3`), new Uint8Array([73, 68, 51, 0]));
      for (const actor of [host, stage]) expect((await request(`/api/sessions/${sessionId}/audio/assets/${assetId}`, actor)).statusCode).toBe(404);
    } finally { await pool.end(); }
  });

  async function voicedTable() {
    const creation = (await request('/api/sessions', host, { commandId: crypto.randomUUID() })).json();
    const id: string = creation.sessionId;
    const seat = cookie(await request('/api/auth/redeem', '', { token: creation.invites.find((invite: any) => invite.role === 'player').token }));
    let current: any = (await request(`/api/sessions/${id}`)).json();
    const send = async (credential: string, body: Record<string, unknown>) => {
      const result = await request(`/api/sessions/${id}/commands`, credential, { commandId: crypto.randomUUID(), ...body });
      expect(result.statusCode, result.body).toBe(200);
      if (credential === host) current = result.json().snapshot;
      return result.json().snapshot;
    };
    const step = (type: string, extra = {}) => send(host, { type, beatId: current.activeBeat.id, expectedBeatRevision: current.activeBeat.revision, ...extra });
    const own = await send(seat, { type: 'set_voice', voiceProfileId: 'eleven:fake-ada' });
    expect(own.ownCharacter.voiceProfileId).toBe('eleven:fake-ada');
    await send(host, { type: 'open_beat', kind: 'conversation', expectedInputEpoch: current.session.inputEpoch });
    const line = await send(seat, { type: 'save_submission', contextBeatId: current.activeBeat.id, expectedInputEpoch: current.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'say', text: '[softly] I chose this voice myself.', recipientNpcIds: [current.npcs[0].id] });
    await step('plan_beat', { submissionIds: line.submissions.map((s: any) => s.id) });
    await step('approve_stakes', { classification: 'ordinary', contracts: [] });
    await step('lock_beat');
    await step('render_beat');
    return { id, seat, send, step, get current() { return current; }, character: own.ownCharacter };
  }
  const publishedBeat = async (id: string, beat: string) => {
    const lookup = createPool(process.env.TEST_DATABASE_URL!);
    return (await lookup.query('SELECT data FROM published_beats WHERE session_id=$1 AND id=$2', [id, beat]).finally(() => lookup.end())).rows[0].data;
  };
  const matchesPlayback = (manifest: any, published: any) => {
    const spoken = published.segments.filter((s: any) => isSpokenSegmentKind(s.kind));
    expect(manifest.segments.map((s: any) => [s.id, s.voiceProfileId])).toEqual(spoken.map((s: any) => [s.id, s.voiceProfileId ?? 'voice_narrator']));
  };

  it('reads a Say line in the speaker\'s own voice, without the name, when narration is prepared after a text-only publication', async () => {
    const table = await voicedTable();
    const published = table.current.activeBeat.id;
    await table.step('publish_beat', { expectedStateRevision: table.current.session.stateRevision, draftRevision: table.current.activeBeat.draftRevision, textOnly: true });
    const data = await publishedBeat(table.id, published);
    const say = data.segments.find((s: any) => s.kind === 'player_dialogue');
    expect(say).toMatchObject({ text: 'I chose this voice myself.', voiceText: '[softly] I chose this voice myself.', voiceProfileId: 'eleven:fake-ada' });
    synthesize.mockClear();
    const prepared = await request(`/api/sessions/${table.id}/audio/${published}`, host, { commandId: crypto.randomUUID() });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const own = synthesize.mock.calls.map(call => call[0]).filter(call => call.voiceProfileId === 'eleven:fake-ada');
    expect(own).toEqual([{ text: '[softly] I chose this voice myself.', voiceProfileId: 'eleven:fake-ada' }]);
    expect(JSON.stringify(synthesize.mock.calls)).not.toContain(`${table.character.displayName}:`);
    expect(prepared.json().manifest.segments.find((s: any) => s.id === say.id)).toMatchObject({ text: 'I chose this voice myself.', voiceProfileId: 'eleven:fake-ada' });
    matchesPlayback(prepared.json().manifest, data);
  });

  it('publishes a reviewed Say line with the voice its recording used, even after the player changes voice', async () => {
    const table = await voicedTable();
    const path = `/api/sessions/${table.id}/beats/${table.current.activeBeat.id}/draft-audio`;
    const before = (await request(path)).json();
    synthesize.mockClear();
    const preview = await request(path, host, { commandId: crypto.randomUUID(), expectedBeatRevision: table.current.activeBeat.revision, draftRevision: table.current.activeBeat.draftRevision, generation: table.current.activeBeat.generation });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().status).toBe('ready');
    expect(synthesize.mock.calls.map(call => call[0])).toContainEqual({ text: '[softly] I chose this voice myself.', voiceProfileId: 'eleven:fake-ada' });
    expect(preview.json().manifest.segments.find((s: any) => s.text === 'I chose this voice myself.').voiceProfileId).toBe('eleven:fake-ada');
    await table.send(table.seat, { type: 'set_voice', voiceProfileId: null });
    const after = (await request(path)).json();
    expect(after).toEqual({ status: 'ready', manifest: preview.json().manifest });
    expect(before.status).toBe('missing');
    const beat = table.current.activeBeat.id;
    await table.step('publish_beat', { expectedStateRevision: table.current.session.stateRevision, draftRevision: table.current.activeBeat.draftRevision, textOnly: false, audioPreparationId: preview.json().manifest.preparationId });
    const data = await publishedBeat(table.id, beat);
    expect(data.segments.find((s: any) => s.kind === 'player_dialogue').voiceProfileId).toBe('eleven:fake-ada');
    const manifest = (await request(`/api/sessions/${table.id}/audio/${beat}`)).json();
    expect(manifest.status).toBe('ready');
    matchesPlayback(manifest.manifest, data);
  });

  it('reads a line in the narrator\'s voice, with the name in front, when its chosen voice no longer exists', async () => {
    const table = await voicedTable();
    const published = table.current.activeBeat.id;
    await table.step('publish_beat', { expectedStateRevision: table.current.session.stateRevision, draftRevision: table.current.activeBeat.draftRevision, textOnly: true });
    const data = await publishedBeat(table.id, published);
    const say = data.segments.find((s: any) => s.kind === 'player_dialogue');
    synthesize.mockClear();
    synthesize.mockImplementation(async input => {
      if (input.voiceProfileId.startsWith('eleven:')) throw new ProviderError('http_error', 'ElevenLabs', 404, 'voice_missing');
      return fakeAudio(input);
    });
    try {
      const prepared = await request(`/api/sessions/${table.id}/audio/${published}`, host, { commandId: crypto.randomUUID() });
      expect(prepared.statusCode, prepared.body).toBe(200);
      expect(prepared.json().status).toBe('ready');
      expect(prepared.json().manifest.segments.find((s: any) => s.id === say.id)).toMatchObject({ text: 'I chose this voice myself.', voiceProfileId: 'voice_narrator' });
      expect(synthesize.mock.calls.map(call => call[0])).toContainEqual({ text: `${table.character.displayName}: [softly] I chose this voice myself.`, voiceProfileId: 'voice_narrator' });
    } finally { synthesize.mockImplementation(fakeAudio); }
  });

  it('uses the narrator for a missing voice in the draft preview, and still fails on any other speech error', async () => {
    const table = await voicedTable();
    const path = `/api/sessions/${table.id}/beats/${table.current.activeBeat.id}/draft-audio`;
    const body = () => ({ commandId: crypto.randomUUID(), expectedBeatRevision: table.current.activeBeat.revision, draftRevision: table.current.activeBeat.draftRevision, generation: table.current.activeBeat.generation });
    synthesize.mockClear();
    synthesize.mockImplementation(async input => {
      if (input.voiceProfileId.startsWith('eleven:')) throw new Error('ElevenLabs is down');
      return fakeAudio(input);
    });
    try {
      const failed = await request(path, host, body());
      expect(failed.statusCode, failed.body).toBe(200);
      expect(failed.json().status).toBe('failed');
      synthesize.mockImplementation(async input => {
        if (input.voiceProfileId.startsWith('eleven:')) throw new ProviderError('http_error', 'ElevenLabs', 404, 'voice_missing');
        return fakeAudio(input);
      });
      const preview = await request(path, host, body());
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json().status).toBe('ready');
      expect(preview.json().manifest.segments.find((s: any) => s.text === 'I chose this voice myself.').voiceProfileId).toBe('voice_narrator');
    } finally { synthesize.mockImplementation(fakeAudio); }
  });

  it('returns the reviewed recording when newer audio configurations exist', async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL!);
    try {
      const ready = (await request(`/api/sessions/${sessionId}/audio/${beatId}`)).json().manifest;
      const key = 'a'.repeat(64);
      await pool.query("UPDATE audio_manifests SET config_hash=$3 WHERE session_id=$1 AND beat_id=$2", [sessionId, beatId, key]);
      await pool.query("UPDATE published_beats SET data=data || $3::jsonb WHERE session_id=$1 AND id=$2", [sessionId, beatId, JSON.stringify({ textOnly: false, audioManifestKey: key })]);
      const replacement = { ...ready, segments: ready.segments.map((s: any) => ({ ...s, url: `/api/sessions/${sessionId}/audio/assets/${'c'.repeat(64)}` })) };
      await pool.query("INSERT INTO audio_manifests(session_id,beat_id,config_hash,status,lease_id,lease_until,manifest,updated_at) VALUES($1,$2,'later-config','ready',$3,now(),$4,now()+interval '1 second')", [sessionId, beatId, crypto.randomUUID(), replacement]);
      expect((await request(`/api/sessions/${sessionId}/audio/${beatId}`)).json().manifest).toEqual(ready);
      const calls = synthesize.mock.calls.length;
      expect((await request(`/api/sessions/${sessionId}/audio/${beatId}`, host, { commandId: crypto.randomUUID() })).json().manifest).toEqual(ready);
      expect(synthesize).toHaveBeenCalledTimes(calls);
      expect((await pool.query('SELECT config_hash FROM audio_manifests WHERE session_id=$1 AND beat_id=$2', [sessionId, beatId])).rows).toHaveLength(2);
    } finally { await pool.end(); }
  });
});
