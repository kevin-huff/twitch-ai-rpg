import { describe, expect, it } from 'vitest';
import {
  AiSegmentSchema,
  CommandSchema,
  NpcKnowledgeSchema,
  RedeemResponseSchema,
  SessionSnapshotSchema,
  TraitsSchema,
} from './index.js';

describe('rules and authority contracts', () => {
  it('accepts a tab identity selector without accepting bearer credentials or malformed selectors', () => {
    const legacy = { sessionId: 'session', role: 'player', characterId: 'rook' };
    expect(RedeemResponseSchema.parse(legacy)).toEqual(legacy);
    const scoped = { ...legacy, identityId: 'a'.repeat(32) };
    expect(RedeemResponseSchema.parse(scoped)).toEqual(scoped);
    for (const identityId of ['', 'A'.repeat(32), 'a'.repeat(31), 'not-a-selector']) {
      expect(RedeemResponseSchema.safeParse({ ...legacy, identityId }).success).toBe(false);
    }
    expect(RedeemResponseSchema.safeParse({ ...scoped, credential: 'private-token' }).success).toBe(false);
  });
  it('accepts exactly the four-trait allocation', () => {
    expect(TraitsSchema.safeParse({ force: 2, finesse: 1, wits: 1, presence: 0 }).success).toBe(true);
    expect(TraitsSchema.safeParse({ force: 2, finesse: 2, wits: 0, presence: 0 }).success).toBe(false);
  });

  it('excludes player quotes and provider commands from authored scripts', () => {
    expect(AiSegmentSchema.safeParse({ kind: 'player_dialogue', text: 'I agree.', characterId: 'pc' }).success).toBe(false);
    expect(AiSegmentSchema.safeParse({
      kind: 'npc_dialogue', speakerNpcId: 'mara', recipientCharacterIds: ['pc'], text: 'Why?', delivery: 'quiet',
    }).success).toBe(true);
    expect(AiSegmentSchema.safeParse({
      kind: 'npc_dialogue', speakerNpcId: 'mara', recipientCharacterIds: [], text: 'Why?', delivery: 'quiet', voiceId: 'arbitrary',
    }).success).toBe(false);
  });

  it('requires a submission context and forbids client role grants', () => {
    const input = {
      type: 'save_submission', commandId: 'command-1', expectedSubmissionRevision: 0,
      contextBeatId: null, expectedInputEpoch: 2, kind: 'say', text: 'Hello Mara.',
      recipientNpcIds: ['mara'], alreadySpokenAloud: true,
    };
    expect(CommandSchema.safeParse(input).success).toBe(true);
    const { expectedInputEpoch: ignored, ...staleInput } = input;
    expect(ignored).toBe(2);
    expect(CommandSchema.safeParse(staleInput).success).toBe(false);
    expect(CommandSchema.safeParse({ ...input, role: 'director' }).success).toBe(false);
  });

  it('requires provenance on learned information and keeps claims classified', () => {
    const knowledge = {
      id: 'knowledge-1', statement: 'The ledger was burned.', category: 'claim', acquisition: 'told',
      sourceEventId: 'event-1', sourceEntityId: 'pc-1', learnedBeatNumber: 1,
    };
    expect(NpcKnowledgeSchema.parse(knowledge).category).toBe('claim');
    const { sourceEventId: ignored, ...unsourced } = knowledge;
    expect(ignored).toBe('event-1');
    expect(NpcKnowledgeSchema.safeParse(unsourced).success).toBe(false);
  });
});

describe('stage projection contract', () => {
  const snapshot = {
    schemaVersion: 1, role: 'stage', eventSeq: 0,
    session: {
      id: 'session-1', title: 'The Ledger Job', status: 'live', mode: 'conversation',
      stateRevision: 0, beatNumber: 0, actionRoundNumber: 0, inputEpoch: 0,
      scene: { id: 'scene-1', title: 'The bar', description: 'A quiet club.', locationId: 'bar' },
    },
    characters: [], npcs: [], tracks: [], facts: [], history: [], activeBeat: null,
  };

  it('permits only allowlisted public fields', () => {
    expect(SessionSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(SessionSnapshotSchema.safeParse({ ...snapshot, directorNotes: 'Secret ledger location.' }).success).toBe(false);
    expect(SessionSnapshotSchema.safeParse({ ...snapshot, role: 'player' }).success).toBe(false);
  });
});
