import { z } from 'zod';

export const PRESENTER_LEASE_MS = 10_000;
export const PRESENTER_RENEW_MS = 2_000;
export const PLAYBACK_POSITION_REPORT_MS = 1_000;
export const PLAYBACK_SCHEDULE_LEAD_MS = 500;
export const PLAYBACK_SEEK_THRESHOLD_MS = 750;
export const MAX_PLAYBACK_POSITION_MS = 3_600_000;
// 30 script segments plus up to 12 player lines (plan_beat selects at most 12) in one recording.
export const MAX_SPOKEN_SEGMENTS = 42;

const id = z.string().min(1).max(128);
const revision = z.number().int().nonnegative();
const time = z.number().int().nonnegative();
const position = z.number().int().min(0).max(MAX_PLAYBACK_POSITION_MS);
const segmentIndex = z.number().int().min(0).max(MAX_SPOKEN_SEGMENTS - 1);
export const AudioManifestSchema = z.strictObject({
  beatId: id,
  segments: z.array(z.strictObject({
    id, text: z.string().min(1).max(6000), speaker: z.string().min(1).max(120), voiceProfileId: id,
    url: z.string().regex(/^\/api\/sessions\/[^/?#]+\/audio\/assets\/[a-f0-9]{64}$/),
  })).min(1).max(MAX_SPOKEN_SEGMENTS),
});
export type AudioManifest = z.infer<typeof AudioManifestSchema>;

export const PlaybackSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), sessionId: id, revision, sampleRevision: revision, serverTimeMs: time,
  playbackId: z.uuid().nullable(), status: z.enum(['idle', 'playing', 'paused', 'stopped', 'complete']),
  manifest: AudioManifestSchema.nullable(), segmentIndex: segmentIndex.nullable(), positionMs: position,
  anchorTimeMs: time.nullable(), presenter: z.strictObject({ available: z.boolean(), leaseExpiresAtMs: time.nullable(), source: z.enum(['show_link', 'preview']).nullable().optional() }),
});
export type PlaybackSnapshot = z.infer<typeof PlaybackSnapshotSchema>;

const commandBase = { commandId: id, expectedRevision: revision };
export const PlaybackCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...commandBase, type: z.literal('start'), beatId: id }),
  ...(['pause', 'resume', 'stop', 'skip'] as const).map(type => z.strictObject({ ...commandBase, type: z.literal(type), playbackId: z.uuid() })),
]);
export type PlaybackCommand = z.infer<typeof PlaybackCommandSchema>;
const owner = { commandId: id, clientId: z.uuid(), leaseId: z.uuid() };
export const PresenterCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...commandBase, type: z.literal('claim'), clientId: z.uuid() }),
  z.strictObject({ ...owner, type: z.literal('renew'), renewalSequence: z.number().int().positive() }),
  z.strictObject({ ...owner, type: z.literal('release') }),
]);
export type PresenterCommand = z.infer<typeof PresenterCommandSchema>;
const telemetry = { ...owner, playbackId: z.uuid(), expectedRevision: revision, segmentIndex, telemetrySequence: z.number().int().positive() };
export const PlaybackTelemetrySchema = z.discriminatedUnion('type', [
  z.strictObject({ ...telemetry, type: z.literal('position'), positionMs: position }),
  z.strictObject({ ...telemetry, type: z.literal('ended') }),
  z.strictObject({ ...telemetry, type: z.literal('error') }),
]);
export type PlaybackTelemetry = z.infer<typeof PlaybackTelemetrySchema>;
export const PlaybackResponseSchema = z.strictObject({ snapshot: PlaybackSnapshotSchema, leaseId: z.uuid().optional() });
export type PlaybackResponse = z.infer<typeof PlaybackResponseSchema>;
export const ShowAudioHolderSchema = z.strictObject({
  holderId: z.uuid(), label: z.string().min(1).max(80), showTitle: z.string().max(160),
  browser: z.enum(['obs', 'browser', 'unknown']), claimedAt: z.iso.datetime().nullable(),
});
export type ShowAudioHolder = z.infer<typeof ShowAudioHolderSchema>;
export const ShowAudioHolderResponseSchema = z.strictObject({ holder: ShowAudioHolderSchema.nullable() });
export type ShowAudioHolderResponse = z.infer<typeof ShowAudioHolderResponseSchema>;
export const StopShowAudioSchema = z.strictObject({ commandId: id, holderId: z.uuid() });
export type StopShowAudio = z.infer<typeof StopShowAudioSchema>;
