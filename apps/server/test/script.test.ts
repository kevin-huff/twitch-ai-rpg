import { describe, expect, it } from 'vitest';
import type { Beat, ScriptSegment, Submission } from '@rpg/contracts';
import { createLedgerState } from '@rpg/test-fixtures';
import { makeScript, speechLines } from '../src/script';

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
