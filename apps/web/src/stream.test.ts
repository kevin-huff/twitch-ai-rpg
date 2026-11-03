import { describe, expect, it } from 'vitest';
import { STAGE_PIECES, parseStreamLocation, pieceInfo, pieceUrl, streamUrl } from './stream';

const o = 'https://x.test';
describe('streamUrl', () => {
  it('keeps today\'s shapes', () => {
    for (const layout of ['scene', 'overlay'] as const) {
      for (const audio of ['present', 'listen', 'off'] as const) {
        expect(streamUrl(o, 'tok', { layout, audio })).toBe(`${o}/stream?layout=${layout}&audio=${audio}#token=tok`);
        expect(streamUrl(o, 'tok', { layout, audio, checker: true })).toBe(`${o}/stream?layout=${layout}&audio=${audio}&bg=checker#token=tok`);
      }
    }
  });
  it('encodes the token', () => {
    expect(streamUrl(o, 'a b/c', { layout: 'scene', audio: 'listen' })).toBe(`${o}/stream?layout=scene&audio=listen#token=a%20b%2Fc`);
  });
  it('makes the sound link', () => {
    expect(streamUrl(o, 'tok', { layout: 'audio' })).toBe(`${o}/stream?layout=audio#token=tok`);
  });
});

describe('pieceUrl', () => {
  it('builds with and without options', () => {
    expect(pieceUrl(o, 'tok', { view: 'dice' })).toBe(`${o}/stream?view=dice#token=tok`);
    expect(pieceUrl(o, 'tok', { view: 'dice', who: 'c 1' })).toBe(`${o}/stream?view=dice&who=c%201#token=tok`);
    expect(pieceUrl(o, 'tok', { view: 'picture', audio: 'off', checker: true })).toBe(`${o}/stream?view=picture&audio=off&bg=checker#token=tok`);
    expect(pieceUrl(o, 'a/b', { view: 'party', who: 'w', audio: 'follow', checker: true })).toBe(`${o}/stream?view=party&who=w&audio=follow&bg=checker#token=a%2Fb`);
    expect(pieceUrl(o, 'tok', { view: 'dice', who: null })).toBe(`${o}/stream?view=dice#token=tok`);
  });
});

describe('parseStreamLocation', () => {
  const parse = (search: string, hash = '#token=t') => parseStreamLocation({ search, hash });
  it('reads the layout', () => {
    expect(parse('?layout=overlay').layout).toBe('overlay');
    expect(parse('?layout=audio').layout).toBe('audio');
    expect(parse('').layout).toBe('scene');
    expect(parse('?layout=junk').layout).toBe('scene');
  });
  it('reads the audio mode', () => {
    for (const a of ['present', 'listen', 'off', 'follow']) expect(parse(`?audio=${a}`).audio).toBe(a);
    expect(parse('?audio=loud').audio).toBeNull();
    expect(parse('').audio).toBeNull();
  });
  it('reads view and who', () => {
    expect(parse('?view=dice').view).toBe('dice');
    expect(parse('?view=nope').view).toBe('unknown');
    expect(parse('?view=').view).toBeNull();
    expect(parse('').view).toBeNull();
    expect(parse('?who=abc').who).toBe('abc');
    expect(parse('?who=').who).toBeNull();
    expect(parse('').who).toBeNull();
  });
  it('reads token, checker and check', () => {
    const r = parse('?bg=checker&check=1');
    expect(r).toMatchObject({ token: 't', checker: true, check: true });
    expect(parse('', '').token).toBeNull();
  });
});

describe('STAGE_PIECES', () => {
  it('lists the nine pieces in order', () => {
    expect(STAGE_PIECES.map((p) => p.view)).toEqual(['captions', 'dice', 'stakes', 'party', 'tracks', 'picture', 'badge', 'facts', 'corrections']);
    expect(STAGE_PIECES.map((p) => p.name)).toEqual(['Captions', 'Dice', 'Stakes', 'Party', 'Tracks', 'Picture', 'AI badge', 'Facts', 'Corrections']);
  });
  it('has boxes and flags', () => {
    expect(STAGE_PIECES.map((p) => [p.box.x, p.box.y, p.box.width, p.box.height])).toEqual([
      [240, 836, 1440, 184], [240, 686, 1440, 144], [480, 140, 960, 612], [96, 60, 1344, 76], [1472, 240, 352, 304],
      [96, 184, 336, 192], [1488, 60, 336, 164], [0, 0, 464, 345], [0, 0, 1728, 88],
    ]);
    expect(STAGE_PIECES.filter((p) => p.perCharacter).map((p) => p.view)).toEqual(['dice', 'stakes', 'party']);
    expect(STAGE_PIECES.filter((p) => p.followsSpeech).map((p) => p.view)).toEqual(['captions']);
  });
  it('has the about lines', () => {
    expect(pieceInfo('captions')?.about).toBe("The latest beat's lines, with the one being spoken marked.");
    expect(pieceInfo('dice')?.about).toBe('The latest rolls. Past six rolls they take two rows.');
    expect(pieceInfo('stakes')?.about).toBe('What is at stake before a roll, one person at a time.');
    expect(pieceInfo('party')?.about).toBe("Each character's name, portrait and strain.");
    expect(pieceInfo('tracks')?.about).toBe('The first two public tracks.');
    expect(pieceInfo('picture')?.about).toBe('The scene picture, or the picture you pinned.');
    expect(pieceInfo('badge')?.about).toBe('Says the narration and voices are made by AI, and whether the show is live.');
    expect(pieceInfo('facts')?.about).toBe('What the party knows, newest first.');
    expect(pieceInfo('corrections')?.about).toBe('The newest correction you published.');
  });
  it('returns null for unknown views', () => {
    expect(pieceInfo('nope')).toBeNull();
  });
});
