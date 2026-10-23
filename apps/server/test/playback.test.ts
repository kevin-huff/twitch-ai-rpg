import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { PlaybackResponseSchema, PlaybackSnapshotSchema, type AudioManifest, type PlaybackSnapshot } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const withoutTime = (response: any) => ({ ...response, snapshot: { ...response.snapshot, serverTimeMs: 0 } });

suite('durable coordinated public playback', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let hostToken: string;
  let host: string;
  let stage: string;
  let player: string;
  let sessionId: string;
  let beatId: string;
  let manifest: AudioManifest;
  let snapshot: PlaybackSnapshot;
  let clientId: string;
  let leaseId: string;
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (path = '', payload?: object, credential = host, id = sessionId, requestOrigin = origin) => app.inject({ method: payload === undefined ? 'GET' : 'POST', url: `/api/sessions/${id}/playback${path}`, headers: { cookie: credential, origin: requestOrigin }, ...(payload === undefined ? {} : { payload }) });
  async function get(credential = host) {
    const response = await request('', undefined, credential);
    expect(response.statusCode, response.body).toBe(200);
    snapshot = PlaybackSnapshotSchema.parse(response.json());
    return snapshot;
  }
  async function ok(path: string, payload: object, credential = host) {
    const response = await request(path, payload, credential);
    expect(response.statusCode, response.body).toBe(200);
    const result = PlaybackResponseSchema.parse(response.json());
    snapshot = result.snapshot;
    return result;
  }
  const command = (type: string, extra = {}) => ({ commandId: randomUUID(), expectedRevision: snapshot.revision, type, ...(type === 'start' ? { beatId } : { playbackId: snapshot.playbackId }), ...extra });
  const owner = (type: string, extra = {}) => ({ commandId: randomUUID(), clientId, leaseId, type, ...extra });
  const telemetry = (type: string, extra = {}) => ({ ...owner(type), playbackId: snapshot.playbackId, expectedRevision: snapshot.revision, segmentIndex: snapshot.segmentIndex, telemetrySequence: 1, ...extra });
  async function claim(credential = stage) {
    clientId = randomUUID();
    const result = await ok('/presenter', { commandId: randomUUID(), expectedRevision: snapshot.revision, type: 'claim', clientId }, credential);
    leaseId = result.leaseId!;
    expect(leaseId).toMatch(/^[a-f0-9-]{36}$/);
  }
  async function start() { await claim(); await ok('/commands', command('start')); }
  async function elapseAnchor() { await pool.query('UPDATE session_playback SET anchor_time_ms=$2 WHERE session_id=$1', [sessionId, Date.now() - 20]); }
  async function awaitPlaybackLock() {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%session_playback%' AND pid<>pg_backend_pid()");
      if (waiting.rowCount) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('The playback request did not enter an observable database lock wait.');
  }
  async function seedPublication(number = 1) {
    const id = randomUUID();
    const segments = [
      { id: randomUUID(), kind: 'narration', text: 'Only approved public narration.', speaker: null, voiceProfileId: null },
      { id: randomUUID(), kind: 'player_dialogue', text: 'The player quote is never synthesized.', speaker: { entityId: 'player', displayName: 'Player' }, voiceProfileId: null },
      { id: randomUUID(), kind: 'npc_dialogue', text: 'Mara speaks publicly.', speaker: { entityId: 'mara', displayName: 'Mara' }, voiceProfileId: 'voice_mara' },
    ].map(segment => ({ ...segment, recipientCharacterIds: [], delivery: 'neutral', sourceSubmissionIds: [], ttsEnabled: true }));
    const publication = { id, kind: 'conversation', beatNumber: number, actionRoundNumber: 0, stateRevision: 1, publishedAt: new Date().toISOString(), segments, rolls: [], outcomes: [], textOnly: true };
    await pool.query("INSERT INTO beats(id,session_id,kind,phase,data) VALUES($1,$2,'conversation','published',$3)", [id, sessionId, {}]);
    await pool.query('INSERT INTO published_beats(id,session_id,beat_number,data) VALUES($1,$2,$3,$4)', [id, sessionId, number, publication]);
    const prepared: AudioManifest = { beatId: id, segments: segments.filter(segment => segment.kind !== 'player_dialogue').map((segment, index) => ({ id: segment.id, text: segment.text, speaker: segment.speaker?.displayName ?? 'Narrator', voiceProfileId: segment.voiceProfileId ?? 'voice_narrator', url: `/api/sessions/${sessionId}/audio/assets/${createHash('sha256').update(`${id}-${index}`).digest('hex')}` })) };
    for (const segment of prepared.segments) await pool.query("INSERT INTO audio_assets(id,session_id,content_type,byte_length) VALUES($1,$2,'audio/mpeg',4)", [segment.url.split('/').at(-1), sessionId]);
    await pool.query("INSERT INTO audio_manifests(session_id,beat_id,config_hash,status,lease_id,lease_until,manifest) VALUES($1,$2,'original','ready',$3,clock_timestamp(),$4)", [sessionId, id, randomUUID(), prepared]);
    return { id, manifest: prepared };
  }
  async function canonical() {
    const values = [];
    for (const table of ['sessions', 'characters', 'npcs', 'tracks', 'facts', 'beats', 'published_beats', 'submissions', 'rolls', 'action_contracts', 'audit_events', 'outbox']) values.push((await pool.query(`SELECT ${table === 'outbox' ? "(to_jsonb(t)-'dispatched_at')" : 'row_to_json(t)'}::text AS value FROM ${table} t WHERE ${table === 'sessions' ? 'id' : 'session_id'}=$1 ORDER BY row_to_json(t)::text`, [sessionId])).rows);
    return JSON.stringify(values);
  }
  it('starts the publication-pinned recording even if another configuration was prepared later', async () => {
    const key = 'd'.repeat(64);
    await pool.query("UPDATE audio_manifests SET config_hash=$3 WHERE session_id=$1 AND beat_id=$2", [sessionId, beatId, key]);
    await pool.query("UPDATE published_beats SET data=data || $3::jsonb WHERE session_id=$1 AND id=$2", [sessionId, beatId, JSON.stringify({ textOnly: false, audioManifestKey: key })]);
    const later = { ...manifest, segments: manifest.segments.map(segment => ({ ...segment, url: `/api/sessions/${sessionId}/audio/assets/${'e'.repeat(64)}` })) };
    await pool.query("INSERT INTO audio_assets(id,session_id,content_type,byte_length) VALUES($1,$2,'audio/mpeg',4) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id", ['e'.repeat(64), sessionId]);
    await pool.query("INSERT INTO audio_manifests(session_id,beat_id,config_hash,status,lease_id,lease_until,manifest,updated_at) VALUES($1,$2,'later-config','ready',$3,now(),$4,now()+interval '1 second')", [sessionId, beatId, randomUUID(), later]);
    await start();
    expect(snapshot.manifest).toEqual(manifest);
  });
  beforeEach(async () => {
    hostToken = `playback-host-${randomUUID()}`;
    pool = createPool(databaseUrl!);
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    host = cookie(await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } }));
    const creation = await app.inject({ method: 'POST', url: '/api/sessions', headers: { origin, cookie: host }, payload: { commandId: randomUUID() } });
    sessionId = creation.json().sessionId;
    for (const role of ['stage', 'player']) {
      const token = creation.json().invites.find((invite: any) => invite.role === role).token;
      const credential = cookie(await app.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token } }));
      if (role === 'stage') stage = credential; else player = credential;
    }
    const published = await seedPublication();
    beatId = published.id; manifest = published.manifest;
    await get();
  });
  afterEach(async () => { await app?.close(); await pool?.end(); });

  it('starts idle and exposes the same public state to all authorized roles without owner secrets', async () => {
    expect(snapshot).toMatchObject({ revision: 0, sampleRevision: 0, playbackId: null, status: 'idle', manifest: null, segmentIndex: null, positionMs: 0, anchorTimeMs: null, presenter: { available: false, leaseExpiresAtMs: null } });
    await claim();
    for (const credential of [host, stage, player]) {
      const publicState = await get(credential);
      expect(publicState.presenter.available).toBe(true);
      expect(JSON.stringify(publicState)).not.toContain(leaseId);
      expect(JSON.stringify(publicState)).not.toContain(clientId);
    }
  });

  it('enforces roles, session membership, origin, authentication, and strict bodies', async () => {
    for (const credential of [stage, player]) expect((await request('/commands', command('start'), credential)).statusCode).toBe(403);
    expect((await request('/presenter', { commandId: randomUUID(), type: 'claim', clientId: randomUUID(), expectedRevision: 0 }, player)).statusCode).toBe(403);
    expect((await request('', undefined, '')).statusCode).toBe(401);
    expect((await request('/commands', command('start'), host, sessionId, 'http://foreign.test')).statusCode).toBe(403);
    expect((await request('/commands', { ...command('start'), manifest })).statusCode).toBe(400);
    expect((await request('', undefined, stage, randomUUID())).statusCode).toBe(404);
    const otherHost = cookie(await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } }));
    await pool.query('UPDATE sessions SET owner_id=$2 WHERE id=$1', [sessionId, 'foreign-host']);
    expect((await request('', undefined, otherHost)).statusCode).toBe(404);
  });

  it('atomically appoints one presenter, including different tabs with the same host actor', async () => {
    const candidates = [randomUUID(), randomUUID()];
    const responses = await Promise.all(candidates.map(clientId => request('/presenter', { commandId: randomUUID(), type: 'claim', clientId, expectedRevision: 0 }, host)));
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    await get();
    expect(snapshot.revision).toBe(1);
    expect(snapshot.sampleRevision).toBe(1);
    expect(snapshot.status).toBe('idle');
  });

  it('retries claims and renewals without extending the lease and rejects command ID reuse across body, route, and session', async () => {
    clientId = randomUUID();
    const payload = { commandId: randomUUID(), type: 'claim', clientId, expectedRevision: 0 };
    const first = await ok('/presenter', payload);
    const repeated = await ok('/presenter', payload);
    expect(withoutTime(repeated)).toEqual(withoutTime(first));
    expect(repeated.snapshot.serverTimeMs).toBeGreaterThanOrEqual(first.snapshot.serverTimeMs);
    leaseId = first.leaseId!;
    expect((await request('/presenter', { ...payload, clientId: randomUUID() })).statusCode).toBe(409);
    expect((await request('/commands', { commandId: payload.commandId, type: 'start', beatId, expectedRevision: 1 })).statusCode).toBe(409);
    const creation = (await app.inject({ method: 'POST', url: '/api/sessions', headers: { cookie: host, origin }, payload: { commandId: randomUUID() } })).json();
    expect((await request('/presenter', payload, host, creation.sessionId)).statusCode).toBe(409);
    const renew = owner('renew', { renewalSequence: 3 });
    const renewed = await ok('/presenter', renew);
    expect(renewed.snapshot.revision).toBe(1);
    expect(renewed.snapshot.sampleRevision).toBe(2);
    expect(withoutTime(await ok('/presenter', renew))).toEqual(withoutTime(renewed));
    expect((await request('/presenter', owner('renew', { renewalSequence: 2 }))).statusCode).toBe(409);
    expect((await request('/presenter', owner('renew', { renewalSequence: 3 }))).statusCode).toBe(409);
  });

  it('requires a presenter and a ready canonical nonempty published manifest', async () => {
    expect((await request('/commands', command('start'))).statusCode).toBe(409);
    await claim();
    expect((await request('/commands', command('start', { beatId: randomUUID() }))).statusCode).toBe(404);
    for (const bad of [{ ...manifest, segments: [] }, { ...manifest, segments: [{ ...manifest.segments[0]!, text: 'Private forged text' }] }, { ...manifest, segments: manifest.segments.map(segment => ({ ...segment, url: segment.url.replace(sessionId, 'another-session') })) }]) {
      await pool.query('UPDATE audio_manifests SET manifest=$2 WHERE session_id=$1', [sessionId, bad]);
      expect((await request('/commands', command('start'))).statusCode).toBe(409);
    }
    await pool.query("UPDATE audio_manifests SET manifest=$2,status='preparing' WHERE session_id=$1", [sessionId, manifest]);
    expect((await request('/commands', command('start'))).statusCode).toBe(409);
    await pool.query("UPDATE audio_manifests SET status='failed' WHERE session_id=$1", [sessionId]);
    expect((await request('/commands', command('start'))).statusCode).toBe(409);
    await pool.query("UPDATE audio_manifests SET status='ready' WHERE session_id=$1", [sessionId]);
    await pool.query('DELETE FROM audio_assets WHERE session_id=$1', [sessionId]);
    expect((await request('/commands', command('start'))).statusCode).toBe(409);
  });

  it('pins an older publication and manifest across later preparations and creates a fresh epoch on deliberate replay', async () => {
    const before = await canonical();
    await start();
    expect(snapshot.manifest).toEqual(manifest);
    expect(snapshot.anchorTimeMs! - snapshot.serverTimeMs).toBe(500);
    const epoch = snapshot.playbackId;
    const second = await seedPublication(2);
    await pool.query('UPDATE audio_manifests SET manifest=$2 WHERE session_id=$1 AND beat_id=$3', [sessionId, { ...manifest, segments: [] }, beatId]);
    await get();
    expect(snapshot.manifest).toEqual(manifest);
    await ok('/commands', command('start', { beatId: second.id }));
    expect(snapshot.playbackId).not.toBe(epoch);
    expect(snapshot.manifest).toEqual(second.manifest);
    await ok('/commands', command('start', { beatId: second.id }));
    expect(snapshot.playbackId).not.toBe(epoch);
    expect(before).not.toBe(await canonical()); // Only this test's explicit publication changed canon.
  });

  it('supports pause, resume, skip, stop and preserves all canonical state byte for byte', async () => {
    const before = await canonical();
    await start();
    await elapseAnchor();
    const oldRevision = snapshot.revision;
    await ok('/commands', command('pause'));
    expect(snapshot).toMatchObject({ revision: oldRevision + 1, status: 'paused', anchorTimeMs: null });
    expect(snapshot.positionMs).toBeGreaterThanOrEqual(20);
    await ok('/commands', command('resume'));
    expect(snapshot.status).toBe('playing');
    await ok('/commands', command('skip'));
    expect(snapshot).toMatchObject({ segmentIndex: 1, positionMs: 0, status: 'playing' });
    await ok('/commands', command('pause'));
    await ok('/commands', command('skip'));
    expect(snapshot).toMatchObject({ status: 'complete', segmentIndex: null, anchorTimeMs: null, positionMs: 0 });
    for (const type of ['pause', 'resume', 'skip']) expect((await request('/commands', command(type))).statusCode).toBe(409);
    const epoch = snapshot.playbackId;
    await ok('/commands', command('stop'));
    expect(snapshot).toMatchObject({ status: 'stopped', segmentIndex: null, anchorTimeMs: null, playbackId: epoch, manifest });
    expect(await canonical()).toBe(before);
  });

  it('rejects ended-session start and resume while allowing explicit playback in a paused game', async () => {
    await pool.query("UPDATE sessions SET status='paused' WHERE id=$1", [sessionId]);
    await start();
    await ok('/commands', command('pause'));
    await pool.query("UPDATE sessions SET status='ended' WHERE id=$1", [sessionId]);
    expect((await request('/commands', command('resume'))).statusCode).toBe(409);
    expect((await request('/commands', command('start'))).statusCode).toBe(409);
    await ok('/commands', command('stop'));
  });

  it('accepts confirmed positions against the last report and rejects future anchors, rewinds, and stale context without consuming sequence', async () => {
    await start();
    const position = telemetry('position', { positionMs: 10 });
    expect((await request('/telemetry', position, stage)).statusCode).toBe(409);
    await elapseAnchor();
    for (const patch of [{ leaseId: randomUUID() }, { clientId: randomUUID() }, { playbackId: randomUUID() }, { expectedRevision: 0 }, { segmentIndex: 1 }]) expect((await request('/telemetry', { ...position, ...patch }, stage)).statusCode).toBe(409);
    expect((await request('/telemetry', position, host)).statusCode).toBe(409);
    const revision = snapshot.revision;
    const first = await ok('/telemetry', position, stage);
    expect(snapshot.revision).toBe(revision);
    expect(snapshot.positionMs).toBe(10);
    expect(withoutTime(await ok('/telemetry', position, stage))).toEqual(withoutTime(first));
    expect((await request('/telemetry', telemetry('position', { positionMs: 9, telemetrySequence: 2 }), stage)).statusCode).toBe(409);
    await ok('/telemetry', telemetry('position', { positionMs: 11, telemetrySequence: 2 }), stage);
    expect((await request('/telemetry', telemetry('position', { positionMs: 12, telemetrySequence: 1 }), stage)).statusCode).toBe(409);
    expect((await request('/telemetry', telemetry('position', { positionMs: 3_600_001, telemetrySequence: 3 }), stage)).statusCode).toBe(400);
  });

  it('lets only the presenter advance on ended and keeps exact retries from advancing twice', async () => {
    await start();
    await elapseAnchor();
    const ended = telemetry('ended');
    const first = await ok('/telemetry', ended, stage);
    expect(snapshot).toMatchObject({ segmentIndex: 1, positionMs: 0, status: 'playing' });
    expect(withoutTime(await ok('/telemetry', ended, stage))).toEqual(withoutTime(first));
    expect((await request('/telemetry', { ...ended, commandId: randomUUID() }, stage)).statusCode).toBe(409);
    await elapseAnchor();
    await ok('/telemetry', telemetry('ended', { telemetrySequence: 2 }), stage);
    expect(snapshot).toMatchObject({ status: 'complete', segmentIndex: null, anchorTimeMs: null });
    expect((await request('/telemetry', telemetry('ended', { segmentIndex: 1, telemetrySequence: 3 }), stage)).statusCode).toBe(409);
  });

  it('immediately pauses a presenter error before the future anchor while rejecting premature position and ended', async () => {
    const before = await canonical();
    await start();
    expect((await request('/telemetry', telemetry('position', { positionMs: 0 }), stage)).statusCode).toBe(409);
    expect((await request('/telemetry', telemetry('ended'), stage)).statusCode).toBe(409);
    await ok('/telemetry', telemetry('error'), stage);
    expect(snapshot).toMatchObject({ status: 'paused', positionMs: 0, anchorTimeMs: null });
    expect(await canonical()).toBe(before);
  });

  it('pauses at the confirmed position on release, error, or expiry and never resumes automatically', async () => {
    await start();
    await elapseAnchor();
    await ok('/telemetry', telemetry('position', { positionMs: 42 }), stage);
    await pool.query('UPDATE session_playback SET anchor_time_ms=$2 WHERE session_id=$1', [sessionId, Date.now() - 5000]);
    await ok('/presenter', owner('release'), stage);
    expect(snapshot).toMatchObject({ status: 'paused', positionMs: 42, anchorTimeMs: null, presenter: { available: false } });
    await claim();
    expect(snapshot.status).toBe('paused');
    await ok('/commands', command('resume'));
    await elapseAnchor();
    await ok('/telemetry', telemetry('error'), stage);
    expect(snapshot).toMatchObject({ status: 'paused', positionMs: 42, anchorTimeMs: null });
    await ok('/commands', command('resume'));
    const revision = snapshot.revision;
    await pool.query('UPDATE session_playback SET presenter_expires_at_ms=$2 WHERE session_id=$1', [sessionId, Date.now() - 1]);
    await get();
    expect(snapshot).toMatchObject({ status: 'paused', positionMs: 42, revision: revision + 1, presenter: { available: false } });
    const sample = snapshot.sampleRevision;
    await get();
    expect(snapshot.sampleRevision).toBe(sample);
    expect((await request('/presenter', owner('renew', { renewalSequence: 1 }), stage)).statusCode).toBe(409);
  });

  it('checks expiration using post-lock time and persists expiry even if a waiting renewal fails', async () => {
    await start();
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT session_id FROM session_playback WHERE session_id=$1 FOR UPDATE', [sessionId]);
    await client.query('UPDATE session_playback SET presenter_expires_at_ms=$2 WHERE session_id=$1', [sessionId, Date.now() + 150]);
    const waiting = request('/presenter', owner('renew', { renewalSequence: 1 }), stage);
    const responsePromise = waiting.then(response => response);
    await awaitPlaybackLock();
    await pool.query('SELECT pg_sleep(0.2)');
    await client.query('COMMIT'); client.release();
    expect((await responsePromise).statusCode).toBe(409);
    expect((await get()).presenter.available).toBe(false);
    expect(snapshot.status).toBe('paused');
  });

  it('reauthenticates a waiting presenter after the row lock before accepting revoked credentials', async () => {
    await start();
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT session_id FROM session_playback WHERE session_id=$1 FOR UPDATE', [sessionId]);
    const waiting = request('/presenter', owner('renew', { renewalSequence: 1 }), stage).then(response => response);
    await awaitPlaybackLock();
    const token = stage.slice(stage.indexOf('=') + 1);
    await pool.query('UPDATE credentials SET revoked_at=clock_timestamp() WHERE token_hash=$1', [createHash('sha256').update(decodeURIComponent(token)).digest('hex')]);
    await client.query('COMMIT'); client.release();
    expect((await waiting).statusCode).toBe(401);
  });

  it('preserves the playback epoch and unexpired presenter through application reconstruction', async () => {
    await start();
    const prior = snapshot;
    await app.close();
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    await get();
    expect({ ...snapshot, serverTimeMs: 0 }).toEqual({ ...prior, serverTimeMs: 0 });
    expect((await request('/presenter', { commandId: randomUUID(), expectedRevision: snapshot.revision, type: 'claim', clientId: randomUUID() })).statusCode).toBe(409);
    await pool.query('UPDATE session_playback SET presenter_expires_at_ms=$2 WHERE session_id=$1', [sessionId, Date.now() - 1]);
    await get();
    expect(snapshot).toMatchObject({ status: 'paused', playbackId: prior.playbackId, presenter: { available: false } });
  });
});
