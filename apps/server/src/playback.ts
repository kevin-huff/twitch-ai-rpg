import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  AudioManifestSchema, isSpokenSegmentKind, MAX_PLAYBACK_POSITION_MS, PLAYBACK_SCHEDULE_LEAD_MS, PRESENTER_LEASE_MS,
  PlaybackCommandSchema, PlaybackTelemetrySchema, PresenterCommandSchema, PublishedBeatSchema,
  type AudioManifest, type PlaybackCommand, type PlaybackResponse, type PlaybackSnapshot,
  type PlaybackTelemetry, type PresenterCommand,
} from '@rpg/contracts';
import { digest } from './commands';
import { transaction } from './database';
import { AppError, authorize, conflict, type Actor } from './repository';

interface PlaybackOptions {
  pool: Pool;
  authenticate(request: FastifyRequest, client?: PoolClient): Promise<Actor>;
}
interface PlaybackRow {
  session_id: string;
  revision: number;
  sample_revision: number;
  playback_id: string | null;
  status: PlaybackSnapshot['status'];
  manifest: AudioManifest | null;
  segment_index: number | null;
  position_ms: number;
  anchor_time_ms: number | null;
  presenter_actor_id: string | null;
  presenter_client_id: string | null;
  presenter_lease_id: string | null;
  presenter_expires_at_ms: number | null;
  renewal_sequence: number;
  telemetry_sequence: number;
}
type Params = { sessionId: string };
type Mutation = PlaybackCommand | PresenterCommand | PlaybackTelemetry;
const changed = (row: PlaybackRow, discrete = true) => { row.sample_revision++; if (discrete) row.revision++; };
const pause = (row: PlaybackRow) => { row.status = 'paused'; row.anchor_time_ms = null; };
function clearPresenter(row: PlaybackRow) {
  row.presenter_actor_id = null;
  row.presenter_client_id = null;
  row.presenter_lease_id = null;
  row.presenter_expires_at_ms = null;
  row.renewal_sequence = 0;
  row.telemetry_sequence = 0;
}
function snapshot(row: PlaybackRow, now: number): PlaybackSnapshot {
  return {
    schemaVersion: 1, sessionId: row.session_id, revision: row.revision, sampleRevision: row.sample_revision,
    serverTimeMs: now, playbackId: row.playback_id, status: row.status, manifest: row.manifest,
    segmentIndex: row.segment_index, positionMs: row.position_ms, anchorTimeMs: row.anchor_time_ms,
    presenter: {
      available: row.presenter_lease_id !== null, leaseExpiresAtMs: row.presenter_expires_at_ms,
      source: row.presenter_lease_id === null ? null : row.presenter_actor_id?.startsWith('stream:') ? 'show_link' as const : 'preview' as const,
    },
  };
}
async function save(client: PoolClient, row: PlaybackRow) {
  await client.query(`UPDATE session_playback SET revision=$2,sample_revision=$3,playback_id=$4,status=$5,
    manifest=$6,segment_index=$7,position_ms=$8,anchor_time_ms=$9,presenter_actor_id=$10,presenter_client_id=$11,
    presenter_lease_id=$12,presenter_expires_at_ms=$13,renewal_sequence=$14,telemetry_sequence=$15 WHERE session_id=$1`, [
    row.session_id, row.revision, row.sample_revision, row.playback_id, row.status, row.manifest,
    row.segment_index, row.position_ms, row.anchor_time_ms, row.presenter_actor_id, row.presenter_client_id,
    row.presenter_lease_id, row.presenter_expires_at_ms, row.renewal_sequence, row.telemetry_sequence,
  ]);
}
function checkRevision(row: PlaybackRow, command: { expectedRevision: number }) {
  if (row.revision !== command.expectedRevision) conflict('Playback changed. Review the current playback state.');
}
function checkEpoch(row: PlaybackRow, command: { playbackId: string; expectedRevision: number }) {
  checkRevision(row, command);
  if (row.playback_id !== command.playbackId) conflict('This playback performance is no longer current.');
}
function checkOwner(row: PlaybackRow, actor: Actor, command: { clientId: string; leaseId: string }) {
  if (row.presenter_actor_id !== actor.actor_id || row.presenter_client_id !== command.clientId || row.presenter_lease_id !== command.leaseId) conflict('This browser no longer owns the presenter lease.');
}
function advance(row: PlaybackRow, now: number) {
  if (row.segment_index === null || !row.manifest) return conflict('Playback has no active segment.');
  row.position_ms = 0;
  if (row.segment_index + 1 >= row.manifest.segments.length) {
    row.status = 'complete'; row.segment_index = null; row.anchor_time_ms = null;
  } else {
    row.segment_index++;
    row.anchor_time_ms = row.status === 'playing' ? now + PLAYBACK_SCHEDULE_LEAD_MS : null;
  }
}
async function preparedManifest(client: PoolClient, sessionId: string, beatId: string): Promise<AudioManifest> {
  const publication = (await client.query('SELECT data FROM published_beats WHERE session_id=$1 AND id=$2', [sessionId, beatId])).rows[0];
  if (!publication) throw new AppError(404, 'not_found', 'Only published beats can be played.');
  const published = PublishedBeatSchema.safeParse(publication.data);
  const found = await client.query("SELECT manifest FROM audio_manifests WHERE session_id=$1 AND beat_id=$2 AND status='ready' AND ($3::text IS NULL OR config_hash=$3) ORDER BY updated_at DESC,config_hash LIMIT 1", [sessionId, beatId, published.success ? published.data.audioManifestKey ?? null : null]);
  const parsed = AudioManifestSchema.safeParse(found.rows[0]?.manifest);
  if (!published.success || !parsed.success || parsed.data.beatId !== beatId) return conflict('Prepare valid published narration before playing it.');
  const manifest = parsed.data;
  const spoken = published.data.segments.filter(segment => isSpokenSegmentKind(segment.kind));
  const legacy = published.data.segments.filter(segment => segment.kind === 'narration' || segment.kind === 'npc_dialogue');
  const sameIds = (list: typeof spoken) => list.length === manifest.segments.length && list.every((segment, index) => segment.id === manifest.segments[index]!.id);
  const canonical = sameIds(spoken) ? spoken : sameIds(legacy) ? legacy : conflict('The prepared narration does not match the published script.');
  const prefix = `/api/sessions/${encodeURIComponent(sessionId)}/audio/assets/`;
  for (const [index, segment] of manifest.segments.entries()) {
    const source = canonical[index]!;
    if (segment.id !== source.id || segment.text !== source.text || segment.speaker !== (source.speaker?.displayName ?? 'Narrator') || segment.voiceProfileId !== (source.voiceProfileId ?? 'voice_narrator') || !segment.url.startsWith(prefix)) conflict('The prepared narration does not match the published script.');
    const assetId = segment.url.slice(prefix.length);
    if (!/^[a-f0-9]{64}$/.test(assetId) || !(await client.query('SELECT 1 FROM audio_assets WHERE session_id=$1 AND id=$2', [sessionId, assetId])).rowCount) conflict('The prepared audio is unavailable. Prepare narration again.');
  }
  return manifest;
}

async function control(client: PoolClient, row: PlaybackRow, actor: Actor, command: PlaybackCommand, sessionStatus: string, now: number) {
  if (actor.role !== 'host') throw new AppError(403, 'forbidden', 'Only the director can control shared playback.');
  checkRevision(row, command);
  if (command.type === 'start') {
    if (sessionStatus === 'ended') conflict('An ended session cannot start playback.');
    if (!row.presenter_lease_id) conflict('Enable a presenter before starting playback.');
    const manifest = await preparedManifest(client, row.session_id, command.beatId);
    row.playback_id = randomUUID(); row.manifest = manifest; row.status = 'playing';
    row.segment_index = 0; row.position_ms = 0; row.anchor_time_ms = now + PLAYBACK_SCHEDULE_LEAD_MS;
  } else {
    checkEpoch(row, command);
    if (command.type === 'stop') {
      row.status = 'stopped'; row.segment_index = null; row.position_ms = 0; row.anchor_time_ms = null;
    } else if (command.type === 'pause') {
      if (row.status !== 'playing') conflict('Only playing narration can be paused.');
      row.position_ms = Math.min(MAX_PLAYBACK_POSITION_MS, row.position_ms + Math.max(0, now - row.anchor_time_ms!));
      pause(row);
    } else if (command.type === 'resume') {
      if (sessionStatus === 'ended' || row.status !== 'paused' || row.segment_index === null || !row.presenter_lease_id) conflict('Enable a presenter and select paused narration before resuming.');
      row.status = 'playing'; row.anchor_time_ms = now + PLAYBACK_SCHEDULE_LEAD_MS;
    } else {
      if (!['playing', 'paused'].includes(row.status)) conflict('Only active narration can skip a segment.');
      advance(row, now);
    }
  }
  changed(row);
}
function presenter(row: PlaybackRow, actor: Actor, command: PresenterCommand, now: number) {
  if (actor.role !== 'host' && actor.role !== 'stage') throw new AppError(403, 'forbidden', 'Only the director or stage can present narration.');
  if (actor.role === 'stage' && actor.can_present === false) throw new AppError(403, 'forbidden', 'This stream view can listen but cannot present the show audio.');
  if (command.type === 'claim') {
    checkRevision(row, command);
    if (row.presenter_lease_id) conflict('Another browser is already presenting narration.');
    row.presenter_actor_id = actor.actor_id; row.presenter_client_id = command.clientId;
    row.presenter_lease_id = randomUUID(); row.presenter_expires_at_ms = now + PRESENTER_LEASE_MS;
    row.renewal_sequence = 0; row.telemetry_sequence = 0;
    changed(row);
    return row.presenter_lease_id;
  }
  checkOwner(row, actor, command);
  if (command.type === 'renew') {
    if (command.renewalSequence <= row.renewal_sequence) conflict('This presenter renewal is stale.');
    row.renewal_sequence = command.renewalSequence;
    row.presenter_expires_at_ms = now + PRESENTER_LEASE_MS;
    changed(row, false);
  } else {
    clearPresenter(row);
    if (row.status === 'playing') pause(row);
    changed(row);
  }
}
function report(row: PlaybackRow, actor: Actor, command: PlaybackTelemetry, now: number) {
  checkOwner(row, actor, command);
  checkEpoch(row, command);
  if (row.status !== 'playing' || row.segment_index !== command.segmentIndex || command.telemetrySequence <= row.telemetry_sequence || row.anchor_time_ms === null || (command.type !== 'error' && now < row.anchor_time_ms)) conflict('This playback report is stale or not scheduled to play yet.');
  if (command.type === 'position' && command.positionMs < row.position_ms) conflict('Playback position cannot rewind.');
  row.telemetry_sequence = command.telemetrySequence;
  if (command.type === 'position') {
    row.position_ms = command.positionMs; row.anchor_time_ms = now;
    changed(row, false);
  } else {
    if (command.type === 'ended') advance(row, now); else pause(row);
    changed(row);
  }
}

export function registerPlayback(app: FastifyInstance, options: PlaybackOptions) {
  const { pool, authenticate } = options;
  const execute = async (request: FastifyRequest<{ Params: Params }>, endpoint: 'commands' | 'presenter' | 'telemetry' | null, command?: Mutation) => {
    const initialActor = await authenticate(request);
    const result = await transaction(pool, async client => {
      const sessionId = request.params.sessionId;
      await authorize(client, sessionId, initialActor);
      await client.query('INSERT INTO session_playback(session_id) VALUES($1) ON CONFLICT(session_id) DO NOTHING', [sessionId]);
      const row: PlaybackRow = (await client.query('SELECT * FROM session_playback WHERE session_id=$1 FOR UPDATE', [sessionId])).rows[0];
      for (const key of ['revision', 'sample_revision', 'anchor_time_ms', 'presenter_expires_at_ms', 'renewal_sequence', 'telemetry_sequence'] as const) if (row[key] !== null) row[key] = Number(row[key]);
      // Receipt keys are global to the actor, including requests for different sessions.
      if (command) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([initialActor.actor_id, command.commandId])]);
      const actor = await authenticate(request, client);
      const session = await authorize(client, sessionId, actor);
      const now = Number((await client.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms')).rows[0].now_ms);
      const priorSample = row.sample_revision;
      if (row.presenter_expires_at_ms !== null && row.presenter_expires_at_ms <= now) {
        clearPresenter(row);
        if (row.status === 'playing') pause(row);
        changed(row);
        await save(client, row);
      }
      if (!command || !endpoint) return { value: snapshot(row, now) };
      const requestHash = digest({ endpoint, sessionId, command });
      const existing = (await client.query('SELECT request_hash,response FROM playback_receipts WHERE actor_id=$1 AND command_id=$2', [actor.actor_id, command.commandId])).rows[0];
      if (existing) {
        if (existing.request_hash !== requestHash) return { error: new AppError(409, 'conflict', 'This command ID was already used with different input.') };
        const response = existing.response as PlaybackResponse;
        return { value: { ...response, snapshot: { ...response.snapshot, serverTimeMs: now } } };
      }
      try {
        let leaseId: string | undefined;
        if (endpoint === 'commands') await control(client, row, actor, command as PlaybackCommand, session.status, now);
        else if (endpoint === 'presenter') leaseId = presenter(row, actor, command as PresenterCommand, now);
        else report(row, actor, command as PlaybackTelemetry, now);
        if (row.sample_revision !== priorSample) await save(client, row);
        const response: PlaybackResponse = { snapshot: snapshot(row, now), ...(leaseId ? { leaseId } : {}) };
        await client.query('INSERT INTO playback_receipts(actor_id,command_id,request_hash,session_id,response) VALUES($1,$2,$3,$4,$5)', [actor.actor_id, command.commandId, requestHash, sessionId, response]);
        return { value: response };
      } catch (error) {
        // Lease expiry is durable even when the following command is rejected.
        if (error instanceof AppError) return { error };
        throw error;
      }
    });
    if ('error' in result) throw result.error;
    return result.value;
  };
  app.get<{ Params: Params }>('/api/sessions/:sessionId/playback', request => execute(request, null));
  app.post<{ Params: Params }>('/api/sessions/:sessionId/playback/commands', request => execute(request, 'commands', PlaybackCommandSchema.parse(request.body)));
  app.post<{ Params: Params }>('/api/sessions/:sessionId/playback/presenter', request => execute(request, 'presenter', PresenterCommandSchema.parse(request.body)));
  app.post<{ Params: Params }>('/api/sessions/:sessionId/playback/telemetry', request => execute(request, 'telemetry', PlaybackTelemetrySchema.parse(request.body)));
}
