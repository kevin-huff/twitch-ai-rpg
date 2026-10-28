import { z } from 'zod';
import { MAX_SPOKEN_SEGMENTS } from './playback';

const id = z.string().min(1).max(128);
const revision = z.number().int().nonnegative();
export const PrepareDraftAudioSchema = z.strictObject({ commandId: id, expectedBeatRevision: revision, draftRevision: revision, generation: revision });
export type PrepareDraftAudio = z.infer<typeof PrepareDraftAudioSchema>;

export const DraftAudioManifestSchema = z.strictObject({
  preparationId: z.uuid(), beatId: id, draftRevision: revision, generation: revision,
  segments: z.array(z.strictObject({
    index: z.number().int().min(0).max(MAX_SPOKEN_SEGMENTS - 1), text: z.string().min(1).max(6000), speaker: z.string().min(1).max(120), voiceProfileId: id,
    url: z.string().regex(/^\/api\/sessions\/[^/?#]+\/beats\/[^/?#]+\/draft-audio\/[a-f0-9-]{36}\/segments\/\d+$/),
  })).min(1).max(MAX_SPOKEN_SEGMENTS),
}).refine(manifest => manifest.segments.every((segment, index) => segment.index === index && segment.url.endsWith(`/beats/${encodeURIComponent(manifest.beatId)}/draft-audio/${manifest.preparationId}/segments/${index}`)), 'Preview segments must match the selected preparation and saved order.');
export type DraftAudioManifest = z.infer<typeof DraftAudioManifestSchema>;

export const DraftAudioResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('missing') }),
  z.strictObject({ status: z.literal('unavailable') }),
  z.strictObject({ status: z.literal('preparing'), preparationId: z.uuid() }),
  z.strictObject({ status: z.literal('failed'), preparationId: z.uuid() }),
  z.strictObject({ status: z.literal('ready'), manifest: DraftAudioManifestSchema }),
]);
export type DraftAudioResponse = z.infer<typeof DraftAudioResponseSchema>;
