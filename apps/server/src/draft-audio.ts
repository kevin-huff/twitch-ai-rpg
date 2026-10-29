import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  BeatSchema, DraftAudioManifestSchema, MAX_SPOKEN_SEGMENTS, PrepareDraftAudioSchema, elevenVoiceId, isSpokenSegmentKind, spokenText,
  type AudioManifest, type Beat, type DraftAudioManifest, type DraftAudioResponse, type PrepareDraftAudio,
  type ScriptSegment, type SessionState,
} from '@rpg/contracts';
import { ProviderError, speechCacheKey } from '@rpg/providers';
import type { SpeechEngine } from './audio';
import { transaction } from './database';
import { AppError, authorize, currentBeat, readState, type Actor } from './repository';
import { finishUsageAttempt, markUsagePartial, recordSpeechHit, startUsageAttempt } from './operations';
import { makeScript, speechLines, voicedLines, type SpeechLine } from './script';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = (message: string): never => { throw new AppError(409, 'conflict', message); };
// A conflict that means the saved draft changed under a running preparation (a re-draft, an edit, an abort), which is no speech failure.
export class DraftChangedError extends AppError { constructor(message: string) { super(409, 'conflict', message); } }
const changed = (message: string): never => { throw new DraftChangedError(message); };
type Delivery = ScriptSegment['delivery'];
export interface SpeechCacheOptions {
  pool: Pool;
  provider?: SpeechEngine;
  model: string;
  voiceId: string;
  voices?: Record<string, string>;
  assetDir: string;
}
interface DraftAudioOptions extends SpeechCacheOptions {
  authenticate(request: FastifyRequest, client?: PoolClient): Promise<Actor>;
}
interface CachedLine extends SpeechLine { assetId?: string }
interface Preparation {
  id: string; session_id: string; beat_id: string; draft_revision: number; generation: number;
  source_hash: string; config_hash: string; status: 'preparing' | 'ready' | 'failed';
  lease_until: Date; segments: CachedLine[]; manifest: DraftAudioManifest | null;
}
interface Context { beat: Beat; state: SessionState; lines: SpeechLine[]; voiced: SpeechLine[]; sourceHash: string }
type Params = { sessionId: string; beatId: string };
type Asset = { assetId: string; contentType: string; byteLength: number };
const pendingAssets = new Map<string, Promise<Asset>>();

export async function cachedSpeech(options: SpeechCacheOptions, input: { sessionId: string; beatId: string; operationId: string; text: string; voiceProfileId: string; delivery: Delivery }): Promise<Asset> {
  const assetId = speechCacheKey({ sessionId: input.sessionId, text: input.text, provider: 'elevenlabs', model: options.model, voiceId: elevenVoiceId(input.voiceProfileId) ?? options.voices?.[input.voiceProfileId] ?? options.voiceId, delivery: input.delivery });
  const flightKey = `${resolve(options.assetDir)}\0${assetId}`;
  const existing = pendingAssets.get(flightKey);
  if (existing) {
    const asset = await existing;
    await recordSpeechHit(options.pool, { ...input, kind: 'shared' });
    return asset;
  }
  const pending = (async () => {
    await mkdir(options.assetDir, { recursive: true });
    const path = join(options.assetDir, `${assetId}.mp3`);
    let saved;
    try { saved = await stat(path); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
    const cacheHit = Boolean(saved);
    if (!saved) {
      if (!options.provider) throw new AppError(503, 'speech_disabled', 'Speech is not configured. Continue with the saved text.');
      const attemptId = await startUsageAttempt(options.pool, { ...input, kind: 'speech', characters: [...input.text].length, timeoutMs: 45_000 });
      let audio;
      try {
        audio = await options.provider.synthesize({ text: input.text, voiceProfileId: input.voiceProfileId });
        await finishUsageAttempt(options.pool, { attemptId, status: 'succeeded' });
      } catch (error) {
        await finishUsageAttempt(options.pool, { attemptId, status: 'failed' });
        throw error;
      }
      if (audio.contentType !== 'audio/mpeg' || !audio.bytes.byteLength || audio.bytes.byteLength > 20 * 1024 * 1024) throw new Error('Unexpected speech response.');
      const temporary = join(options.assetDir, `${assetId}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, audio.bytes, { mode: 0o600, flag: 'wx' });
        try { await link(temporary, path); }
        catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error; }
      } finally { await unlink(temporary).catch(() => {}); }
      saved = await stat(path);
    }
    if (!saved.isFile() || !saved.size || saved.size > 20 * 1024 * 1024) throw new Error('The cached speech is invalid.');
    await options.pool.query("INSERT INTO audio_assets(id,session_id,content_type,byte_length) VALUES($1,$2,'audio/mpeg',$3) ON CONFLICT(id) DO NOTHING", [assetId, input.sessionId, saved.size]);
    if (cacheHit) await recordSpeechHit(options.pool, { ...input, kind: 'cache' });
    return { assetId, contentType: 'audio/mpeg', byteLength: saved.size };
  })();
  pendingAssets.set(flightKey, pending);
  try { return await pending; }
  finally { if (pendingAssets.get(flightKey) === pending) pendingAssets.delete(flightKey); }
}

export async function speakLine(options: SpeechCacheOptions, base: { sessionId: string; beatId: string; operationId: string }, line: { kind: string; speaker: string; text: string; voiceText?: string; delivery: Delivery; voiceProfileId: string }): Promise<{ asset: Asset; voiceProfileId: string }> {
  const speak = (voiceProfileId: string) => cachedSpeech(options, { ...base, text: spokenText({ ...line, voiceProfileId }), voiceProfileId, delivery: line.delivery });
  try { return { asset: await speak(line.voiceProfileId), voiceProfileId: line.voiceProfileId }; }
  catch (error) {
    if (!(error instanceof ProviderError && error.reason === 'voice_missing') || line.voiceProfileId === 'voice_narrator') throw error;
    return { asset: await speak('voice_narrator'), voiceProfileId: 'voice_narrator' };
  }
}

export async function saveSpeechProgress(client: PoolClient, sessionId: string, input: { kind: 'draft'; id: string; completed: number; total: number; finished?: boolean } | { kind: 'published'; beatId: string; configHash: string; leaseId: string; completed: number; total: number; finished?: boolean }) {
  await client.query('SAVEPOINT speech_progress');
  try {
    if (input.kind === 'draft') await client.query('UPDATE draft_audio_preparations SET completed_segments=$2,total_segments=$3,finished_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END WHERE id=$1', [input.id, input.completed, input.total, Boolean(input.finished)]);
    else await client.query('UPDATE audio_manifests SET completed_segments=$5,total_segments=$6,finished_at=CASE WHEN $7 THEN clock_timestamp() ELSE NULL END WHERE session_id=$1 AND beat_id=$2 AND config_hash=$3 AND lease_id=$4', [sessionId, input.beatId, input.configHash, input.leaseId, input.completed, input.total, Boolean(input.finished)]);
    await client.query('RELEASE SAVEPOINT speech_progress');
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT speech_progress');
    await client.query('RELEASE SAVEPOINT speech_progress');
    markUsagePartial(sessionId);
  }
}

function speechSegments(beat: Beat, state: SessionState): ScriptSegment[] {
  if (beat.phase !== 'draft_review' || !beat.draft || !beat.resolution || beat.sourceStateRevision !== state.session.stateRevision || state.session.status === 'ended') return changed('Review a current saved script before preparing or publishing narration.');
  for (const segment of beat.draft.segments) {
    if (segment.kind === 'npc_dialogue' && !state.npcs.find(npc => npc.id === segment.speakerNpcId)) return changed('The saved speaker is unavailable.');
  }
  return makeScript(beat, state);
}
async function noCurrentRender(client: PoolClient, beat: Beat) {
  if ((await client.query("SELECT 1 FROM generation_jobs WHERE beat_id=$1 AND generation=$2 AND task='render' AND status IN ('queued','running')", [beat.id, beat.generation])).rowCount) changed('Wait for the current narration draft to finish before preparing or publishing it.');
}
async function context(client: PoolClient, sessionId: string, beatId: string): Promise<Context> {
  const candidate = await currentBeat(client, sessionId);
  const parsed = BeatSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.id !== beatId) return changed('This saved draft is no longer current.');
  const beat = parsed.data, state = await readState(client, sessionId);
  await noCurrentRender(client, beat);
  const segments = speechSegments(beat, state);
  const lines = speechLines(segments);
  if (!lines.length || lines.length > MAX_SPOKEN_SEGMENTS) return changed('Save narration before preparing speech.');
  return { beat, state, lines, voiced: voicedLines(segments), sourceHash: hash(lines) };
}
function matches(preparation: Preparation, current: Context) {
  return preparation.beat_id === current.beat.id && preparation.draft_revision === current.beat.draftRevision && preparation.generation === current.beat.generation && preparation.source_hash === current.sourceHash;
}
async function response(client: PoolClient, preparation: Preparation): Promise<DraftAudioResponse> {
  if (preparation.status === 'preparing' && (await client.query('SELECT $1::timestamptz > clock_timestamp() AS active', [preparation.lease_until])).rows[0].active === false) {
    await client.query("UPDATE draft_audio_preparations SET status='failed',updated_at=clock_timestamp() WHERE id=$1", [preparation.id]);
    preparation.status = 'failed';
  }
  if (preparation.status === 'ready') return { status: 'ready', manifest: DraftAudioManifestSchema.parse(preparation.manifest) };
  return { status: preparation.status, preparationId: preparation.id };
}

export async function attachPreparedAudio(client: PoolClient, input: { sessionId: string; beat: Beat; state: SessionState; segments: ScriptSegment[]; preparationId: string }): Promise<{ configHash: string; manifest: AudioManifest }> {
  const current = await context(client, input.sessionId, input.beat.id);
  if (input.beat.draftRevision !== current.beat.draftRevision || input.beat.generation !== current.beat.generation) return conflict('The selected saved draft changed.');
  const preparation: Preparation | undefined = (await client.query('SELECT * FROM draft_audio_preparations WHERE id=$1 AND session_id=$2 AND beat_id=$3', [input.preparationId, input.sessionId, input.beat.id])).rows[0];
  if (!preparation || !matches(preparation, current) || preparation.status !== 'ready') return conflict('Prepare and review the current saved narration before publishing it with audio.');
  const saved = input.segments.filter(segment => isSpokenSegmentKind(segment.kind));
  const projection = speechLines(input.segments);
  if (hash(projection) !== current.sourceHash || saved.length !== preparation.segments.length) return conflict('The selected recording does not match the publication.');
  const manifest: AudioManifest = { beatId: input.beat.id, segments: [] };
  for (const [index, segment] of saved.entries()) {
    const cached = preparation.segments[index]!;
    if (!cached.assetId || !(await client.query('SELECT 1 FROM audio_assets WHERE id=$1 AND session_id=$2', [cached.assetId, input.sessionId])).rowCount) return conflict('The selected recording is unavailable.');
    manifest.segments.push({ id: segment.id, text: segment.text, speaker: cached.speaker, voiceProfileId: cached.voiceProfileId, url: `/api/sessions/${encodeURIComponent(input.sessionId)}/audio/assets/${cached.assetId}` });
  }
  for (const [index, segment] of saved.entries()) {
    if (segment.kind === 'player_dialogue') segment.voiceProfileId = elevenVoiceId(preparation.segments[index]!.voiceProfileId) ? preparation.segments[index]!.voiceProfileId : null;
  }
  return { configHash: hash({ preparationId: preparation.id, configHash: preparation.config_hash, sourceHash: preparation.source_hash }), manifest };
}

export function registerDraftAudio(app: FastifyInstance, options: DraftAudioOptions) {
  const { pool, authenticate } = options;
  const locked = async <T>(request: FastifyRequest<{ Params: Params }>, action: (client: PoolClient, current: Context, actor: Actor) => Promise<T>, commandId?: string) => {
    const initial = await authenticate(request);
    return transaction(pool, async client => {
      const { sessionId, beatId } = request.params;
      await authorize(client, sessionId, initial);
      await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [sessionId]);
      if (commandId) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['draft-audio', initial.actor_id, commandId])]);
      const actor = await authenticate(request, client);
      if (actor.actor_id !== initial.actor_id || actor.role !== initial.role) throw new AppError(401, 'unauthorized', 'This credential changed. Sign in again.');
      await authorize(client, sessionId, actor);
      if (actor.role !== 'host') throw new AppError(403, 'forbidden', 'Only the owning director can review private draft narration.');
      return action(client, await context(client, sessionId, beatId), actor);
    });
  };
  const config = (current: Context) => hash({ model: options.model, voiceId: options.voiceId, voices: options.voices ?? {}, segments: current.lines });
  const latest = async (client: PoolClient, current: Context) => (await client.query('SELECT * FROM draft_audio_preparations WHERE session_id=$1 AND beat_id=$2 AND draft_revision=$3 AND generation=$4 AND source_hash=$5 AND config_hash=$6 ORDER BY created_at DESC LIMIT 1', [current.beat.sessionId, current.beat.id, current.beat.draftRevision, current.beat.generation, current.sourceHash, config(current)])).rows[0] as Preparation | undefined;

  app.get<{ Params: Params }>('/api/sessions/:sessionId/beats/:beatId/draft-audio', request => locked(request, async (client, current) => {
    const preparation = await latest(client, current);
    return preparation ? response(client, preparation) : { status: options.provider ? 'missing' : 'unavailable' };
  }));
  app.post<{ Params: Params }>('/api/sessions/:sessionId/beats/:beatId/draft-audio', async request => {
    const command: PrepareDraftAudio = PrepareDraftAudioSchema.parse(request.body);
    const acquired = await locked(request, async (client, current, actor) => {
      const requestHash = hash({ sessionId: request.params.sessionId, beatId: request.params.beatId, command });
      const receipt = (await client.query('SELECT request_hash,preparation_id FROM draft_audio_receipts WHERE actor_id=$1 AND command_id=$2', [actor.actor_id, command.commandId])).rows[0];
      if (receipt && receipt.request_hash !== requestHash) return conflict('This command ID was already used with different input.');
      if (receipt) {
        const preparation: Preparation = (await client.query('SELECT * FROM draft_audio_preparations WHERE id=$1', [receipt.preparation_id])).rows[0];
        if (!matches(preparation, current)) return conflict('This recording belongs to an obsolete saved draft.');
        return { result: await response(client, preparation) };
      }
      if (command.expectedBeatRevision !== current.beat.revision || command.draftRevision !== current.beat.draftRevision || command.generation !== current.beat.generation) return conflict('The saved draft changed. Reload it before preparing narration.');
      let preparation = await latest(client, current);
      if (preparation) await response(client, preparation);
      let start = false;
      if (!preparation || preparation.status === 'failed') {
        if (!options.provider) throw new AppError(503, 'speech_disabled', 'Speech is not configured. Continue with the saved text.');
        const id = randomUUID();
        preparation = (await client.query("INSERT INTO draft_audio_preparations(id,session_id,beat_id,draft_revision,generation,source_hash,config_hash,status,lease_until,segments,total_segments) VALUES($1,$2,$3,$4,$5,$6,$7,'preparing',clock_timestamp()+interval '5 minutes',$8,$9) RETURNING *", [id, request.params.sessionId, current.beat.id, current.beat.draftRevision, current.beat.generation, current.sourceHash, config(current), JSON.stringify(current.voiced), current.voiced.length])).rows[0];
        start = true;
      }
      await client.query('INSERT INTO draft_audio_receipts(actor_id,command_id,request_hash,session_id,beat_id,preparation_id) VALUES($1,$2,$3,$4,$5,$6)', [actor.actor_id, command.commandId, requestHash, request.params.sessionId, current.beat.id, preparation!.id]);
      return start ? { preparation: preparation! } : { result: await response(client, preparation!) };
    }, command.commandId);
    if ('result' in acquired) return acquired.result;
    const preparation = acquired.preparation;
    const checkCurrent = (completed?: number) => locked(request, async (client, current) => {
      const saved: Preparation = (await client.query('SELECT * FROM draft_audio_preparations WHERE id=$1', [preparation.id])).rows[0];
      if (!matches(saved, current)) return changed('This speech preparation was superseded or expired.');
      if (saved.status !== 'preparing' || (await response(client, saved)).status !== 'preparing') return conflict('This speech preparation was superseded or expired.');
      if (completed !== undefined) await saveSpeechProgress(client, request.params.sessionId, { kind: 'draft', id: saved.id, completed, total: preparation.segments.length });
      return saved;
    });
    const lines: CachedLine[] = [];
    try {
      for (const line of preparation.segments) {
        await checkCurrent();
        const { asset, voiceProfileId } = await speakLine(options, { sessionId: request.params.sessionId, beatId: preparation.beat_id, operationId: preparation.id }, line);
        lines.push({ ...line, voiceProfileId, assetId: asset.assetId });
        await checkCurrent(lines.length);
      }
      return await locked(request, async (client, current) => {
        const saved: Preparation = (await client.query('SELECT * FROM draft_audio_preparations WHERE id=$1', [preparation.id])).rows[0];
        if (!matches(saved, current)) return changed('This speech preparation was superseded or expired.');
        if (saved.status !== 'preparing' || (await response(client, saved)).status !== 'preparing') return conflict('This speech preparation was superseded or expired.');
        const manifest: DraftAudioManifest = { preparationId: saved.id, beatId: saved.beat_id, draftRevision: saved.draft_revision, generation: saved.generation, segments: lines.map((line, index) => ({ index, text: line.text, speaker: line.speaker, voiceProfileId: line.voiceProfileId, url: `/api/sessions/${encodeURIComponent(request.params.sessionId)}/beats/${encodeURIComponent(saved.beat_id)}/draft-audio/${saved.id}/segments/${index}` })) };
        await client.query("UPDATE draft_audio_preparations SET status='ready',segments=$2,manifest=$3,updated_at=clock_timestamp() WHERE id=$1", [saved.id, JSON.stringify(lines), manifest]);
        await saveSpeechProgress(client, request.params.sessionId, { kind: 'draft', id: saved.id, completed: lines.length, total: lines.length, finished: true });
        return { status: 'ready' as const, manifest };
      });
    } catch (error) {
      if (error instanceof DraftChangedError) {
        // The receipts point at the row, so they go first. A row that already ended some other way stays as it is.
        await transaction(pool, async client => {
          const gone = await client.query("SELECT id FROM draft_audio_preparations WHERE id=$1 AND status='preparing' FOR UPDATE", [preparation.id]);
          if (!gone.rowCount) return;
          await client.query('DELETE FROM draft_audio_receipts WHERE preparation_id=$1', [preparation.id]);
          await client.query('DELETE FROM draft_audio_preparations WHERE id=$1', [preparation.id]);
        });
        throw error;
      }
      await pool.query("UPDATE draft_audio_preparations SET status='failed',updated_at=clock_timestamp() WHERE id=$1 AND status='preparing'", [preparation.id]);
      if (error instanceof AppError && [401, 403, 404, 409].includes(error.status)) throw error;
      return { status: 'failed' as const, preparationId: preparation.id };
    }
  });
  app.get<{ Params: Params & { preparationId: string; index: string } }>('/api/sessions/:sessionId/beats/:beatId/draft-audio/:preparationId/segments/:index', async (request, reply) => {
    const result = await locked(request, async (client, current) => {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.params.preparationId) || !/^(0|[1-9][0-9]?)$/.test(request.params.index)) throw new AppError(404, 'not_found', 'Private audio was not found.');
      const saved: Preparation | undefined = (await client.query('SELECT * FROM draft_audio_preparations WHERE id=$1 AND session_id=$2 AND beat_id=$3', [request.params.preparationId, request.params.sessionId, request.params.beatId])).rows[0];
      if (!saved) throw new AppError(404, 'not_found', 'Private audio was not found.');
      if (!matches(saved, current) || saved.status !== 'ready') return conflict('This recording belongs to an obsolete saved draft.');
      const line = saved.segments[Number(request.params.index)];
      if (!line?.assetId || !/^[a-f0-9]{64}$/.test(line.assetId)) throw new AppError(404, 'not_found', 'Private audio was not found.');
      try { return await readFile(join(options.assetDir, `${line.assetId}.mp3`)); }
      catch { throw new AppError(404, 'audio_missing', 'The saved recording is unavailable. Prepare narration again.'); }
    });
    return reply.header('Cache-Control', 'no-store').type('audio/mpeg').send(result);
  });
}
