import { describe, expect, it } from 'vitest';
import { spokenPlayerText, type Beat, type ScriptSegment, type Submission } from '@rpg/contracts';
import { createLedgerState } from '@rpg/test-fixtures';
import { pictureLines } from '../src/picture-cast';
import { makeScript, speechLines, voicedLines } from '../src/script';

let counter = 0;
const state = createLedgerState('session', () => `id-${++counter}`);
const [rook, lark] = state.characters;
const mara = state.npcs[0];

function line(characterId: string, kind: Submission['kind'], fields: Partial<Submission>): Submission {
  return { id: `sub-${++counter}`, sessionId: 'session', characterId, contextBeatId: null, inputEpoch: 0, revision: 1, kind, text: '', recipientNpcIds: [], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: true, status: 'locked', ...fields };
}
function beatWith(lockedSubmissions: Submission[]): Beat {
  return {
    id: 'beat', sessionId: 'session', kind: 'action', phase: 'review', revision: 1, inputEpoch: 0, sourceStateRevision: 0, selectedSubmissionIds: [], lockedSubmissions,
    contracts: [], stakesApproved: true, classification: 'action', inputSnapshotHash: null, resolution: null, draftRevision: 1, approvedContinuity: [], generation: 1, lastError: null,
    draft: { segments: [
      { kind: 'narration', text: 'Rain taps the glass.', recipientCharacterIds: [], delivery: 'neutral' },
      { kind: 'npc_dialogue', speakerNpcId: mara.id, text: 'Show me a receipt.', recipientCharacterIds: [rook.id], delivery: 'wary' },
    ] },
  } as unknown as Beat;
}

describe('makeScript', () => {
  const act = line(rook.id, 'act', { intent: 'I climb the fire escape', approach: 'quietly' });
  const say = line(rook.id, 'say', { text: '  Keep watch.  ' });
  const other = line(lark.id, 'say', { text: 'On it.' });
  const ooc = line(lark.id, 'ooc', { text: 'brb' });
  const script = makeScript(beatWith([act, ooc, say, other]), state);

  it('puts player actions and lines first, word for word, then the draft', () => {
    expect(script.map((s) => s.kind)).toEqual(['player_action', 'player_dialogue', 'player_dialogue', 'narration', 'npc_dialogue']);
    expect(script[0]).toMatchObject({ text: 'I climb the fire escape\nquietly', speaker: { entityId: rook.id, displayName: rook.displayName }, sourceSubmissionIds: [act.id], voiceProfileId: null, ttsEnabled: false, delivery: 'neutral', recipientCharacterIds: [] });
    expect(script[1]).toMatchObject({ text: '  Keep watch.  ', sourceSubmissionIds: [say.id] });
    expect(script[2]).toMatchObject({ text: 'On it.', speaker: { entityId: lark.id, displayName: lark.displayName }, sourceSubmissionIds: [other.id] });
    expect(script[3]).toMatchObject({ text: 'Rain taps the glass.', speaker: null, voiceProfileId: 'voice_narrator' });
    expect(script[4]).toMatchObject({ speaker: { entityId: mara.id, displayName: 'Mara Vale' }, voiceProfileId: mara.voiceProfileId, sourceSubmissionIds: [act.id, ooc.id, say.id, other.id] });
  });

  it('skips ooc lines and blank lines', () => {
    expect(script.some((s) => s.text === 'brb')).toBe(false);
    const blank = makeScript(beatWith([line(rook.id, 'say', { text: '   ' }), line(rook.id, 'act', { intent: ' ', approach: '' })]), state);
    expect(blank.map((s) => s.kind)).toEqual(['narration', 'npc_dialogue']);
  });

  it('gives every segment a unique id', () => {
    expect(new Set(script.map((s) => s.id)).size).toBe(script.length);
  });
});

describe('makeScript pairs', () => {
  const a = line(rook.id, 'say', { text: 'One.' });
  const b = line(lark.id, 'say', { text: 'Two.' });
  const c = line(rook.id, 'act', { intent: 'Three', approach: '' });
  const blank = line(lark.id, 'say', { text: '   ' });
  const ooc = line(lark.id, 'ooc', { text: 'brb' });
  const withMarks = (locked: Submission[], marks: (string | undefined)[]): Beat => {
    const beat = beatWith(locked);
    const segs = [
      { kind: 'narration', text: 'N1', recipientCharacterIds: [], delivery: 'neutral' },
      { kind: 'narration', text: 'N2', recipientCharacterIds: [], delivery: 'neutral' },
      { kind: 'narration', text: 'N3', recipientCharacterIds: [], delivery: 'neutral' },
    ];
    beat.draft = { segments: segs.map((seg, i) => (marks[i] ? { ...seg, answersSubmissionId: marks[i] } : seg)) } as never;
    return beat;
  };
  const texts = (s: ScriptSegment[]) => s.map((x) => x.text);
  const today = ['One.', 'Two.', 'Three', 'N1', 'N2', 'N3'];

  it('plays each answered line just before its piece and unanswered lines first', () => {
    const script = makeScript(withMarks([a, b, c], [undefined, c.id, a.id]), state);
    expect(texts(script)).toEqual(['Two.', 'N1', 'Three', 'N2', 'One.', 'N3']);
    expect(script.every((s) => !('answersSubmissionId' in s))).toBe(true);
  });
  it('keeps today order without marks', () => {
    expect(texts(makeScript(withMarks([a, b, c], []), state))).toEqual(today);
  });
  it('keeps today order for an unknown mark', () => {
    expect(texts(makeScript(withMarks([a, b, c], ['nope', a.id]), state))).toEqual(today);
  });
  it('keeps today order for a mark on an ooc or blank line', () => {
    expect(texts(makeScript(withMarks([a, ooc, blank, b, c], [ooc.id]), state))).toEqual(today);
    expect(texts(makeScript(withMarks([a, ooc, blank, b, c], [undefined, blank.id]), state))).toEqual(today);
  });
  it('puts the line before the first of two pieces that answer it', () => {
    expect(texts(makeScript(withMarks([a, b, c], [b.id, b.id]), state))).toEqual(['One.', 'Three', 'Two.', 'N1', 'N2', 'N3']);
  });
  it('makes speechLines and voicedLines follow the new order', () => {
    const script = makeScript(withMarks([a, b, c], [b.id]), state);
    expect(speechLines(script).map((l) => l.text)).toEqual(['One.', 'Three', 'Two.', 'N1', 'N2', 'N3']);
    expect(voicedLines(script).map((l) => l.text)).toEqual(speechLines(script).map((l) => l.text));
  });
});

describe('speechLines', () => {
  const segments = [
    ...makeScript(beatWith([line(rook.id, 'act', { intent: 'I leap' })]), state),
    { id: 's', kind: 'system', text: 'Roll', speaker: null, recipientCharacterIds: [], delivery: 'neutral', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false } as ScriptSegment,
  ];
  const lines = speechLines(segments);

  it('drops system segments and applies the defaults', () => {
    expect(lines.map((l) => l.kind)).toEqual(['player_action', 'narration', 'npc_dialogue']);
    expect(lines[0]).toMatchObject({ speaker: rook.displayName, voiceProfileId: 'voice_narrator', text: 'I leap' });
    expect(lines[1]).toMatchObject({ speaker: 'Narrator', voiceProfileId: 'voice_narrator' });
    expect(lines[2]).toMatchObject({ speaker: 'Mara Vale', voiceProfileId: mara.voiceProfileId, delivery: 'wary' });
  });

  it('keeps the key order that recordings are hashed with', () => {
    expect(Object.keys(lines[0])).toEqual(['kind', 'text', 'speaker', 'voiceProfileId', 'delivery']);
  });
});

describe('answered marks', () => {
  const a = line(rook.id, 'say', { text: 'One.' });
  const b = line(lark.id, 'say', { text: 'Two.' });
  const c = line(rook.id, 'act', { intent: 'Three', approach: '' });
  const marked = (marks: (string | undefined)[]): Beat => {
    const beat = beatWith([a, b, c]);
    const segs = ['N1', 'N2', 'N3'].map((text) => ({ kind: 'narration', text, recipientCharacterIds: [], delivery: 'neutral' }));
    beat.draft = { segments: segs.map((seg, i) => (marks[i] ? { ...seg, answersSubmissionId: marks[i] } : seg)) } as never;
    return beat;
  };

  it('marks only the player lines placed just before the piece answering them', () => {
    const script = makeScript(marked([undefined, c.id, a.id]), state);
    expect(script.map((s) => s.text)).toEqual(['Two.', 'N1', 'Three', 'N2', 'One.', 'N3']);
    expect(script.map((s) => s.answered)).toEqual([undefined, undefined, true, undefined, true, undefined]);
    expect(script.filter((s) => !s.answered).every((s) => !('answered' in s))).toBe(true);
  });
  it('adds no answered key without marks', () => {
    expect(makeScript(marked([]), state).every((s) => !('answered' in s))).toBe(true);
  });
  it('gives speechLines and voicedLines the same output with or without the marks', () => {
    const script = makeScript(marked([undefined, c.id, a.id]), state);
    const bare = script.map(({ answered: _answered, ...rest }) => rest);
    expect(speechLines(script)).toEqual(speechLines(bare));
    expect(voicedLines(script)).toEqual(voicedLines(bare));
    expect(speechLines(script).every((l) => !('answered' in l))).toBe(true);
  });
});

describe('spokenPlayerText', () => {
  const words = (kind: Submission['kind'], fields: Partial<Submission>) => spokenPlayerText(line(rook.id, kind, fields));
  it('keeps a plain Say line exactly as typed', () => {
    expect(words('say', { text: '  Keep watch.  ' })).toBe('  Keep watch.  ');
  });
  it('removes audio tags from a tagged line', () => {
    expect(words('say', { text: '[laughs] Fine, I will do it.' }).trim()).toBe('Fine, I will do it.');
  });
  it('leaves nothing for a line that is only a tag', () => {
    expect(words('say', { text: '[laughs]' }).trim()).toBe('');
  });
  it('joins a Do line intent and approach, and strips its tags', () => {
    expect(words('act', { intent: 'I climb', approach: 'quietly' })).toBe('I climb\nquietly');
    expect(words('act', { intent: 'I climb [grunts] up', approach: '' }).replace(/\s+/g, ' ').trim()).toBe('I climb up');
  });
});

describe('tags and voices', () => {
  const withVoice = { ...state, characters: state.characters.map((character) => (character.id === rook.id ? { ...character, voiceProfileId: 'eleven:fake-ada' } : character)) };
  const tagged = line(rook.id, 'say', { text: '[laughs] Fine, I will do it.' });
  const plain = line(lark.id, 'say', { text: 'Two  spaces   here.' });
  const act = line(rook.id, 'act', { intent: 'I climb [grunts] up', approach: 'quietly' });

  it('publishes a tagged Say line without its tags and keeps the typed words as voiceText', () => {
    const [segment] = makeScript(beatWith([tagged]), state);
    expect(segment.text).toBe('Fine, I will do it.');
    expect(segment.voiceText).toBe('[laughs] Fine, I will do it.');
  });

  it('publishes an untagged line exactly as typed, with no voiceText key', () => {
    const [segment] = makeScript(beatWith([plain]), state);
    expect(segment.text).toBe('Two  spaces   here.');
    expect('voiceText' in segment).toBe(false);
  });

  it('skips a line that is only tags', () => {
    const script = makeScript(beatWith([line(rook.id, 'say', { text: '[laughs]' })]), state);
    expect(script.map((s) => s.kind)).toEqual(['narration', 'npc_dialogue']);
  });

  it('leaves a tags-only line out of the script and keeps the rest', () => {
    const script = makeScript(beatWith([line(rook.id, 'say', { text: '[laughs]' }), plain]), state);
    expect(script.map((s) => s.text)).toEqual(['Two  spaces   here.', 'Rain taps the glass.', 'Show me a receipt.']);
  });

  it('gives a Say line the speaker voice and a Do line null', () => {
    const script = makeScript(beatWith([act, tagged, plain]), withVoice);
    expect(script.map((s) => [s.kind, s.voiceProfileId])).toEqual([
      ['player_action', null], ['player_dialogue', 'eleven:fake-ada'], ['player_dialogue', null], ['narration', 'voice_narrator'], ['npc_dialogue', mara.voiceProfileId],
    ]);
    expect(script[0].text).toBe('I climb up\nquietly');
    expect(script[0].voiceText).toBe('I climb [grunts] up\nquietly');
  });

  it('copies an AI segment voiceText', () => {
    const beat = beatWith([]);
    beat.draft!.segments[0] = { ...beat.draft!.segments[0], voiceText: '[softly] Rain taps the glass.' } as never;
    const script = makeScript(beat, state);
    expect(script[0].voiceText).toBe('[softly] Rain taps the glass.');
    expect('voiceText' in script[1]).toBe(false);
  });

  it('keeps the hash projection the same whatever voice a player picked', () => {
    const before = JSON.stringify(speechLines(makeScript(beatWith([tagged, plain]), state)));
    const after = JSON.stringify(speechLines(makeScript(beatWith([tagged, plain]), withVoice)));
    expect(after).toBe(before);
    const untagged = speechLines(makeScript(beatWith([plain]), state));
    expect(untagged.every((l) => !('voiceText' in l))).toBe(true);
    expect(speechLines(makeScript(beatWith([tagged]), withVoice))[0]).toMatchObject({ voiceProfileId: 'voice_narrator', voiceText: '[laughs] Fine, I will do it.' });
  });

  it('keeps the chosen voice in voicedLines', () => {
    const lines = voicedLines(makeScript(beatWith([tagged, plain, act]), withVoice));
    expect(lines.map((l) => [l.kind, l.voiceProfileId])).toEqual([
      ['player_dialogue', 'eleven:fake-ada'], ['player_dialogue', 'voice_narrator'], ['player_action', 'voice_narrator'], ['narration', 'voice_narrator'], ['npc_dialogue', mara.voiceProfileId],
    ]);
  });

  it('shows a tagged player line without its tags in the picture lines of a round in review', () => {
    const beat = beatWith([tagged, plain]);
    const lines = pictureLines(withVoice, { beat, published: null });
    expect(lines[0]).toMatchObject({ kind: 'player_dialogue', text: 'Fine, I will do it.' });
    expect(lines[1]).toMatchObject({ text: 'Two  spaces   here.' });
    const tagOnly = pictureLines(withVoice, { beat: beatWith([line(rook.id, 'say', { text: '[sighs]' })]), published: null });
    expect(tagOnly.some((l) => l.kind === 'player_dialogue')).toBe(false);
  });
});
