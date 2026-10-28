import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app';
import { ProviderError } from '@rpg/providers';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite('narrator stand-in reaches playback', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let directory: string;
  let host: string;
  const origin = 'http://localhost:3000';
  const fakeAudio = async (_input: { text: string; voiceProfileId: string }) => ({ bytes: new Uint8Array([73, 68, 51, 0]), contentType: 'audio/mpeg' });
  const synthesize = vi.fn(fakeAudio);
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0];
  const request = (url: string, credential = host, payload?: unknown) => app.inject({ method: payload ? 'POST' : 'GET', url, headers: { cookie: credential, origin }, ...(payload ? { payload } : {}) });
  const missing = (prefix: string) => async (input: { text: string; voiceProfileId: string }) => {
    if (input.voiceProfileId.startsWith(prefix)) throw new ProviderError('http_error', 'ElevenLabs', 404, 'voice_missing');
    return fakeAudio(input);
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rpg-fallback-audio-'));
    const hostToken = 'audio-test-host-token-at-least-32-characters';
    app = await buildApp({ databaseUrl: process.env.TEST_DATABASE_URL!, origin, hostToken, speech: { synthesize }, speechModel: 'test-model', speechVoiceId: 'test-voice', assetDir: directory });
    host = cookie(await request('/api/auth/host', '', { token: hostToken }));
  });
  afterAll(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }); });

  async function table(npcVoice: string | null) {
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
    await send(seat, { type: 'set_voice', voiceProfileId: 'eleven:fake-ada' });
    if (npcVoice) {
      await send(host, { type: 'open_beat', kind: 'conversation', expectedInputEpoch: current.session.inputEpoch });
      await step('abort_beat', { reason: 'Warm up' });
      const { id: npcId, version, knowledge: _k, relationships: _r, ...profile } = current.npcDetails[0];
      await send(host, { type: 'save_npc', expectedStateRevision: current.session.stateRevision, reason: 'Voice', discardQueuedInput: true, npcId, expectedNpcVersion: version, profile: { ...profile, voiceProfileId: npcVoice } });
      expect(current.npcDetails[0].voiceProfileId).toBe(npcVoice);
    }
    await send(host, { type: 'open_beat', kind: 'conversation', expectedInputEpoch: current.session.inputEpoch });
    const line = await send(seat, { type: 'save_submission', contextBeatId: current.activeBeat.id, expectedInputEpoch: current.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'say', text: '[softly] I chose this voice myself.', recipientNpcIds: [current.npcs[0].id] });
    await step('plan_beat', { submissionIds: line.submissions.map((s: any) => s.id) });
    await step('approve_stakes', { classification: 'ordinary', contracts: [] });
    await step('lock_beat');
    await step('render_beat');
    return { id, step, get current() { return current; } };
  }

  async function startPlayback(id: string, beatId: string) {
    const playback = (path: string, payload?: unknown) => app.inject({ method: payload ? 'POST' : 'GET', url: `/api/sessions/${id}/playback${path}`, headers: { cookie: host, origin }, ...(payload ? { payload } : {}) });
    let snapshot = (await playback('')).json();
    const claim = await playback('/presenter', { commandId: crypto.randomUUID(), expectedRevision: snapshot.revision, type: 'claim', clientId: crypto.randomUUID() });
    expect(claim.statusCode, claim.body).toBe(200);
    snapshot = claim.json().snapshot;
    return playback('/commands', { commandId: crypto.randomUUID(), expectedRevision: snapshot.revision, type: 'start', beatId });
  }

  it('starts playback for a normal reviewed recording', async () => {
    const t = await table(null);
    const beat = t.current.activeBeat.id;
    const preview = await request(`/api/sessions/${t.id}/beats/${beat}/draft-audio`, host, { commandId: crypto.randomUUID(), expectedBeatRevision: t.current.activeBeat.revision, draftRevision: t.current.activeBeat.draftRevision, generation: t.current.activeBeat.generation });
    expect(preview.json().status).toBe('ready');
    await t.step('publish_beat', { expectedStateRevision: t.current.session.stateRevision, draftRevision: t.current.activeBeat.draftRevision, textOnly: false, audioPreparationId: preview.json().manifest.preparationId });
    const started = await startPlayback(t.id, beat);
    expect(started.statusCode, started.body).toBe(200);
  });

  it('starts playback for a player line with a missing voice, reviewed and published with audio', async () => {
    const t = await table(null);
    const beat = t.current.activeBeat.id;
    synthesize.mockImplementation(missing('eleven:'));
    try {
      const preview = await request(`/api/sessions/${t.id}/beats/${beat}/draft-audio`, host, { commandId: crypto.randomUUID(), expectedBeatRevision: t.current.activeBeat.revision, draftRevision: t.current.activeBeat.draftRevision, generation: t.current.activeBeat.generation });
      expect(preview.json().status).toBe('ready');
      await t.step('publish_beat', { expectedStateRevision: t.current.session.stateRevision, draftRevision: t.current.activeBeat.draftRevision, textOnly: false, audioPreparationId: preview.json().manifest.preparationId });
    } finally { synthesize.mockImplementation(fakeAudio); }
    const started = await startPlayback(t.id, beat);
    expect(started.statusCode, started.body).toBe(200);
  });

  it('starts playback for a character line with a missing voice, reviewed and published with audio', async () => {
    const t = await table('eleven:fake-bram');
    const beat = t.current.activeBeat.id;
    synthesize.mockImplementation(missing('eleven:fake-bram'));
    try {
      const preview = await request(`/api/sessions/${t.id}/beats/${beat}/draft-audio`, host, { commandId: crypto.randomUUID(), expectedBeatRevision: t.current.activeBeat.revision, draftRevision: t.current.activeBeat.draftRevision, generation: t.current.activeBeat.generation });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json().status).toBe('ready');
      const published = await request(`/api/sessions/${t.id}/commands`, host, { commandId: crypto.randomUUID(), type: 'publish_beat', beatId: beat, expectedBeatRevision: t.current.activeBeat.revision, expectedStateRevision: t.current.session.stateRevision, draftRevision: t.current.activeBeat.draftRevision, textOnly: false, audioPreparationId: preview.json().manifest.preparationId });
      expect(published.statusCode, published.body).toBe(200);
    } finally { synthesize.mockImplementation(fakeAudio); }
    const started = await startPlayback(t.id, beat);
    expect(started.statusCode, started.body).toBe(200);
  });

  it('starts playback for a player line with a missing voice, published text-only then narrated', async () => {
    const t = await table(null);
    const beat = t.current.activeBeat.id;
    await t.step('publish_beat', { expectedStateRevision: t.current.session.stateRevision, draftRevision: t.current.activeBeat.draftRevision, textOnly: true });
    synthesize.mockImplementation(missing('eleven:'));
    try {
      const prepared = await request(`/api/sessions/${t.id}/audio/${beat}`, host, { commandId: crypto.randomUUID() });
      expect(prepared.statusCode, prepared.body).toBe(200);
      expect(prepared.json().status).toBe('ready');
    } finally { synthesize.mockImplementation(fakeAudio); }
    const started = await startPlayback(t.id, beat);
    expect(started.statusCode, started.body).toBe(200);
  });
});
