import { describe, expect, it } from 'vitest';
import { BeatSchema, CommandSchema, CorrectionChangeSchema, PublicBeatSchema, PublicCorrectionSchema, SessionSnapshotSchema } from './index';

const correction = { type: 'record_correction', commandId: 'correct', expectedStateRevision: 3, publishedBeatId: 'old-beat', publicText: 'The safe was already open.', reason: 'A mistaken ruling.', discardQueuedInput: true, changes: [] };
const memory = { npcId: 'mara', knowledgeId: 'memory', mode: 'correct' };
const fact = { kind: 'fact_replace', factId: 'fact', text: 'The safe is open.', knowledgeUpdates: [memory] };

describe('director corrections and private steering contracts', () => {
  it('permits an explicit public clarification without rewriting any state', () => {
    expect(CommandSchema.parse({ ...correction, publicText: '  A clarification.  ', reason: '  An explanation.  ' })).toEqual({ ...correction, publicText: 'A clarification.', reason: 'An explanation.' });
  });

  it('accepts bounded state adjustments with explicit existing-memory choices', () => {
    const changes = [fact, { kind: 'strain_set', characterId: 'rook', value: 0 }, { kind: 'track_set', trackId: 'danger', value: 8 }];
    expect(CommandSchema.parse({ ...correction, changes })).toMatchObject({ changes });
    expect(CorrectionChangeSchema.parse({ ...fact, knowledgeUpdates: [{ ...memory, mode: 'retain_belief' }] })).toMatchObject({ knowledgeUpdates: [{ mode: 'retain_belief' }] });
  });

  it('allows complete reconciliation when more than 100 existing memories match a fact', () => {
    const knowledgeUpdates = Array.from({ length: 101 }, (_, index) => ({ ...memory, knowledgeId: `memory-${index}` }));
    expect(CommandSchema.parse({ ...correction, changes: [{ ...fact, knowledgeUpdates }] })).toMatchObject({ changes: [{ knowledgeUpdates }] });
  });

  it('rejects malformed corrections, unacknowledged cancellation, and unsupported changes', () => {
    for (const input of [
      { ...correction, publishedBeatId: '' }, { ...correction, expectedStateRevision: -1 },
      { ...correction, publicText: ' ' }, { ...correction, publicText: 'x'.repeat(3001) },
      { ...correction, reason: ' ' }, { ...correction, reason: 'x'.repeat(1001) },
      { ...correction, discardQueuedInput: false }, { ...correction, rolls: [] },
      ...[{ kind: 'reroll', beatId: 'old-beat' }, { kind: 'strain_set', characterId: 'rook', value: 5 },
        { kind: 'track_set', trackId: 'danger', value: -1 }, { kind: 'track_set', trackId: 'danger', value: 1.5 },
        { ...fact, text: ' ' }, { ...fact, visibility: 'director' },
        { ...fact, knowledgeUpdates: [{ ...memory, mode: 'teach_everyone' }] },
      ].map(change => ({ ...correction, changes: [change] })),
    ]) expect(CommandSchema.safeParse(input).success).toBe(false);
  });

  it('rejects duplicate state and memory targets including across fact replacements', () => {
    for (const changes of [
      [fact, { ...fact, text: 'Different' }],
      [{ kind: 'strain_set', characterId: 'rook', value: 1 }, { kind: 'strain_set', characterId: 'rook', value: 2 }],
      [{ ...fact, knowledgeUpdates: [memory, { ...memory, mode: 'retain_belief' }] }],
      [fact, { ...fact, factId: 'other-fact' }],
      Array.from({ length: 11 }, (_, index) => ({ kind: 'track_set', trackId: `track-${index}`, value: 0 })),
    ]) expect(CommandSchema.safeParse({ ...correction, changes }).success).toBe(false);
  });

  it('bounds steering, allows clearing it, and refuses state changes or role grants in its command', () => {
    const command = { type: 'set_beat_steering', commandId: 'steer', beatId: 'beat', expectedBeatRevision: 3, text: '  Let Mara sound defensive.  ' };
    expect(CommandSchema.parse(command)).toMatchObject({ text: 'Let Mara sound defensive.' });
    expect(CommandSchema.safeParse({ ...command, text: ' ' }).success).toBe(true);
    for (const input of [{ ...command, text: 'x'.repeat(3001) }, { ...command, expectedBeatRevision: -1 }, { ...command, role: 'host' }, { ...command, resolution: {} }]) expect(CommandSchema.safeParse(input).success).toBe(false);
    expect(BeatSchema.shape.steering.safeParse(undefined).success).toBe(true);
  });

  it('allows only the public correction notice and never private steering in public beats', () => {
    const notice = { id: 'event', publishedBeatId: 'old-beat', beatNumber: 1, stateRevision: 4, recordedAt: '2026-10-22T12:00:00.000Z', publicText: 'The safe was open.' };
    expect(PublicCorrectionSchema.parse(notice)).toEqual(notice);
    for (const extra of [{ reason: 'PRIVATE' }, { changes: [fact] }, { before: 'PRIVATE' }, { steering: 'PRIVATE' }]) expect(PublicCorrectionSchema.safeParse({ ...notice, ...extra }).success).toBe(false);
    expect(PublicBeatSchema.safeParse({ id: 'beat', kind: 'conversation', phase: 'collecting', revision: 0, stakes: [], locked: false, steering: 'PRIVATE' }).success).toBe(false);
    const legacyStage = { schemaVersion: 1, role: 'stage', eventSeq: 0, session: { id: 'show', title: 'Show', status: 'live', mode: 'conversation', stateRevision: 0, beatNumber: 0, actionRoundNumber: 0, inputEpoch: 0, scene: { id: 'scene', title: 'A room', description: '', locationId: 'room' } }, characters: [], npcs: [], tracks: [], facts: [], history: [], activeBeat: null };
    expect(SessionSnapshotSchema.parse(legacyStage)).toHaveProperty('corrections', []);
  });
});
