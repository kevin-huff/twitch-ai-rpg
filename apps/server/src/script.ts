import { randomUUID } from 'node:crypto';
import { hasAudioTags, isSpokenSegmentKind, playerWords, stripAudioTags, type Beat, type ScriptSegment, type SessionState, type SpokenSegmentKind } from '@rpg/contracts';

function playerSegments(beat: Beat, state: SessionState): ScriptSegment[] {
  return beat.lockedSubmissions.filter((submission) => submission.kind !== 'ooc').flatMap((submission): ScriptSegment[] => {
    const words = playerWords(submission);
    const tagged = hasAudioTags(words);
    const text = tagged ? stripAudioTags(words) : words;
    if (!text.trim()) return [];
    const character = state.characters.find((candidate) => candidate.id === submission.characterId)!;
    const say = submission.kind !== 'act';
    return [{
      id: randomUUID(), kind: say ? 'player_dialogue' : 'player_action', text,
      speaker: { entityId: submission.characterId, displayName: character.displayName },
      recipientCharacterIds: [], delivery: 'neutral', sourceSubmissionIds: [submission.id],
      voiceProfileId: say ? character.voiceProfileId ?? null : null, ttsEnabled: false,
      ...(tagged ? { voiceText: words } : {}),
    }];
  });
}

export function makeScript(beat: Beat, state: SessionState): ScriptSegment[] {
  const segments: ScriptSegment[] = beat.draft!.segments.map((segment) => {
    const npc = segment.kind === 'npc_dialogue' ? state.npcs.find((npc) => npc.id === segment.speakerNpcId)! : null;
    return { id: randomUUID(), kind: segment.kind, text: segment.text, speaker: npc ? { entityId: npc.id, displayName: npc.displayName } : null,
      recipientCharacterIds: segment.recipientCharacterIds, delivery: segment.delivery, sourceSubmissionIds: beat.lockedSubmissions.map((submission) => submission.id), voiceProfileId: npc?.voiceProfileId ?? 'voice_narrator', ttsEnabled: false,
      ...(segment.voiceText ? { voiceText: segment.voiceText } : {}) };
  });
  return [...playerSegments(beat, state), ...segments];
}

export interface SpeechLine { kind: SpokenSegmentKind; text: string; speaker: string; voiceProfileId: string; delivery: ScriptSegment['delivery']; voiceText?: string }

function projectLines(segments: readonly ScriptSegment[], keepPlayerVoice: boolean): SpeechLine[] {
  return segments.filter((segment) => isSpokenSegmentKind(segment.kind)).map((segment) => ({
    kind: segment.kind as SpokenSegmentKind, text: segment.text, speaker: segment.speaker?.displayName ?? 'Narrator',
    voiceProfileId: segment.kind === 'player_dialogue' && !keepPlayerVoice ? 'voice_narrator' : segment.voiceProfileId ?? 'voice_narrator',
    delivery: segment.delivery,
    ...(segment.voiceText ? { voiceText: segment.voiceText } : {}),
  }));
}

// The hash projection: a player's chosen voice never changes it.
export function speechLines(segments: readonly ScriptSegment[]): SpeechLine[] {
  return projectLines(segments, false);
}

// The lines a preparation stores and speaks: Say lines keep their chosen voice.
export function voicedLines(segments: readonly ScriptSegment[]): SpeechLine[] {
  return projectLines(segments, true);
}
