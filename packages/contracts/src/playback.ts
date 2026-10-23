import { z } from 'zod';

export const PRESENTER_LEASE_MS = 10_000;
export const PRESENTER_RENEW_MS = 2_000;
export const PLAYBACK_POSITION_REPORT_MS = 1_000;
export const PLAYBACK_SCHEDULE_LEAD_MS = 500;
export const PLAYBACK_SEEK_THRESHOLD_MS = 750;
export const MAX_PLAYBACK_POSITION_MS = 3_600_000;

const id = z.string().min(1).max(128);
const revision = z.number().int().nonnegative();
const time = z.number().int().nonnegative();
const position = z.number().int().min(0).max(MAX_PLAYBACK_POSITION_MS);
const segmentIndex = z.number().int().min(0).max(29);
export const AudioManifestSchema = z.strictObject({
  beatId: id,
  segments: z.array(z.strictObject({
    id, text: z.string().min(1).max(6000), speaker: z.string().min(1).max(120), voiceProfileId: id,
    url: z.string().regex(/^\/api\/sessions\/[^/?#]+\/audio\/assets\/[a-f0-9]{64}$/),
  })).min(1).max(30),
});
export type AudioManifest = z.infer<typeof AudioManifestSchema>;

export const PlaybackSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), sessionId: id, revision, sampleRevision: revision, serverTimeMs: time,
  playbackId: z.uuid().nullable(), status: z.enum(['idle', 'playing', 'paused', 'stopped', 'complete']),
  manifest: AudioManifestSchema.nullable(), segmentIndex: segmentIndex.nullable(), positionMs: position,
  anchorTimeMs: time.nullable(), presenter: z.strictObject({ available: z.boolean(), leaseExpiresAtMs: time.nullable() }),
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
