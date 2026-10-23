import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app';
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
  const synthesize = vi.fn(async (_input: { text: string; voiceProfileId: string }) => ({ bytes: new Uint8Array([73, 68, 51, 0]), contentType: 'audio/mpeg' }));
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
  it('sends only approved narrator/NPC text and caches identical requests', async () => {
    const first = await request(`/api/sessions/${sessionId}/audio/${beatId}`, host, { commandId: crypto.randomUUID() });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().status).toBe('ready');
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(synthesize.mock.calls)).not.toContain('My exact player words');
    expect(JSON.stringify(synthesize.mock.calls)).not.toContain('archive safe');
    expect(JSON.stringify(synthesize.mock.calls)).not.toContain('brass key');
    const repeated = await request(`/api/sessions/${sessionId}/audio/${beatId}`, host, { commandId: crypto.randomUUID() });
    expect(repeated.json()).toEqual(first.json());
    expect(synthesize).toHaveBeenCalledTimes(2);
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

  it('denies cached audio with no ready published reference even when the asset hash is known', async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL!);
    const assetId = 'b'.repeat(64);
    try {
      await pool.query("INSERT INTO audio_assets(id,session_id,content_type,byte_length) VALUES($1,$2,'audio/mpeg',4) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id", [assetId, sessionId]);
      await writeFile(join(directory, `${assetId}.mp3`), new Uint8Array([73, 68, 51, 0]));
      for (const actor of [host, stage]) expect((await request(`/api/sessions/${sessionId}/audio/assets/${assetId}`, actor)).statusCode).toBe(404);
    } finally { await pool.end(); }
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
