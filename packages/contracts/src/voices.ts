import { z } from 'zod';

export const ELEVEN_PREFIX = 'eleven:';
export const VoiceRefSchema = z.string().regex(/^eleven:[A-Za-z0-9_-]{1,121}$/);
export function elevenVoiceId(ref?: string | null): string | null {
  if (typeof ref !== 'string' || !VoiceRefSchema.safeParse(ref).success) return null;
  return ref.slice(ELEVEN_PREFIX.length);
}

export const VoiceGroupSchema = z.enum(['clone', 'added', 'standard']);
export const VoiceOptionSchema = z.strictObject({
  id: VoiceRefSchema, name: z.string().min(1), group: VoiceGroupSchema, summary: z.string(),
  previewUrl: z.string().url().nullable(), tuned: z.boolean(),
});
export type VoiceOption = z.infer<typeof VoiceOptionSchema>;
export const VoiceListSchema = z.strictObject({ voices: z.array(VoiceOptionSchema), reason: z.string().min(1).optional() });
export type VoiceList = z.infer<typeof VoiceListSchema>;
export interface VoiceSource { listVoices(): Promise<VoiceList> }
export type VoiceChoice = Pick<VoiceOption, 'id' | 'name' | 'summary'>;

export const FAKE_VOICES: VoiceOption[] = [
  { id: 'eleven:fake-ada', name: 'Ada', group: 'clone', summary: 'female · young · american · bright', previewUrl: 'https://example.invalid/voices/ada.mp3', tuned: true },
  { id: 'eleven:fake-bram', name: 'Bram', group: 'added', summary: 'male · old · irish · raspy', previewUrl: 'https://example.invalid/voices/bram.mp3', tuned: false },
  { id: 'eleven:fake-cyd', name: 'Cyd', group: 'standard', summary: 'neutral · middle aged · british · calm', previewUrl: 'https://example.invalid/voices/cyd.mp3', tuned: true },
];
export const fakeVoiceSource: VoiceSource = {
  listVoices: async () => ({ voices: FAKE_VOICES.map((voice) => ({ ...voice })) }),
};

const AUDIO_TAG = /\[[^\[\]]*\]/;
export function hasAudioTags(text: string): boolean {
  return AUDIO_TAG.test(text);
}
export function stripAudioTags(text: string): string {
  return text
    .replace(/([\u2014\u2013-])\[[^\[\]]*\][ \t]*/g, '$1')
    .replace(/[ \t]*\[[^\[\]]*\](?=[ \t]*[.,!?;:\u2026)\u201d\u2019"'])/g, '')
    .replace(/\[[^\[\]]*\]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}
const words = (value: string) => value.replace(/\s+/g, ' ').trim();
export function voiceTextMatches(text: string, voiceText: string): boolean {
  if (/<\/?[a-z][^>]*>/i.test(voiceText)) return false;
  const pieces = voiceText.split(/\[[^\[\]]*\]/).map(words);
  const last = pieces.length - 1;
  const target = words(text);
  let position = 0;
  for (let index = 0; index <= last; index += 1) {
    const piece = pieces[index];
    if (!target.startsWith(piece, position)) return false;
    position += piece.length;
    if (index < last && target[position] === ' ') position += 1;
  }
  return position === target.length;
}

export const DELIVERY_TAGS = { neutral: '', quiet: '[quietly]', urgent: '[urgently]', amused: '[amused]' } as const;
export function voicedWords(line: { text: string; voiceText?: string; delivery: keyof typeof DELIVERY_TAGS }): string {
  if (line.voiceText) return line.voiceText;
  const tag = DELIVERY_TAGS[line.delivery];
  return tag ? `${tag} ${line.text}` : line.text;
}
