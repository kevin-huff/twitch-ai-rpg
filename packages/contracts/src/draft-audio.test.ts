import { describe, expect, it } from 'vitest';
import { CommandSchema, PublishedBeatSchema } from './index';
import { DraftAudioManifestSchema, DraftAudioResponseSchema, PrepareDraftAudioSchema } from './draft-audio';

const id = '11111111-1111-4111-8111-111111111111';
const publish = { type: 'publish_beat', commandId: 'publish', beatId: 'beat', expectedBeatRevision: 3, expectedStateRevision: 1, draftRevision: 2 };
const publication = { id: 'beat', kind: 'conversation', beatNumber: 1, actionRoundNumber: 0, stateRevision: 1, publishedAt: '2026-10-22T00:00:00Z', segments: [], rolls: [], outcomes: [] };

describe('reviewed draft audio publication contracts', () => {
  it('accepts only saved revision preparation requests', () => {
    const request = { commandId: 'prepare', expectedBeatRevision: 4, draftRevision: 2, generation: 3 };
    expect(PrepareDraftAudioSchema.parse(request)).toEqual(request);
    for (const patch of [{ draftRevision: -1 }, { generation: 1.5 }, { expectedBeatRevision: undefined }, { text: 'unsaved words' }, { voiceId: 'forged' }]) expect(PrepareDraftAudioSchema.safeParse({ ...request, ...patch }).success).toBe(false);
  });
  it('keeps preview manifests on private indexed media routes', () => {
    const segment = { index: 0, text: 'Saved narration.', speaker: 'Narrator', voiceProfileId: 'voice_narrator', url: `/api/sessions/show/beats/beat/draft-audio/${id}/segments/0` };
    const manifest = { preparationId: id, beatId: 'beat', draftRevision: 2, generation: 3, segments: [segment] };
    expect(DraftAudioManifestSchema.parse(manifest)).toEqual(manifest);
    expect(DraftAudioResponseSchema.parse({ status: 'ready', manifest })).toEqual({ status: 'ready', manifest });
    for (const patch of [{ index: 1 }, { url: '/api/sessions/show/audio/assets/' + 'a'.repeat(64) }, { url: segment.url + '?token=secret' }, { url: segment.url.replace('/beats/beat/', '/beats/other/') }, { url: segment.url.replace('/segments/0', '/segments/1') }, { url: 'https://external.test/audio' }]) expect(DraftAudioManifestSchema.safeParse({ ...manifest, segments: [{ ...segment, ...patch }] }).success).toBe(false);
    expect(DraftAudioResponseSchema.safeParse({ status: 'preparing' }).success).toBe(false);
    expect(DraftAudioResponseSchema.safeParse({ status: 'missing', manifest }).success).toBe(false);
  });
  it('requires an explicit choice between text-only and a selected prepared recording', () => {
    expect(CommandSchema.parse({ ...publish, textOnly: true })).toEqual({ ...publish, textOnly: true });
    expect(CommandSchema.parse({ ...publish, textOnly: false, audioPreparationId: id })).toEqual({ ...publish, textOnly: false, audioPreparationId: id });
    for (const choice of [{}, { textOnly: false }, { textOnly: true, audioPreparationId: id }, { textOnly: false, audioPreparationId: 'invalid' }, { textOnly: false, audioPreparationId: id, manifest: {} }]) {
      expect(CommandSchema.safeParse({ ...publish, ...choice }).success).toBe(false);
    }
  });
  it('pins voiced publications without exposing private preparation metadata', () => {
    expect(PublishedBeatSchema.parse({ ...publication, textOnly: true })).toMatchObject({ textOnly: true });
    expect(PublishedBeatSchema.parse({ ...publication, textOnly: false, audioManifestKey: 'a'.repeat(64) })).toMatchObject({ audioManifestKey: 'a'.repeat(64) });
    for (const choice of [{ textOnly: false }, { textOnly: false, audioManifestKey: 'invalid' }, { textOnly: true, audioManifestKey: 'a'.repeat(64) }, { textOnly: false, audioManifestKey: 'a'.repeat(64), audioPreparationId: id }]) {
      expect(PublishedBeatSchema.safeParse({ ...publication, ...choice }).success).toBe(false);
    }
  });
});
