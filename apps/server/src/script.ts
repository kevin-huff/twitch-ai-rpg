import { randomUUID } from 'node:crypto';
import { isSpokenSegmentKind, playerWords, type Beat, type ScriptSegment, type SessionState, type SpokenSegmentKind } from '@rpg/contracts';

export function makeScript(beat: Beat, state: SessionState): ScriptSegment[] {
  const quotes: ScriptSegment[] = beat.lockedSubmissions.filter((submission) => submission.kind !== 'ooc' && playerWords(submission).trim()).map((submission) => ({
    id: randomUUID(), kind: submission.kind === 'act' ? 'player_action' : 'player_dialogue', text: playerWords(submission),
    speaker: { entityId: submission.characterId, displayName: state.characters.find((character) => character.id === submission.characterId)!.displayName },
    recipientCharacterIds: [], delivery: 'neutral', sourceSubmissionIds: [submission.id], voiceProfileId: null, ttsEnabled: false,
  }));
  const segments: ScriptSegment[] = beat.draft!.segments.map((segment) => {
    const npc = segment.kind === 'npc_dialogue' ? state.npcs.find((npc) => npc.id === segment.speakerNpcId)! : null;
    return { id: randomUUID(), kind: segment.kind, text: segment.text, speaker: npc ? { entityId: npc.id, displayName: npc.displayName } : null,
      recipientCharacterIds: segment.recipientCharacterIds, delivery: segment.delivery, sourceSubmissionIds: beat.lockedSubmissions.map((submission) => submission.id), voiceProfileId: npc?.voiceProfileId ?? 'voice_narrator', ttsEnabled: false };
  });
  return [...quotes, ...segments];
}

export interface SpeechLine { kind: SpokenSegmentKind; text: string; speaker: string; voiceProfileId: string; delivery: ScriptSegment['delivery'] }

export function speechLines(segments: readonly ScriptSegment[]): SpeechLine[] {
  return segments.filter((segment) => isSpokenSegmentKind(segment.kind)).map((segment) => ({
    kind: segment.kind as SpokenSegmentKind, text: segment.text, speaker: segment.speaker?.displayName ?? 'Narrator',
    voiceProfileId: segment.voiceProfileId ?? 'voice_narrator', delivery: segment.delivery,
  }));
}
