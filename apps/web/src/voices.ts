import { elevenVoiceId } from '@rpg/contracts';
import type { VoiceList, VoiceOption } from '@rpg/contracts';
import { api } from './api';

const FAILED_REASON = 'The voice list could not be loaded. The narrator reads every line.';

let kept: VoiceList | null = null;
let pending: Promise<VoiceList> | null = null;

export function loadVoices(): Promise<VoiceList> {
  if (kept) return Promise.resolve(kept);
  if (pending) return pending;
  const attempt = (async (): Promise<VoiceList> => {
    try {
      const list = await api.voices();
      if (!list.reason) kept = list;
      return list;
    } catch {
      return { voices: [], reason: FAILED_REASON };
    }
  })();
  pending = attempt;
  void attempt.then(() => { if (pending === attempt) pending = null; });
  return attempt;
}

export function npcVoicePick(value: string): string | null {
  return elevenVoiceId(value) === null ? null : value;
}

export function npcVoiceValue(pick: string | null, previous: string): string {
  if (pick !== null) return pick;
  return elevenVoiceId(previous) !== null ? 'narrator' : previous;
}

export function voiceName(ref: string | null | undefined, voices: VoiceOption[], narratorLabel: string): string {
  if (!ref || elevenVoiceId(ref) === null) return narratorLabel;
  return voices.find((voice) => voice.id === ref)?.name ?? 'Unlisted voice';
}
