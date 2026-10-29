import { PICTURE_MODELS, type ImageContentType, type PictureMoment, type PublishedBeat } from '@rpg/contracts';
import { imageExtension } from './image-files';

export type GalleryTag = 'Not shown on stream' | 'Hidden';

export interface GalleryPicture {
  id: string; file: string; fileHash: string; contentType: ImageContentType; width: number; height: number;
  label: string; line: string | null; tag: GalleryTag | null; model: string; prompt: string;
}
export interface GalleryCastMember { kind: 'player' | 'npc'; name: string; initials: string; portrait: GalleryPicture | null }
export interface GalleryScene { number: number; title: string; pictures: GalleryPicture[] }
export interface GalleryPortraitGroup { name: string; pictures: GalleryPicture[] }
export interface GalleryView {
  sessionId: string; title: string; endedAt: string | null; cast: GalleryCastMember[]; scenes: GalleryScene[];
  morePortraits: GalleryPortraitGroup[]; pending: number; cover: GalleryPicture | null;
}
export interface GalleryListEntry { slug: string; title: string; endedAt: string | null; pictures: number; cover: GalleryPicture | null }
export interface GalleryCaptionRow {
  status: string; hidden: boolean; beat_id: string | null; released_at: Date | string | null;
  shows_beat_id: string | null; moment: PictureMoment | null;
}
export type GalleryWork =
  | { kind: 'refresh' }
  | { kind: 'remove'; slug: string }
  | { kind: 'replace'; oldSlug: string }
  | { kind: 'list' };

export function galleryPictureFile(id: string, contentType: ImageContentType): string {
  return `${id}.${imageExtension(contentType)}`;
}

export function firstSentence(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = /^[\s\S]*?(?:(?<!\b(?:Mr|Mrs|Ms|Mx|Dr|St|Capt|Sgt|Lt|Col|Gen|Maj|Prof|Rev|Jr|Sr|[A-Z]))\.|[!?])(?=\s|$)/.exec(trimmed);
  return match ? match[0].trim() : trimmed;
}

function lineOf(items: readonly { kind: string; text: string }[]): string | null {
  const item = items.find(entry => entry.kind === 'narration') ?? items[0];
  return item ? firstSentence(item.text) : null;
}

export function beatLine(beat: PublishedBeat): string | null {
  return lineOf(beat.segments);
}

export function momentLine(moment: PictureMoment): string | null {
  return lineOf(moment.lines);
}

export function modelLabel(model: string): string {
  return PICTURE_MODELS.find(entry => entry.id === model)?.label ?? model;
}

export function initials(name: string): string {
  const letters = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(word => Array.from(word)[0]!.toUpperCase()).join('');
  return letters || '?';
}

export function sceneCaption(
  row: GalleryCaptionRow, published: ReadonlyMap<string, PublishedBeat>,
): { label: string; line: string | null; tag: GalleryTag | null } {
  const hiddenTag: GalleryTag | null = row.hidden ? 'Hidden' : null;
  if (row.beat_id) {
    const round = published.get(row.beat_id);
    if (row.status === 'cancelled') {
      return {
        label: round ? `Earlier draft of action round ${round.actionRoundNumber}` : 'Earlier draft of a round',
        line: round ? beatLine(round) : null,
        tag: 'Not shown on stream',
      };
    }
    if (round) {
      return {
        label: `Action round ${round.actionRoundNumber}`,
        line: beatLine(round),
        tag: row.released_at ? hiddenTag : 'Not shown on stream',
      };
    }
    return { label: 'A round that was never published', line: null, tag: 'Not shown on stream' };
  }
  const shown = row.shows_beat_id ? published.get(row.shows_beat_id) : undefined;
  if (shown) return { label: `Beat ${shown.beatNumber}`, line: beatLine(shown), tag: hiddenTag };
  if (row.moment) return { label: 'A beat', line: momentLine(row.moment), tag: hiddenTag };
  return { label: 'The place', line: null, tag: hiddenTag };
}

export function captionText(picture: Pick<GalleryPicture, 'label' | 'line' | 'tag'>): string {
  return picture.label + (picture.line ? ` “${picture.line}”` : '') + (picture.tag ? ` · ${picture.tag}` : '');
}

export function picturesText(count: number): string {
  return count === 1 ? '1 picture' : `${count} pictures`;
}

export function galleryPictures(view: GalleryView): GalleryPicture[] {
  const seen = new Set<string>();
  const all: GalleryPicture[] = [];
  const add = (picture: GalleryPicture | null | undefined) => {
    if (!picture || seen.has(picture.id)) return;
    seen.add(picture.id);
    all.push(picture);
  };
  for (const member of view.cast) add(member.portrait);
  for (const scene of view.scenes) for (const picture of scene.pictures) add(picture);
  for (const group of view.morePortraits) for (const picture of group.pictures) add(picture);
  return all;
}

export function galleryCover(view: Pick<GalleryView, 'cast' | 'scenes' | 'morePortraits'>): GalleryPicture | null {
  for (const scene of view.scenes) for (const picture of scene.pictures) if (picture.tag === null) return picture;
  for (const member of view.cast) if (member.portrait && member.portrait.tag === null) return member.portrait;
  for (const group of view.morePortraits) for (const picture of group.pictures) if (picture.tag === null) return picture;
  return null;
}

export function onlyPlaced(view: GalleryView, placed: ReadonlySet<string>): GalleryView {
  const keep = (picture: GalleryPicture) => placed.has(picture.id);
  const cast: GalleryCastMember[] = [];
  for (const member of view.cast) {
    const portrait = member.portrait && keep(member.portrait) ? member.portrait : null;
    if (member.kind === 'player' || portrait) cast.push({ ...member, portrait });
  }
  const scenes = view.scenes
    .map(scene => ({ ...scene, pictures: scene.pictures.filter(keep) }))
    .filter(scene => scene.pictures.length > 0);
  const morePortraits = view.morePortraits
    .map(group => ({ ...group, pictures: group.pictures.filter(keep) }))
    .filter(group => group.pictures.length > 0);
  return { ...view, cast, scenes, morePortraits, cover: galleryCover({ cast, scenes, morePortraits }) };
}
