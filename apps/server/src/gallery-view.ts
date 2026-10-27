import type { PoolClient } from 'pg';
import type { ImageContentType, PictureMoment, PublishedBeat } from '@rpg/contracts';
import {
  galleryCover, galleryPictureFile, initials, modelLabel, sceneCaption,
  type GalleryCastMember, type GalleryPicture, type GalleryPortraitGroup, type GalleryScene, type GalleryTag, type GalleryView,
} from './gallery-model';
import { AppError, readState } from './repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PICTURE_COLUMNS = 'id, subject_id, status, hidden, beat_id, released_at, shows_beat_id, moment, file_hash, content_type, width, height, model, prompt';

interface PictureRow {
  id: string; subject_id: string; status: string; hidden: boolean; beat_id: string | null; released_at: Date | null;
  shows_beat_id: string | null; moment: PictureMoment | null; file_hash: string; content_type: ImageContentType;
  width: number; height: number; model: string; prompt: string;
}

function picture(row: PictureRow, caption: { label: string; line: string | null; tag: GalleryTag | null }): GalleryPicture {
  return {
    id: row.id, file: galleryPictureFile(row.id, row.content_type), fileHash: row.file_hash, contentType: row.content_type,
    width: row.width, height: row.height, label: caption.label, line: caption.line, tag: caption.tag,
    model: modelLabel(row.model), prompt: row.prompt,
  };
}

const portrait = (row: PictureRow, name: string) => picture(row, { label: name, line: null, tag: null });

function usableMoment(moment: unknown): PictureMoment | null {
  return moment && typeof moment === 'object' && Array.isArray((moment as PictureMoment).lines) ? moment as PictureMoment : null;
}

export async function loadGalleryView(client: PoolClient, sessionId: string): Promise<GalleryView> {
  const session = (await client.query<{ owner_id: string }>('SELECT owner_id FROM sessions WHERE id=$1', [sessionId])).rows[0];
  if (!session) throw new AppError(404, 'not_found', 'Session was not found.');
  const state = await readState(client, sessionId);
  const { title } = state.session;

  const changes = (await client.query<{ before_id: string | null; before_title: string | null; after_id: string | null; after_title: string | null }>(
    `SELECT data->'before'->'scene'->>'id' AS before_id, data->'before'->'scene'->>'title' AS before_title,
            data->'after'->'scene'->>'id' AS after_id, data->'after'->'scene'->>'title' AS after_title
       FROM audit_events WHERE session_id=$1 AND kind='change_scene' ORDER BY sequence`, [sessionId])).rows;
  const sceneOrder: { id: string; title: string }[] = [];
  const addScene = (id: string | null, sceneTitle: string | null) => {
    if (id && !sceneOrder.some(scene => scene.id === id)) sceneOrder.push({ id, title: sceneTitle ?? '' });
  };
  if (changes[0]?.before_id) addScene(changes[0].before_id, changes[0].before_title);
  else addScene(state.session.scene.id, state.session.scene.title);
  for (const change of changes) addScene(change.after_id, change.after_title);

  const published = new Map<string, PublishedBeat>();
  for (const row of (await client.query<{ id: string; data: PublishedBeat }>('SELECT id, data FROM published_beats WHERE session_id=$1', [sessionId])).rows) {
    published.set(row.id, { ...row.data, segments: Array.isArray(row.data?.segments) ? row.data.segments : [] });
  }

  const sceneRows = (await client.query<PictureRow>(
    `SELECT ${PICTURE_COLUMNS} FROM images
      WHERE session_id=$1 AND purpose='scene' AND status IN ('ready','cancelled') AND file_hash IS NOT NULL AND content_type IS NOT NULL
      ORDER BY created_at, id`, [sessionId])).rows;
  const scenes: GalleryScene[] = [];
  sceneOrder.forEach((scene, index) => {
    const pictures = sceneRows.filter(row => row.subject_id === scene.id)
      .map(row => picture(row, sceneCaption({ ...row, moment: usableMoment(row.moment) }, published)));
    if (pictures.length) scenes.push({ number: index + 1, title: scene.title, pictures });
  });

  const players = state.characters.filter(character => character.approved);
  const wanted = [...players.map(character => character.portraitId), ...state.npcs.map(npc => npc.portraitId)]
    .filter((id): id is string => typeof id === 'string' && UUID.test(id));
  const resolved = new Map<string, PictureRow>();
  if (wanted.length) {
    const rows = (await client.query<PictureRow>(
      `SELECT ${PICTURE_COLUMNS} FROM images
        WHERE id = ANY($1::uuid[]) AND status='ready' AND file_hash IS NOT NULL AND content_type IS NOT NULL AND owner_id=$2`,
      [[...new Set(wanted)], session.owner_id])).rows;
    for (const row of rows) resolved.set(row.id, row);
  }
  const portraitOf = (id: string | undefined, name: string) => {
    const row = id ? resolved.get(id) : undefined;
    return row ? portrait(row, name) : null;
  };
  const cast: GalleryCastMember[] = players.map(character => ({
    kind: 'player', name: character.displayName, initials: initials(character.displayName), portrait: portraitOf(character.portraitId, character.displayName),
  }));
  for (const npc of state.npcs) {
    const shown = portraitOf(npc.portraitId, npc.displayName);
    if (shown) cast.push({ kind: 'npc', name: npc.displayName, initials: initials(npc.displayName), portrait: shown });
  }

  const npcRows = (await client.query<PictureRow>(
    `SELECT ${PICTURE_COLUMNS} FROM images
      WHERE session_id=$1 AND purpose='npc' AND status IN ('ready','cancelled') AND file_hash IS NOT NULL AND content_type IS NOT NULL
      ORDER BY created_at, id`, [sessionId])).rows;
  const morePortraits: GalleryPortraitGroup[] = [];
  const groupsById = new Map<string, GalleryPortraitGroup>();
  for (const row of npcRows) {
    const npc = state.npcs.find(entry => entry.id === row.subject_id);
    if (!npc || npc.portraitId === row.id) continue;
    let group = groupsById.get(npc.id);
    if (!group) {
      group = { name: npc.displayName, pictures: [] };
      groupsById.set(npc.id, group);
      morePortraits.push(group);
    }
    group.pictures.push(portrait(row, npc.displayName));
  }

  const pending = Number((await client.query<{ count: string }>(
    "SELECT count(*) AS count FROM images WHERE session_id=$1 AND status='making' AND purpose IN ('scene','npc')", [sessionId])).rows[0]!.count);
  const ended = (await client.query<{ ended_at: Date | null }>(
    "SELECT max(created_at) AS ended_at FROM audit_events WHERE session_id=$1 AND kind='set_status'", [sessionId])).rows[0]?.ended_at ?? null;

  return {
    sessionId, title, endedAt: ended ? new Date(ended).toISOString() : null, cast, scenes, morePortraits, pending,
    cover: galleryCover({ cast, scenes, morePortraits }),
  };
}
