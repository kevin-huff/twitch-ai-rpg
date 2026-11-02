import type { PoolClient } from 'pg';
import { ShelfPicturesSchema, type PictureKind, type PictureMoment, type PublishedBeat, type ShelfPicture, type ShelfPictures } from '@rpg/contracts';
import { sceneCaption } from './gallery-model';
import { scenePictureView } from './picture-views';
import { AppError, readState } from './repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface ListRow {
  id: string; purpose: 'scene' | 'npc' | 'character' | 'card'; subject_id: string; status: 'making' | 'ready' | 'failed';
  message: string | null; hidden: boolean; beat_id: string | null; released_at: Date | null; shows_beat_id: string | null;
  moment: PictureMoment | null; shelf_only: boolean; created_at: Date;
}

function usableMoment(moment: unknown): PictureMoment | null {
  return moment && typeof moment === 'object' && Array.isArray((moment as PictureMoment).lines) ? moment as PictureMoment : null;
}

// Every picture the director can pick from: this show's pictures that are being drawn, ready or failed, plus the current portraits of its characters and non-player characters, newest first.
export async function shelfPictures(client: PoolClient, sessionId: string): Promise<ShelfPictures> {
  const session = (await client.query<{ owner_id: string; pinned_image_id: string | null }>('SELECT owner_id, pinned_image_id FROM sessions WHERE id=$1', [sessionId])).rows[0];
  if (!session) throw new AppError(404, 'not_found', 'Session was not found.');
  const state = await readState(client, sessionId);

  const changes = (await client.query<{ before_id: string | null; before_title: string | null; after_id: string | null; after_title: string | null }>(
    `SELECT data->'before'->'scene'->>'id' AS before_id, data->'before'->'scene'->>'title' AS before_title,
            data->'after'->'scene'->>'id' AS after_id, data->'after'->'scene'->>'title' AS after_title
       FROM audit_events WHERE session_id=$1 AND kind='change_scene' ORDER BY sequence`, [sessionId])).rows;
  const sceneTitles = new Map<string, string>();
  const addScene = (id: string | null, title: string | null) => { if (id && !sceneTitles.has(id)) sceneTitles.set(id, title ?? ''); };
  if (changes[0]?.before_id) addScene(changes[0].before_id, changes[0].before_title);
  else addScene(state.session.scene.id, state.session.scene.title);
  for (const change of changes) addScene(change.after_id, change.after_title);
  addScene(state.session.scene.id, state.session.scene.title);

  const published = new Map<string, PublishedBeat>();
  for (const row of (await client.query<{ id: string; data: PublishedBeat }>('SELECT id, data FROM published_beats WHERE session_id=$1', [sessionId])).rows) {
    published.set(row.id, { ...row.data, segments: Array.isArray(row.data?.segments) ? row.data.segments : [] });
  }

  const portraitIds = [...state.characters.map(character => character.portraitId), ...state.npcs.map(npc => npc.portraitId)]
    .filter((id): id is string => typeof id === 'string' && UUID.test(id));
  const rows = (await client.query<ListRow>(
    `SELECT id, purpose, subject_id, status, message, hidden, beat_id, released_at, shows_beat_id, moment, shelf_only, created_at
       FROM images
      WHERE status IN ('making','ready','failed')
        AND ((session_id=$1 AND purpose IN ('scene','npc','character')) OR (owner_id=$2 AND id = ANY($3::uuid[])))
        AND NOT (beat_id IS NOT NULL AND released_at IS NULL AND EXISTS (SELECT 1 FROM beats b WHERE b.id=images.beat_id AND b.session_id=images.session_id AND b.phase='aborted'))
      ORDER BY created_at DESC, id DESC`,
    [sessionId, session.owner_id, [...new Set(portraitIds)]])).rows;

  const pinnedId = session.pinned_image_id;
  const pinnedReady = pinnedId
    ? Boolean((await client.query("SELECT 1 FROM images WHERE id=$1 AND status='ready' AND file_hash IS NOT NULL", [pinnedId])).rowCount)
    : false;
  const onStreamId = pinnedId && pinnedReady
    ? pinnedId
    : (await scenePictureView(client, sessionId, state.session.scene.id)).shown?.imageId ?? null;

  const personFor = (row: ListRow): string | null => {
    const bySubject = row.purpose === 'npc' ? state.npcs.find(npc => npc.id === row.subject_id)
      : row.purpose === 'character' ? state.characters.find(character => character.id === row.subject_id) : undefined;
    const person = bySubject ?? state.npcs.find(npc => npc.portraitId === row.id) ?? state.characters.find(character => character.portraitId === row.id);
    return person?.displayName || null;
  };

  const pictures = rows.map((row): ShelfPicture => {
    const moment = usableMoment(row.moment);
    const isScene = row.purpose === 'scene';
    const kind: PictureKind = !isScene ? 'portrait' : moment ? 'beat' : 'place';
    // Publishing releases only a held picture still being drawn or ready, so one that failed first stays unreleased; once its beat is published it is that beat's picture, not the beat in progress.
    const held = Boolean(row.beat_id) && !row.released_at && !published.has(row.beat_id!);
    let label: string;
    if (!isScene) {
      const name = personFor(row);
      label = name ? `Portrait of ${name}` : 'A portrait';
    } else if (held) {
      label = 'The beat in progress';
    } else {
      label = sceneCaption({ status: row.status, hidden: row.hidden, beat_id: row.beat_id, released_at: row.released_at, shows_beat_id: row.shows_beat_id, moment }, published).label;
    }
    const shownBeat = row.beat_id && (row.released_at || published.has(row.beat_id)) ? row.beat_id : row.shows_beat_id;
    const sceneTitle = !isScene ? null : moment?.scene?.title || sceneTitles.get(row.subject_id) || null;
    return {
      imageId: row.id, kind, label: label.slice(0, 200), scene: sceneTitle === null ? null : sceneTitle.slice(0, 160), status: row.status,
      message: row.status === 'failed' && row.message ? row.message.slice(0, 300) : null,
      onStream: row.id === onStreamId, pinned: row.id === pinnedId, held, shelfOnly: row.shelf_only,
      beatId: shownBeat && published.has(shownBeat) ? shownBeat : null,
      createdAt: new Date(row.created_at).toISOString(),
    };
  });
  return ShelfPicturesSchema.parse({ pictures });
}
