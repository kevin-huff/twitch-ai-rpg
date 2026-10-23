import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { SessionOperationsSchema, type SessionOperations, type Beat, type SessionState } from '@rpg/contracts';
import { transaction } from './database';
import { AppError, authorize, currentBeat, readState, type Actor } from './repository';

type AttemptKind = 'plan' | 'render' | 'speech';
type AttemptStatus = 'succeeded' | 'failed' | 'interrupted';
type Database = Pick<PoolClient, 'query'>;
const partialSessions = new Set<string>();
const attemptSessions = new Map<string, string>();
export function markUsagePartial(sessionId: string) { partialSessions.add(sessionId); }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (value: Date | string) => new Date(value).toISOString();
interface OperationsOptions {
  pool: Pool;
  authenticate(request: FastifyRequest, client?: PoolClient): Promise<Actor>;
  speechConfigured: boolean;
  model: string;
  voiceId: string;
  voices?: Record<string, string>;
}
async function coverage(client: Database, sessionId: string) {
  await client.query('INSERT INTO session_usage_coverage(session_id,partial) VALUES($1,$2) ON CONFLICT(session_id) DO UPDATE SET partial=session_usage_coverage.partial OR excluded.partial', [sessionId, partialSessions.has(sessionId)]);
}
async function writeUsage(pool: Pool, sessionId: string, action: () => Promise<void>) {
  try { await coverage(pool, sessionId); await action(); }
  catch { partialSessions.add(sessionId); }
}

export async function startUsageAttempt(pool: Pool, input: { sessionId: string; beatId: string; operationId: string; kind: AttemptKind; characters?: number; timeoutMs: number }): Promise<string | null> {
  const id = randomUUID();
  let recorded = false;
  await writeUsage(pool, input.sessionId, async () => {
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || !Number.isSafeInteger(input.characters ?? 0) || (input.characters ?? 0) < 0) throw new Error('Invalid usage measurement.');
    await pool.query('INSERT INTO usage_attempts(id,session_id,beat_id,operation_id,kind,deadline_at,characters) VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6*interval \'1 millisecond\',$7)', [id, input.sessionId, input.beatId, input.operationId, input.kind, input.timeoutMs, input.characters ?? 0]);
    attemptSessions.set(id, input.sessionId); recorded = true;
  });
  return recorded ? id : null;
}
export async function finishUsageAttempt(pool: Pool, input: { attemptId: string | null; status: AttemptStatus }): Promise<void> {
  if (!input.attemptId) return;
  let sessionId = attemptSessions.get(input.attemptId);
  try {
    if (!sessionId) sessionId = (await pool.query('SELECT session_id FROM usage_attempts WHERE id=$1', [input.attemptId])).rows[0]?.session_id;
    if (!sessionId) return;
    await writeUsage(pool, sessionId, async () => {
      await pool.query('INSERT INTO usage_attempt_results(attempt_id,status) VALUES($1,$2) ON CONFLICT(attempt_id) DO NOTHING', [input.attemptId, input.status]);
    });
  } catch { if (sessionId) partialSessions.add(sessionId); }
  finally { attemptSessions.delete(input.attemptId); }
}
export async function recordSpeechHit(pool: Pool, input: { sessionId: string; beatId: string; operationId: string; kind: 'cache' | 'shared' }): Promise<void> {
  await writeUsage(pool, input.sessionId, async () => {
    await pool.query('INSERT INTO speech_reuse(id,session_id,beat_id,operation_id,kind) VALUES($1,$2,$3,$4,$5)', [randomUUID(), input.sessionId, input.beatId, input.operationId, input.kind]);
  });
}

function draftBinding(beat: Beat | null, state: SessionState, options: OperationsOptions) {
  if (!beat?.draft || beat.phase !== 'draft_review' || !beat.resolution || beat.sourceStateRevision !== state.session.stateRevision || state.session.status === 'ended') return null;
  const lines = beat.draft.segments.map(segment => {
    const npc = segment.kind === 'npc_dialogue' ? state.npcs.find(npc => npc.id === segment.speakerNpcId) : undefined;
    return { kind: segment.kind, text: segment.text, speaker: npc?.displayName ?? 'Narrator', voiceProfileId: npc?.voiceProfileId ?? 'voice_narrator', delivery: segment.delivery };
  });
  return { sourceHash: hash(lines), configHash: hash({ model: options.model, voiceId: options.voiceId, voices: options.voices ?? {}, segments: lines }) };
}
function speechStatus(row: any, now: number): 'preparing' | 'ready' | 'failed' | 'expired' {
  return row.status === 'preparing' && new Date(row.lease_until).getTime() <= now ? 'expired' : row.status;
}
function speechCounts(row: any) {
  const ready = row?.status === 'ready' && Array.isArray(row.manifest?.segments) ? row.manifest.segments.length : null;
  const totalSegments = ready ?? Number(row?.total_segments ?? 0);
  return { completedSegments: ready ?? Math.min(Number(row?.completed_segments ?? 0), totalSegments), totalSegments };
}
function speechProgress(row: any, beatId: string, kind: 'draft_audio' | 'published_audio', now: number): SessionOperations['progress'][number] | null {
  const started = kind === 'draft_audio' ? row.created_at : row.started_at;
  if (!started) return null;
  const status = speechStatus(row, now);
  const counts = speechCounts(row), total = counts.totalSegments || null;
  return { id: row.id ?? row.lease_id, beatId, kind, status: status === 'preparing' ? 'running' : status === 'ready' ? 'succeeded' : status,
    startedAt: iso(started), finishedAt: status === 'preparing' ? null : iso(row.finished_at ?? (status === 'expired' ? row.lease_until : row.updated_at)),
    completedSegments: total === null ? null : counts.completedSegments, totalSegments: total };
}
const emptyCounts = () => ({ attempts: 0, succeeded: 0, failed: 0, pending: 0, interrupted: 0 });

export function registerOperations(app: FastifyInstance, options: OperationsOptions) {
  const { pool, authenticate } = options;
  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/operations', async request => {
    const initial = await authenticate(request);
    return transaction(pool, async client => {
      const sessionId = request.params.sessionId;
      await authorize(client, sessionId, initial);
      await client.query('SELECT id FROM sessions WHERE id=$1 FOR SHARE', [sessionId]);
      const actor = await authenticate(request, client);
      await authorize(client, sessionId, actor);
      if (actor.role !== 'host') throw new AppError(403, 'forbidden', 'Only the owning director can inspect operations.');
      await coverage(client, sessionId);
      const sampled = (await client.query('SELECT clock_timestamp() AS sampled_at,(SELECT since FROM usage_tracking) AS since,(SELECT partial FROM session_usage_coverage WHERE session_id=$1) AS partial,(SELECT max(created_at) FROM audit_events WHERE session_id=$1) AS last_saved_at', [sessionId])).rows[0];
      const now = new Date(sampled.sampled_at).getTime();
      const beat = await currentBeat(client, sessionId), state = await readState(client, sessionId);
      const jobs = beat ? (await client.query(`SELECT j.*,a.deadline_at FROM generation_jobs j LEFT JOIN LATERAL
        (SELECT deadline_at FROM usage_attempts WHERE session_id=j.session_id AND operation_id=j.id AND kind=j.task ORDER BY started_at DESC LIMIT 1) a ON true
        WHERE j.session_id=$1 AND j.beat_id=$2 AND j.generation=$3 ORDER BY j.created_at DESC LIMIT 10`, [sessionId, beat.id, beat.generation])).rows : [];
      const progress: SessionOperations['progress'] = jobs.map(job => {
        const expired = ['queued', 'running'].includes(job.status) && job.deadline_at && new Date(job.deadline_at).getTime() <= now;
        return { id: job.id, beatId: job.beat_id, kind: job.task, status: expired ? 'expired' : job.status === 'queued' ? 'running' : job.status,
          startedAt: iso(job.created_at), finishedAt: job.finished_at ? iso(job.finished_at) : expired ? iso(job.deadline_at) : null, completedSegments: null, totalSegments: null };
      });
      let draft: SessionOperations['speech']['draft'] = null;
      const binding = draftBinding(beat, state, options);
      if (beat && binding && !jobs.some(job => job.task === 'render' && ['queued', 'running'].includes(job.status))) {
        const row = (await client.query('SELECT * FROM draft_audio_preparations WHERE session_id=$1 AND beat_id=$2 AND draft_revision=$3 AND generation=$4 AND source_hash=$5 AND config_hash=$6 ORDER BY created_at DESC LIMIT 1', [sessionId, beat.id, beat.draftRevision, beat.generation, binding.sourceHash, binding.configHash])).rows[0];
        draft = { beatId: beat.id, status: row ? speechStatus(row, now) : options.speechConfigured ? 'missing' : 'unavailable', ...speechCounts(row) };
        if (row) { const item = speechProgress(row, beat.id, 'draft_audio', now); if (item) progress.push(item); }
      }
      let published: SessionOperations['speech']['published'] = null;
      const publication = (await client.query('SELECT id,data FROM published_beats WHERE session_id=$1 ORDER BY beat_number DESC LIMIT 1', [sessionId])).rows[0];
      if (publication) {
        const key = publication.data.audioManifestKey;
        const row = (await client.query(`SELECT * FROM audio_manifests WHERE session_id=$1 AND beat_id=$2 ${key ? 'AND config_hash=$3' : ''} ORDER BY (status='ready') DESC,updated_at DESC LIMIT 1`, key ? [sessionId, publication.id, key] : [sessionId, publication.id])).rows[0];
        published = { beatId: publication.id, status: row ? speechStatus(row, now) : options.speechConfigured ? 'missing' : 'unavailable', ...speechCounts(row) };
        if (row) { const item = speechProgress(row, publication.id, 'published_audio', now); if (item) progress.push(item); }
      }
      const failures: SessionOperations['failures'] = [];
      const failedAttempts = await client.query("SELECT a.id,a.kind,r.occurred_at FROM usage_attempts a JOIN usage_attempt_results r ON r.attempt_id=a.id WHERE a.session_id=$1 AND r.status='failed' ORDER BY r.occurred_at DESC LIMIT 5", [sessionId]);
      const failureMessages = { plan: 'Planning failed. Retry planning or use the manual controls.', render: 'Narration drafting failed. Retry or save a manual script.', speech: 'Speech preparation failed. Retry it or publish text only.' };
      for (const attempt of failedAttempts.rows) failures.push({ id: attempt.id, kind: attempt.kind, occurredAt: iso(attempt.occurred_at), message: failureMessages[attempt.kind as AttemptKind] });
      const failedJobs = await client.query(`SELECT j.id,j.task,coalesce(j.finished_at,j.created_at) AS occurred_at FROM generation_jobs j WHERE j.session_id=$1 AND j.status='failed'
        AND NOT EXISTS (SELECT 1 FROM usage_attempts a JOIN usage_attempt_results r ON r.attempt_id=a.id WHERE a.session_id=j.session_id AND a.operation_id=j.id AND r.status='failed')
        ORDER BY occurred_at DESC LIMIT 5`, [sessionId]);
      for (const job of failedJobs.rows) failures.push({ id: job.id, kind: job.task, occurredAt: iso(job.occurred_at), message: job.task === 'plan' ? 'Planning failed. Retry planning or use the manual controls.' : 'Narration drafting failed. Retry or save a manual script.' });
      const failedSpeech = await client.query(`SELECT p.id::text AS id,coalesce(p.finished_at,p.updated_at) AS occurred_at FROM draft_audio_preparations p WHERE p.session_id=$1 AND p.status='failed'
        AND NOT EXISTS (SELECT 1 FROM usage_attempts a JOIN usage_attempt_results r ON r.attempt_id=a.id WHERE a.session_id=p.session_id AND a.operation_id=p.id::text AND r.status='failed')
        UNION ALL SELECT m.lease_id,coalesce(m.finished_at,m.updated_at) FROM audio_manifests m WHERE m.session_id=$1 AND m.status='failed'
        AND NOT EXISTS (SELECT 1 FROM usage_attempts a JOIN usage_attempt_results r ON r.attempt_id=a.id WHERE a.session_id=m.session_id AND a.operation_id=m.lease_id AND r.status='failed')
        ORDER BY occurred_at DESC LIMIT 5`, [sessionId]);
      for (const row of failedSpeech.rows) failures.push({ id: row.id, kind: 'speech', occurredAt: iso(row.occurred_at), message: 'Speech preparation failed. Retry it or publish text only.' });
      const ai = emptyCounts(), speech = { ...emptyCounts(), characters: 0, cacheHits: 0, sharedHits: 0 };
      const attempts = await client.query("WITH measured AS (SELECT a.kind,a.characters,CASE WHEN r.status IS NOT NULL THEN r.status WHEN a.deadline_at<=clock_timestamp() THEN 'interrupted' ELSE 'pending' END AS outcome FROM usage_attempts a LEFT JOIN usage_attempt_results r ON r.attempt_id=a.id WHERE a.session_id=$1) SELECT kind,outcome,count(*)::bigint AS count,sum(characters)::bigint AS characters FROM measured GROUP BY kind,outcome", [sessionId]);
      for (const attempt of attempts.rows) {
        const counts = attempt.kind === 'speech' ? speech : ai;
        counts.attempts += Number(attempt.count); counts[attempt.outcome as 'succeeded' | 'failed' | 'pending' | 'interrupted'] += Number(attempt.count);
        if (attempt.kind === 'speech') speech.characters += Number(attempt.characters);
      }
      const reuse = await client.query('SELECT kind,count(*)::integer AS count FROM speech_reuse WHERE session_id=$1 GROUP BY kind', [sessionId]);
      for (const row of reuse.rows) if (row.kind === 'cache') speech.cacheHits = row.count; else speech.sharedHits = row.count;
      return SessionOperationsSchema.parse({ sessionId, sampledAt: iso(sampled.sampled_at), lastSavedAt: sampled.last_saved_at ? iso(sampled.last_saved_at) : null,
        limits: { ai: 'unlimited', speech: 'unlimited' }, progress: progress.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 10),
        speech: { configured: options.speechConfigured, draft, published }, failures: failures.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 5),
        usage: { since: iso(sampled.since), partial: sampled.partial || partialSessions.has(sessionId), ai, speech, inputTokens: null, outputTokens: null, costUsd: null } });
    });
  });
}
