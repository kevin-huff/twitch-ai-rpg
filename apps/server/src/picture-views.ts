import type { PoolClient } from 'pg';
import type { ActionPictureStatus, ImageContentType, PictureKind, PictureMoment, PinnedPicture, PortraitJob, PublishedBeat, ScenePicture, ScenePictureStatus, SessionState } from '@rpg/contracts';
import { sceneCaption } from './gallery-model';
import { PICTURE_MESSAGES } from './picture-limits';
import type { Actor } from './repository';

export type ImagePurpose = 'scene' | 'npc' | 'character' | 'card';

// One images row, every column as stored (migrations/011_images.sql, 012_action_pictures.sql, 013_picture_settings.sql and 017_picture_shelf.sql).
export interface ImageRow {
  id: string;
  owner_id: string;
  session_id: string | null;
  builder_id: string | null;
  purpose: ImagePurpose;
  subject_id: string;
  limit_key: string;
  attach: boolean;
  status: 'making' | 'ready' | 'failed' | 'cancelled';
  hidden: boolean;
  prompt: string;
  width: number;
  height: number;
  provider: string;
  model: string;
  requested_by: string;
  producer_grant_id: string | null;
  workflow_id: string | null;
  file_hash: string | null;
  content_type: ImageContentType | null;
  byte_length: number | null;
  message: string | null;
  beat_id: string | null;
  released_at: Date | null;
  moment: PictureMoment | null;
  shows_beat_id: string | null;
  shelf_only: boolean;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface ImageReservation {
  ownerId: string; sessionId: string | null; builderId: string | null;
  purpose: ImagePurpose; subjectId: string; limitKey: string; attach: boolean; beatId?: string | null; showsBeatId?: string | null; shelfOnly?: boolean;
  model?: string; moment?: PictureMoment | null;
  prompt: string; width: number; height: number;
  requestedBy: { actor_id: string; producer_grant_id?: string | null };
}

// What the route modules code against; ImageService implements it.
export interface PictureEngine {
  readonly enabled: boolean;
  readonly defaultModel: string | null;
  reserve(client: PoolClient, input: ImageReservation, mode: 'request' | 'automatic'): Promise<string | null>;
  reserveScene(client: PoolClient, state: SessionState, actor: Actor, mode?: 'request' | 'automatic'): Promise<string | null>;
  reserveNpcPortrait(client: PoolClient, state: SessionState, npcId: string, actor: Actor, mode?: 'request' | 'automatic'): Promise<string | null>;
  reserveBeatPicture(client: PoolClient, state: SessionState, beatId: string, actor: Actor, options?: { shelfOnly?: boolean }): Promise<string | null>;
  startOver(client: PoolClient, sessionId: string, sceneId: string): Promise<void>;
  run(imageIds: string[]): void;
  generateNow(imageId: string): Promise<void>;
}

// A beat picture stays held for the director until its beat is published; a shelf picture (Draw again) never reaches the stream on its own. Every other row counts as released.
export const RELEASED = '((beat_id IS NULL OR released_at IS NOT NULL) AND NOT shelf_only)';

const SCENE_FAILED = PICTURE_MESSAGES.sceneFailed;
const ROUND_SAFETY = 'The picture service would not draw this beat. You can still publish it.';
const NPC_FAILED = 'The portrait could not be made. Press Create portrait to try again.';

// Held action pictures never count for the audience or for the state. Released pictures rank by the moment they show: when it was asked for if it has no round, when its round was published if it has one. A picture that finishes late never outranks a newer moment, and older pictures still being made are cancelled when a round is published. The newest ready one is what the audience sees, unless hidden; the director's state is making only while a released picture newer than the newest ready one is being made (older pictures still drawing no longer hold the status; publishing still cancels them), otherwise the newest released one decides. The hidden flag comes from the newest row by the same order, held or not. Shelf pictures are left out entirely. The shown picture says whether it shows a beat (it has a moment) or the place.
export async function scenePictureView(client: PoolClient, sessionId: string, sceneId: string): Promise<{ shown: ScenePicture | null; status: ScenePictureStatus }> {
  const result = await client.query<Pick<ImageRow, 'id' | 'status' | 'message' | 'beat_id' | 'released_at'> & { newest_hidden: boolean; has_moment: boolean }>(
    `SELECT id, status, message, beat_id, released_at, moment IS NOT NULL AS has_moment,
       FIRST_VALUE(hidden) OVER (ORDER BY COALESCE(released_at, created_at) DESC, id DESC) AS newest_hidden
     FROM images WHERE session_id=$1 AND purpose='scene' AND subject_id=$2 AND status<>'cancelled' AND NOT shelf_only
     ORDER BY COALESCE(released_at, created_at) DESC, id DESC`,
    [sessionId, sceneId]);
  const released = result.rows.filter(row => !row.beat_id || row.released_at);
  const latest = released[0];
  const latestReady = released.find(row => row.status === 'ready');
  const hidden = result.rows[0]?.newest_hidden ?? false;
  const readyAt = latestReady ? released.indexOf(latestReady) : released.length;
  const making = released.slice(0, readyAt).find(row => row.status === 'making');
  const state = !latest ? 'none' : making ? 'making' : latest.status === 'failed' ? 'failed' : 'ready';
  return {
    shown: latestReady && !hidden ? { imageId: latestReady.id, sceneId, kind: latestReady.has_moment ? 'beat' : 'place' } : null,
    status: { sceneId, state, imageId: latestReady?.id ?? null, hidden, message: state === 'failed' ? latest!.message ?? SCENE_FAILED : null, drawing: making ? making.has_moment ? 'beat' : 'place' : null },
  };
}

// The newest beat published in the current scene, or null when none has been since the scene last changed.
export async function lastBeatInScene(client: PoolClient, sessionId: string): Promise<string | null> {
  const result = await client.query<{ beat_id: string }>(
    `SELECT e.data->>'beatId' AS beat_id FROM audit_events e
     JOIN published_beats p ON p.id = e.data->>'beatId' AND p.session_id = e.session_id
     WHERE e.session_id=$1 AND e.kind='beat.published'
       AND e.sequence > COALESCE((SELECT max(sequence) FROM audit_events WHERE session_id=$1 AND kind='change_scene'), 0)
     ORDER BY e.sequence DESC LIMIT 1`,
    [sessionId]);
  return result.rows[0]?.beat_id ?? null;
}

// The picture waiting for this round to be published: the newest held one that is not cancelled, or null when there is none.
export async function actionPictureView(client: PoolClient, sessionId: string, beatId: string): Promise<ActionPictureStatus | null> {
  const result = await client.query<Pick<ImageRow, 'id' | 'status' | 'message'>>(
    "SELECT id, status, message FROM images WHERE session_id=$1 AND beat_id=$2 AND released_at IS NULL AND status<>'cancelled' ORDER BY created_at DESC, id DESC LIMIT 1",
    [sessionId, beatId]);
  const row = result.rows[0];
  if (!row) return null;
  const state = row.status === 'ready' ? 'ready' : row.status === 'failed' ? 'failed' : 'making';
  // Only the credit and key sentences help the director; a failed picture never blocks publishing, so the panel's round line covers the rest.
  const message = state !== 'failed' ? null
    : row.message === PICTURE_MESSAGES.credit || row.message === PICTURE_MESSAGES.key ? row.message
    : row.message === PICTURE_MESSAGES.sceneSafety || row.message === PICTURE_MESSAGES.beatSafety ? ROUND_SAFETY : null;
  return { beatId, state, imageId: state === 'ready' ? row.id : null, message };
}

// For each non-player character, the newest portrait job of this show, kept only while it is still making or has failed.
export async function portraitJobsView(client: PoolClient, sessionId: string, npcIds: string[]): Promise<PortraitJob[]> {
  if (!npcIds.length) return [];
  const result = await client.query<Pick<ImageRow, 'subject_id' | 'status' | 'message'>>(
    "SELECT DISTINCT ON (subject_id) subject_id, status, message FROM images WHERE session_id=$1 AND purpose='npc' AND attach AND status<>'cancelled' AND subject_id=ANY($2::text[]) ORDER BY subject_id, created_at DESC, id DESC",
    [sessionId, npcIds]);
  return result.rows.flatMap((row): PortraitJob[] => row.status === 'making'
    ? [{ npcId: row.subject_id, state: 'making', message: null }]
    : row.status === 'failed' ? [{ npcId: row.subject_id, state: 'failed', message: row.message ?? NPC_FAILED }] : []);
}

// The picture the director pinned, while it can be shown: ready with a file, owned by the show's director, made for this show (or a library portrait with no show), and never a beat picture still held for its beat.
async function pinnedRow(client: PoolClient, sessionId: string): Promise<ImageRow | null> {
  const result = await client.query<ImageRow>(
    `SELECT i.* FROM sessions s JOIN images i ON i.id = s.pinned_image_id
     WHERE s.id=$1 AND i.status='ready' AND i.file_hash IS NOT NULL AND i.content_type IS NOT NULL AND i.owner_id = s.owner_id
       AND (i.session_id = s.id OR (i.session_id IS NULL AND i.purpose <> 'scene'))
       AND NOT (i.beat_id IS NOT NULL AND i.released_at IS NULL)`,
    [sessionId]);
  return result.rows[0] ?? null;
}

const usableMoment = (moment: unknown): PictureMoment | null =>
  moment && typeof moment === 'object' && Array.isArray((moment as PictureMoment).lines) ? moment as PictureMoment : null;

// What the stream, the seats and the director show while a picture is pinned: its id, whether it shows a place, a beat or a portrait, and the label the shelf uses for it.
export async function pinnedPictureView(client: PoolClient, sessionId: string): Promise<PinnedPicture | null> {
  const row = await pinnedRow(client, sessionId);
  if (!row) return null;
  if (row.purpose === 'scene') {
    const kind: PictureKind = row.moment ? 'beat' : 'place';
    const beatIds = [row.beat_id, row.shows_beat_id].filter((id): id is string => Boolean(id));
    const published = new Map<string, PublishedBeat>();
    if (beatIds.length) {
      const beats = await client.query<{ id: string; data: PublishedBeat }>('SELECT id, data FROM published_beats WHERE session_id=$1 AND id=ANY($2::text[])', [sessionId, beatIds]);
      for (const beat of beats.rows) published.set(beat.id, { ...beat.data, segments: Array.isArray(beat.data?.segments) ? beat.data.segments : [] });
    }
    return { imageId: row.id, kind, label: sceneCaption({ ...row, moment: usableMoment(row.moment) }, published).label.slice(0, 200) };
  }
  const named = await client.query<{ name: string | null }>(
    `SELECT name FROM (
       SELECT data->>'displayName' AS name, CASE WHEN id=$2 THEN 0 ELSE 1 END AS rank, 0 AS source FROM npcs WHERE session_id=$1 AND (id=$2 OR data->>'portraitId'=$3)
       UNION ALL
       SELECT data->>'displayName', CASE WHEN id=$2 THEN 0 ELSE 1 END, 1 FROM characters WHERE session_id=$1 AND (id=$2 OR data->>'portraitId'=$3)
     ) named WHERE name IS NOT NULL AND name <> '' ORDER BY rank, source LIMIT 1`,
    [sessionId, row.subject_id, row.id]);
  const name = named.rows[0]?.name;
  return { imageId: row.id, kind: 'portrait', label: name ? `Portrait of ${name}`.slice(0, 200) : 'A portrait' };
}

// Scene pictures are checked by purpose first, so a portrait reference can never expose one. The pinned picture is shown to everyone in the show whatever its purpose or hidden flag; a shelf picture stays with the director until it is pinned.
export async function imageVisibleTo(client: PoolClient, actor: Actor, sessionId: string, sessionOwnerId: string, image: ImageRow): Promise<boolean> {
  if (actor.role === 'host') return image.owner_id === sessionOwnerId;
  if ((await pinnedRow(client, sessionId))?.id === image.id) return true;
  if (image.purpose === 'scene') return image.session_id === sessionId && !image.hidden && !image.shelf_only && !(image.beat_id && !image.released_at);
  const referenced = await client.query(
    "SELECT 1 FROM npcs WHERE session_id=$1 AND data->>'portraitId'=$2 UNION ALL SELECT 1 FROM characters WHERE session_id=$1 AND data->>'portraitId'=$2 LIMIT 1",
    [sessionId, image.id]);
  if (referenced.rowCount) return true;
  if (actor.role !== 'player' || !actor.character_id) return false;
  if (image.session_id === sessionId && image.purpose === 'character' && image.subject_id === actor.character_id) return true;
  const draft = await client.query("SELECT 1 FROM characters WHERE session_id=$1 AND id=$2 AND data->'draft'->>'portraitId'=$3", [sessionId, actor.character_id, image.id]);
  return Boolean(draft.rowCount);
}
