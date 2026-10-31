import { describe, expect, it } from 'vitest';
import { CharacterSchema, CommandSchema, DirectorSnapshotSchema, EMPTY_GUIDANCE, GuidanceSchema, PlayerSnapshotSchema, StageSnapshotSchema, canSpeakInScene } from './index.js';

const traits = { force: 2, finesse: 1, wits: 1, presence: 0 };
const scene = { id: 'scene', title: 'The bar', description: '', locationId: 'bar' };
const session = { id: 'show', title: 'Show', status: 'live', mode: 'conversation', stateRevision: 7, beatNumber: 2, actionRoundNumber: 0, inputEpoch: 0, scene };
const base = { schemaVersion: 1, eventSeq: 3, session, characters: [], npcs: [], tracks: [], facts: [], history: [] };
const director = { ...base, role: 'director', activeBeat: null, submissions: [], npcDetails: [], characterDetails: [], jobs: [], directorNotes: '' };
const player = { ...base, role: 'player', activeBeat: null, ownCharacter: null, submissions: [] };
const stage = { ...base, role: 'stage', activeBeat: null };

describe('GuidanceSchema', () => {
  it('defaults to empty guidance', () => {
    expect(GuidanceSchema.parse({})).toEqual(EMPTY_GUIDANCE);
  });
  it('holds each limit', () => {
    expect(GuidanceSchema.safeParse({ storyPlan: 'x'.repeat(12000) }).success).toBe(true);
    expect(GuidanceSchema.safeParse({ storyPlan: 'x'.repeat(12001) }).success).toBe(false);
    expect(GuidanceSchema.safeParse({ standingNote: 'x'.repeat(3000) }).success).toBe(true);
    expect(GuidanceSchema.safeParse({ standingNote: 'x'.repeat(3001) }).success).toBe(false);
    expect(GuidanceSchema.parse({ standingNote: '  hi  ' }).standingNote).toBe('hi');
    expect(GuidanceSchema.safeParse({ aiCastNpcIds: ['a', 'a'] }).success).toBe(false);
    expect(GuidanceSchema.safeParse({ aiCastNpcIds: Array.from({ length: 51 }, (_, i) => `n${i}`) }).success).toBe(false);
    expect(GuidanceSchema.safeParse({ aiCastNpcIds: ['a', 'b'] }).success).toBe(true);
    expect(GuidanceSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe('set_guidance command', () => {
  it('leaves missing fields undefined', () => {
    const parsed = CommandSchema.parse({ type: 'set_guidance', commandId: 'c1', standingNote: 'Hold the line' });
    expect(parsed).toEqual({ type: 'set_guidance', commandId: 'c1', standingNote: 'Hold the line' });
    expect('storyPlan' in parsed).toBe(false);
  });
  it('accepts a cleared field and refuses an empty command', () => {
    expect(CommandSchema.safeParse({ type: 'set_guidance', commandId: 'c1', standingNote: '' }).success).toBe(true);
    expect(CommandSchema.safeParse({ type: 'set_guidance', commandId: 'c1', aiCastNpcIds: [] }).success).toBe(true);
    const empty = CommandSchema.safeParse({ type: 'set_guidance', commandId: 'c1' });
    expect(empty.success).toBe(false);
    expect(JSON.stringify(empty.error?.issues)).toContain('Send at least one guidance field.');
  });
  it('applies the field limits', () => {
    expect(CommandSchema.safeParse({ type: 'set_guidance', commandId: 'c1', standingNote: 'x'.repeat(3001) }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: 'set_guidance', commandId: 'c1', aiCastNpcIds: ['a', 'a'] }).success).toBe(false);
  });
});

describe('save_live_character command', () => {
  const ok = { type: 'save_live_character', commandId: 'c1', characterId: 'ch', expectedCharacterRevision: 2, appearance: 'Tall', possessions: ['  cap  '] };
  it('parses and trims items', () => {
    const parsed = CommandSchema.parse(ok);
    expect(parsed.type === 'save_live_character' && parsed.possessions).toEqual(['cap']);
  });
  it('holds the limits', () => {
    expect(CommandSchema.safeParse({ ...ok, appearance: 'x'.repeat(1000) }).success).toBe(true);
    expect(CommandSchema.safeParse({ ...ok, appearance: 'x'.repeat(1001) }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...ok, possessions: ['x'.repeat(160)] }).success).toBe(true);
    expect(CommandSchema.safeParse({ ...ok, possessions: ['x'.repeat(161)] }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...ok, possessions: ['   '] }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...ok, possessions: Array.from({ length: 20 }, () => 'a') }).success).toBe(true);
    expect(CommandSchema.safeParse({ ...ok, possessions: Array.from({ length: 21 }, () => 'a') }).success).toBe(false);
  });
});

describe('lookEditedAt', () => {
  const card = { id: 'c', displayName: 'Rook', traits, strain: 0 };
  it('defaults to null and keeps an ISO time', () => {
    expect(CharacterSchema.parse(card).lookEditedAt).toBeNull();
    const at = '2026-10-29T12:00:00.000Z';
    expect(CharacterSchema.parse({ ...card, lookEditedAt: at }).lookEditedAt).toBe(at);
    expect(CharacterSchema.safeParse({ ...card, lookEditedAt: 'yesterday' }).success).toBe(false);
  });
});

describe('snapshots and guidance', () => {
  it('lets the director snapshot carry guidance or not', () => {
    expect(DirectorSnapshotSchema.safeParse(director).success).toBe(true);
    expect(DirectorSnapshotSchema.parse({ ...director, guidance: { standingNote: 'x' } }).guidance).toEqual({ ...EMPTY_GUIDANCE, standingNote: 'x' });
  });
  it('keeps guidance off player and stage snapshots', () => {
    expect(PlayerSnapshotSchema.safeParse(player).success).toBe(true);
    expect(StageSnapshotSchema.safeParse(stage).success).toBe(true);
    expect(PlayerSnapshotSchema.safeParse({ ...player, guidance: EMPTY_GUIDANCE }).success).toBe(false);
    expect(StageSnapshotSchema.safeParse({ ...stage, guidance: EMPTY_GUIDANCE }).success).toBe(false);
  });
});

describe('canSpeakInScene', () => {
  const at = (status: 'present' | 'offstage' | 'away', locationId: string, communicationChannel: string | null) => ({ status, locationId, communicationChannel } as Parameters<typeof canSpeakInScene>[0]);
  it('follows the speaker rule', () => {
    expect(canSpeakInScene(at('present', 'bar', null), 'bar')).toBe(true);
    expect(canSpeakInScene(at('present', 'dock', null), 'bar')).toBe(false);
    expect(canSpeakInScene(at('offstage', 'bar', null), 'bar')).toBe(false);
    expect(canSpeakInScene(at('offstage', 'dock', 'radio'), 'bar')).toBe(true);
    expect(canSpeakInScene(at('present', 'dock', 'radio'), 'bar')).toBe(true);
    expect(canSpeakInScene(at('offstage', 'dock', ''), 'bar')).toBe(false);
  });
});
