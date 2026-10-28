import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { isSpokenSegmentKind, PublishedBeatSchema, spokenText } from '@rpg/contracts';
import { cachedSpeech, saveSpeechProgress } from './draft-audio';
import { transaction } from './database';
import { AppError, authorize, type Actor } from './repository';
import { digest } from './commands';

export interface SpeechEngine {
  synthesize(input: { text: string; voiceProfileId: string }): Promise<{ bytes: Uint8Array; contentType: string }>;
}
interface AudioOptions {
  pool: Pool;
  authenticate(request: FastifyRequest, client?: PoolClient): Promise<Actor>;
  provider?: SpeechEngine;
  model: string;
  voiceId: string;
  voices?: Record<string, string>;
  assetDir: string;
}
type AudioParams = { sessionId: string; beatId: string };
interface Manifest { beatId: string; segments: Array<{ id: string; text: string; speaker: string; voiceProfileId: string; url: string }> }

export function registerAudio(app: FastifyInstance, options: AudioOptions) {
  const { pool, authenticate } = options;
  const check = async (request: FastifyRequest<{ Params: AudioParams }>) => {
    const actor = await authenticate(request);
    const publication = await transaction(pool, async client => {
      await authorize(client, request.params.sessionId, actor);
      const result = await client.query('SELECT data FROM published_beats WHERE session_id=$1 AND id=$2', [request.params.sessionId, request.params.beatId]);
      if (!result.rowCount) throw new AppError(404, 'not_found', 'Only published beats can have narration prepared.');
      return PublishedBeatSchema.parse(result.rows[0].data);
    });
    return { actor, publication };
  };
  app.get<{ Params: AudioParams }>('/api/sessions/:sessionId/audio/:beatId', async request => {
    const { publication } = await check(request);
    const result = await pool.query('SELECT status,manifest,lease_until FROM audio_manifests WHERE session_id=$1 AND beat_id=$2 AND ($3::text IS NULL OR config_hash=$3) ORDER BY (status=\'ready\') DESC,updated_at DESC LIMIT 1', [request.params.sessionId, request.params.beatId, publication.audioManifestKey ?? null]);
    const row = result.rows[0];
    if (row?.status === 'ready') return { status: 'ready', manifest: row.manifest };
    if (row?.status === 'preparing' && new Date(row.lease_until).getTime() > Date.now()) return { status: 'preparing' };
    return { status: options.provider ? 'missing' : 'unavailable' };
  });
  app.post<{ Params: AudioParams }>('/api/sessions/:sessionId/audio/:beatId', async request => {
    z.strictObject({ commandId: z.string().min(1).max(128) }).parse(request.body);
    const { actor, publication } = await check(request);
    if (actor.role !== 'host') throw new AppError(403, 'forbidden', 'Only the director can prepare narration.');
    if (publication.audioManifestKey) {
      const selected = await pool.query("SELECT manifest FROM audio_manifests WHERE session_id=$1 AND beat_id=$2 AND config_hash=$3 AND status='ready'", [request.params.sessionId, request.params.beatId, publication.audioManifestKey]);
      if (!selected.rowCount) throw new AppError(409, 'audio_missing', 'The reviewed recording is unavailable. Continue with the published text.');
      return { status: 'ready', manifest: selected.rows[0].manifest };
    }
    if (!options.provider) throw new AppError(503, 'speech_disabled', 'Speech is not configured. Continue with the published text.');
    const { sessionId, beatId } = request.params;
    const configHash = digest({ model: options.model, voiceId: options.voiceId, voices: options.voices ?? {}, segments: publication.segments });
    const segments = publication.segments.filter(segment => isSpokenSegmentKind(segment.kind));
    const lease = randomUUID();
    const acquired = await transaction(pool, async client => {
      const result = await client.query(`INSERT INTO audio_manifests(session_id,beat_id,config_hash,status,lease_id,lease_until,started_at,total_segments)
        VALUES($1,$2,$3,'preparing',$4,clock_timestamp()+interval '5 minutes',clock_timestamp(),$5)
        ON CONFLICT(session_id,beat_id,config_hash) DO UPDATE SET status='preparing',lease_id=excluded.lease_id,lease_until=excluded.lease_until,updated_at=clock_timestamp(),started_at=excluded.started_at,finished_at=NULL,completed_segments=0,total_segments=excluded.total_segments
        WHERE audio_manifests.status='failed' OR (audio_manifests.status='preparing' AND audio_manifests.lease_until<clock_timestamp()) RETURNING lease_id`, [sessionId, beatId, configHash, lease, segments.length || null]);
      if (result.rowCount) return null;
      const row = (await client.query('SELECT status,manifest FROM audio_manifests WHERE session_id=$1 AND beat_id=$2 AND config_hash=$3', [sessionId, beatId, configHash])).rows[0];
      if (row.status === 'ready') return row.manifest as Manifest;
      throw new AppError(409, 'speech_preparing', 'Narration is already being prepared. Wait for the saved result.');
    });
    if (acquired) return { status: 'ready', manifest: acquired };
    const current = async <T>(action: (client: PoolClient) => Promise<T>) => transaction(pool, async client => {
      await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [sessionId]);
      const row = await client.query('SELECT lease_id FROM audio_manifests WHERE session_id=$1 AND beat_id=$2 AND config_hash=$3 FOR UPDATE', [sessionId, beatId, configHash]);
      const selected = await authenticate(request, client);
      await authorize(client, sessionId, selected);
      if (selected.role !== 'host' || selected.actor_id !== actor.actor_id) throw new AppError(403, 'forbidden', 'Only the owning director can prepare narration.');
      if (row.rows[0]?.lease_id !== lease || !(await client.query("SELECT 1 FROM audio_manifests WHERE session_id=$1 AND beat_id=$2 AND config_hash=$3 AND lease_id=$4 AND status='preparing' AND lease_until>clock_timestamp()", [sessionId, beatId, configHash, lease])).rowCount) throw new AppError(409, 'superseded', 'This audio preparation was superseded or expired.');
      return action(client);
    });
    try {
      const manifest: Manifest = { beatId, segments: [] };
      for (const segment of segments) {
        await current(async () => {});
        const voiceProfileId = segment.voiceProfileId ?? 'voice_narrator';
        const speaker = segment.speaker?.displayName ?? 'Narrator';
        const { assetId } = await cachedSpeech(options, { sessionId, beatId, operationId: lease, text: spokenText({ kind: segment.kind, speaker, text: segment.text }), voiceProfileId, delivery: segment.delivery });
        manifest.segments.push({ id: segment.id, text: segment.text, speaker, voiceProfileId, url: `/api/sessions/${encodeURIComponent(sessionId)}/audio/assets/${assetId}` });
        await current(client => saveSpeechProgress(client, sessionId, { kind: 'published', beatId, configHash, leaseId: lease, completed: manifest.segments.length, total: segments.length }));
      }
      await current(async client => {
        await client.query('UPDATE audio_manifests SET status=\'ready\',manifest=$5,updated_at=clock_timestamp() WHERE session_id=$1 AND beat_id=$2 AND config_hash=$3 AND lease_id=$4', [sessionId, beatId, configHash, lease, manifest]);
        if (segments.length) await saveSpeechProgress(client, sessionId, { kind: 'published', beatId, configHash, leaseId: lease, completed: segments.length, total: segments.length, finished: true });
      });
      return { status: 'ready', manifest };
    } catch {
      await pool.query('UPDATE audio_manifests SET status=\'failed\',updated_at=now() WHERE session_id=$1 AND beat_id=$2 AND config_hash=$3 AND lease_id=$4', [sessionId, beatId, configHash, lease]);
      throw new AppError(502, 'speech_failed', 'Narration could not be prepared. The published text and dice are unchanged.');
    }
  });
  app.get<{ Params: { sessionId: string; assetId: string } }>('/api/sessions/:sessionId/audio/assets/:assetId', async (request, reply) => {
    const actor = await authenticate(request);
    const { sessionId, assetId } = request.params;
    if (!/^[a-f0-9]{64}$/.test(assetId)) throw new AppError(404, 'not_found', 'Audio was not found.');
    await transaction(pool, client => authorize(client, sessionId, actor));
    const result = await pool.query(`SELECT content_type FROM audio_assets a WHERE a.session_id=$1 AND a.id=$2
      AND EXISTS (SELECT 1 FROM audio_manifests m JOIN published_beats p ON p.id=m.beat_id AND p.session_id=m.session_id
        WHERE m.session_id=a.session_id AND m.status='ready'
          AND (p.data->>'audioManifestKey' IS NULL OR p.data->>'audioManifestKey'=m.config_hash)
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.manifest->'segments') s WHERE s->>'url'=$3))`, [sessionId, assetId, `/api/sessions/${encodeURIComponent(sessionId)}/audio/assets/${assetId}`]);
    if (!result.rowCount) throw new AppError(404, 'not_found', 'Audio was not found.');
    try { return reply.header('Cache-Control', 'private, no-store').type(result.rows[0].content_type).send(await readFile(join(options.assetDir, `${assetId}.mp3`))); }
    catch { throw new AppError(404, 'audio_missing', 'The saved audio is unavailable. Continue with text.'); }
  });
}
