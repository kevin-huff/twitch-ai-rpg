import { StreamPieceSchema } from '@rpg/contracts';
import type { StreamAudio, StreamLayout, StreamPiece } from '@rpg/contracts';

export function streamUrl(origin: string, token: string, options: { layout: StreamLayout; audio?: StreamAudio; checker?: boolean }): string {
  return `${origin}/stream?layout=${options.layout}${options.audio ? `&audio=${options.audio}` : ''}${options.checker ? '&bg=checker' : ''}#token=${encodeURIComponent(token)}`;
}

export function pieceUrl(origin: string, token: string, options: { view: StreamPiece; who?: string | null; audio?: StreamAudio; checker?: boolean }): string {
  return `${origin}/stream?view=${options.view}${options.who ? `&who=${encodeURIComponent(options.who)}` : ''}${options.audio ? `&audio=${options.audio}` : ''}${options.checker ? '&bg=checker' : ''}#token=${encodeURIComponent(token)}`;
}

export function producerUrl(origin: string, token: string): string {
  return `${origin}/producer#token=${encodeURIComponent(token)}`;
}

export function readHashToken(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return token ? token : null;
}

export type PieceBox = { x: number; y: number; width: number; height: number };
export type PieceInfo = {
  view: StreamPiece;
  name: string;
  about: string;
  box: PieceBox;
  perCharacter: boolean;
  followsSpeech: boolean;
};

export const STAGE_PIECES: readonly PieceInfo[] = [
  { view: 'captions', name: 'Captions', about: "The latest beat's lines, with the one being spoken marked.", box: { x: 240, y: 836, width: 1440, height: 184 }, perCharacter: false, followsSpeech: true },
  { view: 'dice', name: 'Dice', about: 'The latest rolls. Past six rolls they take two rows.', box: { x: 240, y: 686, width: 1440, height: 144 }, perCharacter: true, followsSpeech: false },
  { view: 'stakes', name: 'Stakes', about: 'What is at stake before a roll, one person at a time.', box: { x: 480, y: 140, width: 960, height: 612 }, perCharacter: true, followsSpeech: false },
  { view: 'party', name: 'Party', about: "Each character's name, portrait and strain.", box: { x: 96, y: 60, width: 1344, height: 76 }, perCharacter: true, followsSpeech: false },
  { view: 'tracks', name: 'Tracks', about: 'The first two public tracks.', box: { x: 1472, y: 240, width: 352, height: 304 }, perCharacter: false, followsSpeech: false },
  { view: 'picture', name: 'Picture', about: 'The scene picture, or the picture the director pinned.', box: { x: 96, y: 184, width: 336, height: 192 }, perCharacter: false, followsSpeech: false },
  { view: 'badge', name: 'AI badge', about: 'Says the narration and voices are made by AI, and whether the show is live.', box: { x: 1488, y: 60, width: 336, height: 164 }, perCharacter: false, followsSpeech: false },
  { view: 'facts', name: 'Facts', about: 'What the party knows, newest first.', box: { x: 0, y: 0, width: 464, height: 345 }, perCharacter: false, followsSpeech: false },
  { view: 'corrections', name: 'Corrections', about: 'The newest correction the director published.', box: { x: 0, y: 0, width: 1728, height: 88 }, perCharacter: false, followsSpeech: false },
];

export function pieceInfo(view: string): PieceInfo | null {
  return STAGE_PIECES.find((piece) => piece.view === view) ?? null;
}

export function parseStreamLocation(location: { search: string; hash: string }) {
  const query = new URLSearchParams(location.search);
  const audio = query.get('audio');
  const layout = query.get('layout');
  const rawView = query.get('view');
  const knownView = StreamPieceSchema.safeParse(rawView);
  return {
    token: readHashToken(location.hash),
    layout: (layout === 'overlay' || layout === 'audio' ? layout : 'scene') as StreamLayout,
    audio: (audio === 'present' || audio === 'listen' || audio === 'off' || audio === 'follow' ? audio : null) as StreamAudio | null,
    checker: query.get('bg') === 'checker',
    check: query.get('check') === '1',
    view: (!rawView ? null : knownView.success ? knownView.data : 'unknown') as StreamPiece | 'unknown' | null,
    who: query.get('who') || null,
  };
}
