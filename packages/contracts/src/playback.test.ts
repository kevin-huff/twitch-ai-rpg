import { describe, expect, it } from 'vitest';
import { AudioManifestSchema, PlaybackCommandSchema, PlaybackSnapshotSchema, PlaybackTelemetrySchema, PresenterCommandSchema, PlaybackResponseSchema } from './playback';
import { DraftAudioManifestSchema } from './draft-audio';

const manifest = { beatId: 'beat', segments: [{ id: 'line', text: 'A public line.', speaker: 'Mara', voiceProfileId: 'voice_mara', url: '/api/sessions/show/audio/assets/' + 'a'.repeat(64) }] };
const preparationId = '44444444-4444-4444-8444-444444444444';
const base = { commandId: 'command', expectedRevision: 2 };
const owner = { commandId: 'command', clientId: '11111111-1111-4111-8111-111111111111', leaseId: '22222222-2222-4222-8222-222222222222' };
const telemetry = { ...owner, playbackId: '33333333-3333-4333-8333-333333333333', expectedRevision: 3, segmentIndex: 0, telemetrySequence: 1 };
const snapshot = { schemaVersion: 1, sessionId: 'show', revision: 3, sampleRevision: 5, serverTimeMs: 1000, playbackId: '33333333-3333-4333-8333-333333333333', status: 'playing', manifest, segmentIndex: 0, positionMs: 100, anchorTimeMs: 1500, presenter: { available: true, leaseExpiresAtMs: 11000 } };

describe('coordinated published playback contracts', () => {
  it('accepts separate host controls, presenter ownership, and sequenced telemetry', () => {
    expect(PlaybackCommandSchema.parse({ ...base, type: 'start', beatId: 'beat' })).toMatchObject({ type: 'start' });
    for (const type of ['pause', 'resume', 'stop', 'skip']) expect(PlaybackCommandSchema.safeParse({ ...base, type, playbackId: '33333333-3333-4333-8333-333333333333' }).success).toBe(true);
    expect(PresenterCommandSchema.safeParse({ ...base, type: 'claim', clientId: '11111111-1111-4111-8111-111111111111' }).success).toBe(true);
    expect(PresenterCommandSchema.safeParse({ ...owner, type: 'renew', renewalSequence: 1 }).success).toBe(true);
    expect(PresenterCommandSchema.safeParse({ ...owner, type: 'release' }).success).toBe(true);
    expect(PlaybackTelemetrySchema.safeParse({ ...telemetry, type: 'position', positionMs: 1000 }).success).toBe(true);
    for (const type of ['ended', 'error']) expect(PlaybackTelemetrySchema.safeParse({ ...telemetry, type }).success).toBe(true);
  });
  it('bounds positions, segment indices, revisions, and independent sequence counters', () => {
    for (const patch of [{ positionMs: -1 }, { positionMs: 3_600_001 }, { positionMs: 0.5 }, { segmentIndex: 42 }, { telemetrySequence: 0 }, { expectedRevision: -1 }, { renewalSequence: 1 }, { privateNotes: 'secret' }]) {
      expect(PlaybackTelemetrySchema.safeParse({ ...telemetry, type: 'position', positionMs: 100, ...patch }).success).toBe(false);
    }
    expect(PresenterCommandSchema.safeParse({ ...owner, type: 'renew', renewalSequence: 0 }).success).toBe(false);
    expect(PlaybackCommandSchema.safeParse({ ...base, type: 'start', beatId: 'beat', manifest }).success).toBe(false);
    expect(PlaybackCommandSchema.safeParse({ ...base, type: 'pause' }).success).toBe(false);
  });
  it('projects only public playback metadata and returns a lease secret only to its claimant', () => {
    expect(PlaybackSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(PlaybackResponseSchema.parse({ snapshot, leaseId: '22222222-2222-4222-8222-222222222222' })).toMatchObject({ leaseId: '22222222-2222-4222-8222-222222222222' });
    for (const patch of [{ leaseId: 'secret' }, { actorId: 'host' }, { clientId: '11111111-1111-4111-8111-111111111111' }, { privateReason: 'note' }]) expect(PlaybackSnapshotSchema.safeParse({ ...snapshot, ...patch }).success).toBe(false);
    expect(PlaybackSnapshotSchema.safeParse({ ...snapshot, presenter: { ...snapshot.presenter, leaseId: 'secret' } }).success).toBe(false);
  });
  it('bounds manifests and accepts only application audio asset paths', () => {
    expect(AudioManifestSchema.parse(manifest)).toEqual(manifest);
    for (const url of ['https://outside.test/audio.mp3', '//outside.test/audio', 'javascript:alert(1)', '/api/private', manifest.segments[0].url + '?secret=key']) expect(AudioManifestSchema.safeParse({ ...manifest, segments: [{ ...manifest.segments[0], url }] }).success).toBe(false);
    expect(AudioManifestSchema.safeParse({ ...manifest, segments: Array.from({ length: 42 }, () => manifest.segments[0]) }).success).toBe(true);
    expect(AudioManifestSchema.safeParse({ ...manifest, segments: Array.from({ length: 43 }, () => manifest.segments[0]) }).success).toBe(false);
  });
  it('accepts segment index 41 and refuses 42 in telemetry', () => {
    expect(PlaybackTelemetrySchema.safeParse({ ...telemetry, type: 'ended', segmentIndex: 41 }).success).toBe(true);
    expect(PlaybackTelemetrySchema.safeParse({ ...telemetry, type: 'ended', segmentIndex: 42 }).success).toBe(false);
  });
  it('accepts a 42-segment draft manifest and refuses 43', () => {
    const draftSegment = (index: number) => ({ index, text: 'A line.', speaker: 'Mara', voiceProfileId: 'voice_mara', url: `/api/sessions/show/beats/beat/draft-audio/${preparationId}/segments/${index}` });
    const draft = (count: number) => ({ preparationId, beatId: 'beat', draftRevision: 1, generation: 1, segments: Array.from({ length: count }, (_, index) => draftSegment(index)) });
    expect(DraftAudioManifestSchema.safeParse(draft(42)).success).toBe(true);
    expect(DraftAudioManifestSchema.safeParse(draft(43)).success).toBe(false);
  });
});
