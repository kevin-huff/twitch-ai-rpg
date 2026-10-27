import { describe, expect, it } from 'vitest';
import {
  AiSegmentSchema,
  CharacterSchema,
  CommandSchema,
  InvitePreviewRequestSchema,
  InvitePreviewResponseSchema,
  PublicCharacterSchema,
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

describe('Sprint A contracts', () => {
  const base = { id: 'c1', displayName: 'Ana', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, strain: 0 };
  it('cardSource is optional and limited to host or player', () => {
    const char = base;
    expect(CharacterSchema.safeParse(char).success).toBe(true);
    expect(CharacterSchema.safeParse({ ...char, cardSource: 'host' }).success).toBe(true);
    expect(CharacterSchema.safeParse({ ...char, cardSource: 'player' }).success).toBe(true);
    expect(CharacterSchema.safeParse({ ...char, cardSource: 'ai' }).success).toBe(false);
    const parsed = CharacterSchema.parse({ ...char, cardSource: 'host' });
    expect(PublicCharacterSchema.shape).not.toHaveProperty('cardSource');
    const { id, displayName, traits, strain, appearance, approved, ready, portraitId } = parsed;
    const pub = PublicCharacterSchema.parse({ id, displayName, traits, strain, appearance, approved, ready, portraitId });
    expect(pub).not.toHaveProperty('cardSource');
    expect(PublicCharacterSchema.safeParse({ ...pub, cardSource: 'host' }).success).toBe(false);
  });
  const cmd = { commandId: 'cmd-1' };
  it('save_character takes an optional characterId', () => {
    const card = { schemaVersion: 1, displayName: 'Nia', traits: base.traits, possessions: ['scanner'] };
    const without = CommandSchema.safeParse({ type: 'save_character', ...cmd, expectedCharacterRevision: 0, card });
    const withId = CommandSchema.safeParse({ type: 'save_character', ...cmd, expectedCharacterRevision: 0, card, characterId: 'c1' });
    expect(without.success).toBe(true);
    expect(withId.success).toBe(true);
  });
  it('remove_seat parses and is strict', () => {
    const ok = { type: 'remove_seat', ...cmd, expectedStateRevision: 0, characterId: 'c1' };
    expect(CommandSchema.safeParse(ok).success).toBe(true);
    expect(CommandSchema.safeParse({ ...ok, characterId: undefined }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
  it('invite preview schemas accept valid input and reject extras', () => {
    expect(InvitePreviewRequestSchema.safeParse({ token: 'abc' }).success).toBe(true);
    expect(InvitePreviewRequestSchema.safeParse({ token: 'abc', x: 1 }).success).toBe(false);
    expect(InvitePreviewResponseSchema.safeParse({ title: 'T', role: 'player', characterName: 'Ana' }).success).toBe(true);
    expect(InvitePreviewResponseSchema.safeParse({ title: 'T', role: 'stage' }).success).toBe(true);
    expect(InvitePreviewResponseSchema.safeParse({ title: 'T', role: 'stage', x: 1 }).success).toBe(false);
  });
});
