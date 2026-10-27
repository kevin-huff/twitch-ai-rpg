import type { PoolClient } from 'pg';
import type { ActionPictureStatus, ImageContentType, PictureMoment, PortraitJob, ScenePicture, ScenePictureStatus, SessionState } from '@rpg/contracts';
import { PICTURE_MESSAGES } from './picture-limits';
import type { Actor } from './repository';

export type ImagePurpose = 'scene' | 'npc' | 'character' | 'card';

// One images row, every column as stored (migrations/011_images.sql, 012_action_pictures.sql and 013_picture_settings.sql).
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
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface ImageReservation {
  ownerId: string; sessionId: string | null; builderId: string | null;
  purpose: ImagePurpose; subjectId: string; limitKey: string; attach: boolean; beatId?: string | null; showsBeatId?: string | null;
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
  reserveBeatPicture(client: PoolClient, state: SessionState, beatId: string, actor: Actor): Promise<string | null>;
  startOver(client: PoolClient, sessionId: string, sceneId: string): Promise<void>;
  run(imageIds: string[]): void;
  generateNow(imageId: string): Promise<void>;
}

// An action picture stays held for the director until its round is published; every other row counts as released.
export const RELEASED = '(beat_id IS NULL OR released_at IS NOT NULL)';

const SCENE_FAILED = PICTURE_MESSAGES.sceneFailed;
const ROUND_SAFETY = 'The picture service would not draw this round. You can still publish it.';
const NPC_FAILED = 'The portrait could not be made. Press Create portrait to try again.';

// Held action pictures never count for the audience or for the state. Released pictures rank by the moment they show: when it was asked for if it has no round, when its round was published if it has one. A picture that finishes late never outranks a newer moment, and older pictures still being made are cancelled when a round is published. The newest ready one is what the audience sees, unless hidden; the director's state is making while any released picture is being made, otherwise the newest released one decides. The hidden flag comes from the newest row by the same order, held or not.
export async function scenePictureView(client: PoolClient, sessionId: string, sceneId: string): Promise<{ shown: ScenePicture | null; status: ScenePictureStatus }> {
  const result = await client.query<Pick<ImageRow, 'id' | 'status' | 'message' | 'beat_id' | 'released_at'> & { newest_hidden: boolean; has_moment: boolean }>(
    `SELECT id, status, message, beat_id, released_at, moment IS NOT NULL AS has_moment,
       FIRST_VALUE(hidden) OVER (ORDER BY COALESCE(released_at, created_at) DESC, id DESC) AS newest_hidden
     FROM images WHERE session_id=$1 AND purpose='scene' AND subject_id=$2 AND status<>'cancelled'
     ORDER BY COALESCE(released_at, created_at) DESC, id DESC`,
    [sessionId, sceneId]);
  const released = result.rows.filter(row => !row.beat_id || row.released_at);
  const latest = released[0];
  const latestReady = released.find(row => row.status === 'ready');
  const hidden = result.rows[0]?.newest_hidden ?? false;
  const making = released.find(row => row.status === 'making');
  const state = !latest ? 'none' : making ? 'making' : latest.status === 'failed' ? 'failed' : 'ready';
  return {
    shown: latestReady && !hidden ? { imageId: latestReady.id, sceneId } : null,
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

// Scene pictures are checked by purpose first, so a portrait reference can never expose one.
export async function imageVisibleTo(client: PoolClient, actor: Actor, sessionId: string, sessionOwnerId: string, image: ImageRow): Promise<boolean> {
  if (actor.role === 'host') return image.owner_id === sessionOwnerId;
  if (image.purpose === 'scene') return image.session_id === sessionId && !image.hidden && !(image.beat_id && !image.released_at);
  const referenced = await client.query(
    "SELECT 1 FROM npcs WHERE session_id=$1 AND data->>'portraitId'=$2 UNION ALL SELECT 1 FROM characters WHERE session_id=$1 AND data->>'portraitId'=$2 LIMIT 1",
    [sessionId, image.id]);
  if (referenced.rowCount) return true;
  if (actor.role !== 'player' || !actor.character_id) return false;
  if (image.session_id === sessionId && image.purpose === 'character' && image.subject_id === actor.character_id) return true;
  const draft = await client.query("SELECT 1 FROM characters WHERE session_id=$1 AND id=$2 AND data->'draft'->>'portraitId'=$3", [sessionId, actor.character_id, image.id]);
  return Boolean(draft.rowCount);
}
