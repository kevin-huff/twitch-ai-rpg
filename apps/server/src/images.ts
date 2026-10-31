import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  MOMENT_MODEL, PICTURE_LIMITS, PORTRAIT_SIZE, SCENE_PICTURE_SIZE, type AiProvider, type Beat, type ImageProvider, type PictureMoment, type PictureSettings, type PublishedBeat, type SessionState,
} from '@rpg/contracts';
import { failUnstarted, runImageJob, type ImageJobContext, type ImageJobOutcome } from './image-jobs';
import { ImageSlots } from './image-slots';
import { PICTURE_MESSAGES, pictureFailure, pictureLimitMessage, type PictureLimitSettings } from './picture-limits';
import { buildPictureMoment, pictureCast, type BeatPictureSource } from './picture-cast';
import { changedLookNumbers, descriptionBudget, draftNarration, fallbackDescription, momentPrompt, namesInState, portraitPrompt, sceneLocationTitle, scenePrompt } from './picture-prompts';
import { pictureSettingsOf } from './picture-settings';
import type { ImageReservation, ImageRow, PictureEngine } from './picture-views';
import { AppError, type Actor } from './repository';

export { PICTURE_MESSAGES } from './picture-limits';
export type { ImageReservation } from './picture-views';

export interface ImageServiceOptions {
  pool: Pool; provider?: ImageProvider; assetDir: string;
  // Unset means no hourly limit.
  hourlyLimit?: number;
  concurrency?: number;
  ai?: AiProvider;
  // Called, not awaited, when a picture that belongs to a session finishes.
  onReady?: (sessionId: string) => void;
}

type Mode = 'request' | 'automatic';
type JobRow = Pick<ImageRow, 'id' | 'session_id' | 'purpose' | 'subject_id' | 'beat_id' | 'status' | 'created_at'>;
interface Job { controller: AbortController; done: Promise<ImageJobOutcome>; row: JobRow | null }

const CLOSE_WAIT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QUOTA_LOCK = "SELECT pg_advisory_xact_lock(hashtext('rpg-images-quota'))";
// A newer draft replaces the round's held pictures; only held ones, since a released picture is already on the stream.
const RETIRE_HELD = "UPDATE images SET status='cancelled', message=$3, finished_at=COALESCE(finished_at, clock_timestamp()) WHERE session_id=$1 AND beat_id=$2 AND released_at IS NULL AND status<>'cancelled'";
// Only the round's newest held picture is released, and only while it is still being made or is ready.
const RELEASE_NEWEST = `WITH newest AS (SELECT id, status FROM images WHERE session_id=$1 AND beat_id=$2 AND released_at IS NULL AND status<>'cancelled' ORDER BY created_at DESC, id DESC LIMIT 1)
  UPDATE images SET released_at=clock_timestamp() FROM newest WHERE images.id=newest.id AND newest.status IN ('making','ready') RETURNING images.id, images.subject_id`;
// Every other picture of the scene still being made for the stream shows an older moment than the round just released.
const RETIRE_OUTRANKED = `UPDATE images SET status='cancelled', message=$4, finished_at=COALESCE(finished_at, clock_timestamp())
  WHERE session_id=$1 AND purpose='scene' AND subject_id=$2 AND status='making' AND (beat_id IS NULL OR released_at IS NOT NULL) AND id<>$3 RETURNING id`;
// Pressing a draw button again replaces a picture of this scene that is still on its way to the stream; a held action picture is not on its way yet.
const START_OVER = `UPDATE images SET status='cancelled', message=$3, finished_at=COALESCE(finished_at, clock_timestamp())
  WHERE session_id=$1 AND purpose='scene' AND subject_id=$2 AND status='making' AND (beat_id IS NULL OR released_at IS NOT NULL) RETURNING id`;
const requestedBy = (actor: Actor) => ({ actor_id: actor.actor_id, producer_grant_id: actor.producer_grant_id ?? null });

// Reserves picture rows inside the caller's transaction and runs them in the background once that transaction has committed.
export class ImageService implements PictureEngine {
  readonly enabled: boolean;
  readonly defaultModel: string | null;
  private readonly context: ImageJobContext | null;
  private readonly limits: PictureLimitSettings;
  private readonly jobs = new Map<string, Job>();
  private closed = false;

  constructor(private readonly options: ImageServiceOptions) {
    this.enabled = Boolean(options.provider);
    this.defaultModel = options.provider?.model ?? null;
    this.limits = { hourly: options.hourlyLimit ?? null };
    this.context = options.provider ? {
      pool: options.pool, provider: options.provider, assetDir: options.assetDir,
      slots: new ImageSlots(options.concurrency ?? PICTURE_LIMITS.concurrent), ai: options.ai,
    } : null;
  }

  reserve(client: PoolClient, input: ImageReservation, mode: Mode): Promise<string | null> {
    return this.guarded(client, mode, () => this.insert(client, input, mode));
  }

  reserveScene(client: PoolClient, state: SessionState, actor: Actor, mode: Mode = 'automatic'): Promise<string | null> {
    return this.guarded(client, mode, async () => {
      const { id: sessionId, scene } = state.session;
      const settings = await pictureSettingsOf(client, state, this.defaultModel!);
      return this.insert(client, {
        ownerId: await this.ownerOf(client, sessionId), sessionId, builderId: null,
        purpose: 'scene', subjectId: scene.id, limitKey: `scene:${sessionId}`, attach: false, model: settings.model,
        prompt: scenePrompt({ title: scene.title, description: scene.description, locationTitle: sceneLocationTitle(state) },
          { style: settings.style, names: namesInState(state) }),
        ...SCENE_PICTURE_SIZE, requestedBy: requestedBy(actor),
      }, mode);
    });
  }

  reserveNpcPortrait(client: PoolClient, state: SessionState, npcId: string, actor: Actor, mode: Mode = 'automatic'): Promise<string | null> {
    return this.guarded(client, mode, async () => {
      const npc = state.npcs.find(candidate => candidate.id === npcId);
      if (!npc || (!npc.appearance.trim() && !npc.role.trim())) return null;
      const sessionId = state.session.id;
      const settings = await pictureSettingsOf(client, state, this.defaultModel!);
      return this.insert(client, {
        ownerId: await this.ownerOf(client, sessionId), sessionId, builderId: null,
        purpose: 'npc', subjectId: npc.id, limitKey: `npc:${sessionId}:${npc.id}`, attach: true, model: settings.model,
        prompt: portraitPrompt({ appearance: npc.appearance, role: npc.role, pronouns: '', name: npc.displayName },
          { style: settings.style, names: namesInState(state) }),
        ...PORTRAIT_SIZE, requestedBy: requestedBy(actor),
      }, mode);
    });
  }

  // An action round's picture, held for the director until the round is published.
  reserveActionPicture(client: PoolClient, state: SessionState, beat: Beat, actor: Actor, mode: Mode = 'automatic'): Promise<string | null> {
    return this.guarded(client, mode, async () => {
      if (beat.kind !== 'action') return null;
      const { id: sessionId, scene } = state.session;
      await client.query('SELECT 1 FROM sessions WHERE id=$1 FOR UPDATE', [sessionId]);
      await client.query(RETIRE_HELD, [sessionId, beat.id, PICTURE_MESSAGES.actionSuperseded]);
      if (!draftNarration(beat.draft).trim()) return null;
      const settings = await pictureSettingsOf(client, state, this.defaultModel!);
      const { moment, prompt, model } = await this.momentReservation(client, state, { beat, published: null }, settings);
      return this.insert(client, {
        ownerId: await this.ownerOf(client, sessionId), sessionId, builderId: null,
        purpose: 'scene', subjectId: scene.id, beatId: beat.id, limitKey: `scene:${sessionId}`, attach: false,
        prompt, model, moment, ...SCENE_PICTURE_SIZE, requestedBy: requestedBy(actor),
      }, mode);
    });
  }

  // A picture of a beat the director asked for with the button; it has no round tag, so it ranks from the moment it was asked for.
  reserveBeatPicture(client: PoolClient, state: SessionState, beatId: string, actor: Actor): Promise<string | null> {
    return this.guarded(client, 'request', async () => {
      const { id: sessionId, scene } = state.session;
      const beat = (await client.query<{ data: Beat }>('SELECT data FROM beats WHERE session_id=$1 AND id=$2', [sessionId, beatId])).rows[0]?.data;
      const published = (await client.query<{ data: PublishedBeat }>('SELECT data FROM published_beats WHERE session_id=$1 AND id=$2', [sessionId, beatId])).rows[0]?.data;
      if (!beat || !published) throw new AppError(409, 'conflict', 'No beat has been published in this scene yet.');
      const settings = await pictureSettingsOf(client, state, this.defaultModel!);
      const { moment, prompt, model } = await this.momentReservation(client, state, { beat, published }, settings);
      return this.insert(client, {
        ownerId: await this.ownerOf(client, sessionId), sessionId, builderId: null,
        purpose: 'scene', subjectId: scene.id, beatId: null, showsBeatId: beatId, limitKey: `scene:${sessionId}`, attach: false,
        prompt, model, moment, ...SCENE_PICTURE_SIZE, requestedBy: requestedBy(actor),
      }, 'request');
    });
  }

  // Called when the round is published; returns the picture that becomes the scene's current one, or null when there is none to show.
  releaseActionPicture(client: PoolClient, sessionId: string, beatId: string): Promise<string | null> {
    return this.guarded(client, 'automatic', async () => {
      const released = (await client.query<{ id: string; subject_id: string }>(RELEASE_NEWEST, [sessionId, beatId])).rows[0];
      if (!released) return null;
      const { rows } = await client.query<{ id: string }>(RETIRE_OUTRANKED, [sessionId, released.subject_id, released.id, PICTURE_MESSAGES.newerMoment]);
      if (rows.length && !this.closed) void this.stopWhenCommitted(rows.map(row => row.id));
      return released.id;
    });
  }

  // Cancels this scene's pictures still on their way to the stream; their calls stop only once the caller's transaction has committed.
  async startOver(client: PoolClient, sessionId: string, sceneId: string): Promise<void> {
    if (!this.context || this.closed) return;
    const { rows } = await client.query<{ id: string }>(START_OVER, [sessionId, sceneId, PICTURE_MESSAGES.startedOver]);
    if (rows.length) void this.stopWhenCommitted(rows.map(row => row.id));
  }

  // Never throws and is never awaited by its caller; a new scene picture stops the show's pictures for earlier scenes.
  run(imageIds: string[]): void {
    if (!this.context || this.closed) return;
    void this.rowsOf(imageIds).then((rows) => {
      if (this.closed) return;
      for (const row of rows.values()) {
        // A row that is no longer being made (a late run for a picture a newer draft already cancelled) stops nothing.
        if (row.purpose !== 'scene' || row.status !== 'making') continue;
        for (const job of this.jobs.values()) {
          if (job.row?.purpose === 'scene' && job.row.session_id === row.session_id && job.row.subject_id !== row.subject_id) job.controller.abort();
          // The round's older pictures were already cancelled when this one was reserved; stop their calls too, but never a newer picture's.
          else if (row.beat_id && job.row?.beat_id === row.beat_id && job.row.session_id === row.session_id && job.row.created_at.getTime() < row.created_at.getTime()) job.controller.abort();
        }
      }
      for (const id of imageIds) if (rows.has(id)) void this.start(id, rows.get(id)!);
    }).catch(async () => {
      // The lookup failed, so rows nobody has picked up would stay making; end them best effort.
      try { await failUnstarted(this.context!, imageIds.filter(id => !this.jobs.has(id))); } catch { /* Nothing more to do. */ }
    });
  }

  // For the routes that hold the request open until the picture is ready.
  async generateNow(imageId: string): Promise<void> {
    if (!this.context) throw new AppError(503, 'pictures_off', PICTURE_MESSAGES.off);
    let row: JobRow | null;
    try {
      row = (await this.rowsOf([imageId])).get(imageId) ?? null;
    } catch (error) {
      // The lookup failed, so a row nobody has picked up would stay making; end it best effort.
      if (!this.jobs.has(imageId)) { try { await failUnstarted(this.context, [imageId]); } catch { /* Nothing more to do. */ } }
      throw error;
    }
    if (this.closed) throw new AppError(503, 'pictures_busy', PICTURE_MESSAGES.busy);
    const outcome = await this.start(imageId, row);
    if (outcome.status === 'ready') return;
    if (outcome.status === 'skipped') {
      const failure = pictureFailure(null, row?.purpose ?? 'card');
      throw new AppError(502, 'picture_failed', failure.message);
    }
    throw new AppError(outcome.httpStatus, outcome.code, outcome.message);
  }

  // Called before the pool ends: nothing new starts, every running picture stops, and no job is left writing to the database.
  async close(): Promise<void> {
    this.closed = true;
    const jobs = [...this.jobs.entries()];
    if (!jobs.length) return;
    for (const [, job] of jobs) job.controller.abort();
    await this.options.pool.query(
      `UPDATE images SET status='cancelled', message=CASE WHEN moment IS NOT NULL THEN $5 WHEN purpose='scene' THEN $2 WHEN purpose='npc' THEN $3 ELSE $4 END, finished_at=clock_timestamp()
       WHERE id=ANY($1::uuid[]) AND status='making'`,
      [jobs.map(([id]) => id), PICTURE_MESSAGES.sceneFailed, PICTURE_MESSAGES.npcFailed, PICTURE_MESSAGES.cardFailed, PICTURE_MESSAGES.beatFailed],
    ).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, CLOSE_WAIT_MS); timer.unref?.(); });
    await Promise.race([Promise.allSettled(jobs.map(([, job]) => job.done)), limit]);
    clearTimeout(timer);
  }

  // The share lock waits for the publish to end, so a rolled-back publish reads its pictures as still making and stops none of them.
  private async stopWhenCommitted(imageIds: string[]): Promise<void> {
    await this.options.pool.query<{ id: string; status: string }>('SELECT id, status FROM images WHERE id=ANY($1::uuid[]) FOR SHARE', [imageIds])
      .then(({ rows }) => { for (const row of rows) if (row.status === 'cancelled') this.jobs.get(row.id)?.controller.abort(); })
      .catch(() => undefined);
  }

  // Pictures off or closing: a person asking hears why, and automatic work quietly makes nothing. Automatic work runs in a savepoint so a picture can never fail the command around it.
  private async guarded(client: PoolClient, mode: Mode, work: () => Promise<string | null>): Promise<string | null> {
    if (!this.context || this.closed) {
      if (mode === 'automatic') return null;
      if (!this.context) throw new AppError(503, 'pictures_off', PICTURE_MESSAGES.off);
      throw new AppError(503, 'pictures_busy', PICTURE_MESSAGES.busy);
    }
    if (mode === 'request') return work();
    try {
      await client.query('SAVEPOINT picture_reserve');
    } catch { return null; }
    try {
      const id = await work();
      await client.query('RELEASE SAVEPOINT picture_reserve');
      return id;
    } catch {
      try {
        await client.query('ROLLBACK TO SAVEPOINT picture_reserve');
        await client.query('RELEASE SAVEPOINT picture_reserve');
      } catch { /* The caller's transaction was already broken before the picture. */ }
      return null;
    }
  }

  private async insert(client: PoolClient, input: ImageReservation, mode: Mode): Promise<string | null> {
    const provider = this.context!.provider;
    // The session row comes before the quota lock everywhere, and the builder row is touched before it too, so two reservations can never wait on each other.
    if (input.sessionId) await client.query('SELECT 1 FROM sessions WHERE id=$1 FOR UPDATE', [input.sessionId]);
    if (input.builderId) await client.query('SELECT 1 FROM character_builders WHERE id=$1 FOR KEY SHARE', [input.builderId]);
    await client.query(QUOTA_LOCK);
    const limited = await pictureLimitMessage(client, this.limits);
    if (limited && mode === 'request') throw new AppError(429, 'picture_limit', limited);
    const hidden = input.purpose === 'scene' && input.sessionId
      ? (await client.query<{ hidden: boolean }>(
        "SELECT hidden FROM images WHERE session_id=$1 AND purpose='scene' AND subject_id=$2 ORDER BY created_at DESC, id DESC LIMIT 1",
        [input.sessionId, input.subjectId])).rows[0]?.hidden ?? false
      : false;
    const id = randomUUID();
    await client.query(
      `INSERT INTO images(id, owner_id, session_id, builder_id, purpose, subject_id, limit_key, attach, status, hidden, prompt, width, height,
         provider, model, requested_by, producer_grant_id, message, beat_id, moment, shows_beat_id, finished_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb, $21, CASE WHEN $9='failed' THEN clock_timestamp() END)`,
      [id, input.ownerId, input.sessionId, input.builderId, input.purpose, input.subjectId, input.limitKey, input.attach,
        limited ? 'failed' : 'making', hidden, input.prompt, input.width, input.height, provider.name, input.model ?? provider.model,
        input.requestedBy.actor_id, input.requestedBy.producer_grant_id ?? null, limited, input.beatId ?? null,
        input.moment ? JSON.stringify(input.moment) : null, input.showsBeatId ?? null]);
    // A limit failure stays on record so the director can see why no picture came; it never counts toward a limit.
    return limited ? null : id;
  }

  // The moment with its provisional image numbers, the fallback prompt written as if every portrait uploads, and the model that draws it.
  private async momentReservation(client: PoolClient, state: SessionState, source: BeatPictureSource, settings: PictureSettings): Promise<{ moment: PictureMoment; prompt: string; model: string }> {
    const portraitIds = [...new Set(pictureCast(state, source).flatMap(person => (person.portraitId && UUID.test(person.portraitId) ? [person.portraitId] : [])))];
    const ready = portraitIds.length
      ? (await client.query<{ id: string }>("SELECT id FROM images WHERE id=ANY($1::uuid[]) AND status='ready' AND file_hash IS NOT NULL", [portraitIds])).rows.map(row => row.id)
      : [];
    const moment = buildPictureMoment(state, source, settings, new Set(ready));
    const withReferences = moment.cast.some(person => person.imageNumber !== null);
    const changed = changedLookNumbers(moment.cast);
    const prompt = momentPrompt(settings.style, fallbackDescription(moment, descriptionBudget(settings.style, withReferences, changed)), withReferences, changed);
    return { moment, prompt, model: withReferences ? MOMENT_MODEL : settings.model };
  }

  private async ownerOf(client: PoolClient, sessionId: string): Promise<string> {
    const row = (await client.query<{ owner_id: string }>('SELECT owner_id FROM sessions WHERE id=$1', [sessionId])).rows[0];
    if (!row) throw new AppError(404, 'not_found', 'Session was not found.');
    return row.owner_id;
  }

  private async rowsOf(ids: string[]): Promise<Map<string, JobRow>> {
    const valid = ids.filter(id => UUID.test(id));
    if (!valid.length) return new Map();
    const { rows } = await this.options.pool.query<JobRow>('SELECT id, session_id, purpose, subject_id, beat_id, status, created_at FROM images WHERE id=ANY($1::uuid[])', [valid]);
    return new Map(rows.map(row => [row.id, row]));
  }

  private notifyReady(sessionId: string): void {
    try {
      const result: unknown = this.options.onReady?.(sessionId);
      if (result instanceof Promise) result.catch(() => undefined);
    } catch { /* a gallery hook never changes a picture's outcome */ }
  }

  private start(id: string, row: JobRow | null): Promise<ImageJobOutcome> {
    const running = this.jobs.get(id);
    if (running) return running.done;
    const controller = new AbortController();
    const done = runImageJob(this.context!, id, controller.signal)
      .catch((): ImageJobOutcome => ({ status: 'skipped' }))
      .then((outcome) => {
        this.jobs.delete(id);
        if (outcome.status === 'ready' && row?.session_id) this.notifyReady(row.session_id);
        return outcome;
      });
    this.jobs.set(id, { controller, done, row });
    return done;
  }
}
