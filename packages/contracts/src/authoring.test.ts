import { describe, expect, it } from 'vitest';
import { CharacterCardDefinitionSchema, CommandSchema, CreateSessionSchema, ScenarioDefinitionSchema, SaveScenarioSchema } from './index';

const card = { schemaVersion: 1, displayName: 'Nia', traits: { force: 0, finesse: 1, wits: 2, presence: 1 }, possessions: ['scanner'] };
const scenario = {
  schemaVersion: 1, title: 'The Signal', premise: 'Answer a distress call.', genre: 'Science fiction', tone: 'Hopeful mystery',
  boundaries: ['No graphic injury'], locations: [{ id: 'dock', title: 'Arrival dock', description: 'A silent platform.' }],
  openingScene: { id: 'arrival', title: 'A quiet arrival', description: 'The beacon flashes.', locationId: 'dock' },
  npcs: [{ id: 'keeper', displayName: 'The Keeper', role: 'Station caretaker', locationId: 'dock', status: 'present', voiceProfileId: 'voice_narrator', knowledge: [{ statement: 'The beacon is active.', category: 'fact' }] }],
  tracks: [{ id: 'signal', label: 'Signal strength', kind: 'progress', current: 0, max: 4, visibility: 'public' }],
  facts: [{ id: 'beacon', text: 'The beacon is active.', visibility: 'public' }],
};

describe('native authoring and lobby contracts', () => {
  it('round trips native definitions without granting runtime authority', () => {
    const parsed = CharacterCardDefinitionSchema.parse(card);
    expect(CharacterCardDefinitionSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    for (const extra of [{ approved: true }, { strain: 0 }, { id: 'chosen-id' }, { role: 'host' }, { ready: true }]) {
      expect(CharacterCardDefinitionSchema.safeParse({ ...card, ...extra }).success).toBe(false);
    }
    expect(CharacterCardDefinitionSchema.safeParse({ ...card, possessions: ['a', 'b', 'c', 'd'] }).success).toBe(false);
    expect(CharacterCardDefinitionSchema.safeParse({ ...card, traits: { force: 2, finesse: 2, wits: 0, presence: 0 } }).success).toBe(false);
  });
  it('accepts a bounded scenario with defaults and refuses unsupported formats', () => {
    const parsed = ScenarioDefinitionSchema.parse(scenario);
    expect(parsed.rulesVersion).toBe('0.1');
    expect(parsed.pacing).toEqual({ conversationWords: 90, actionWords: 120 });
    expect(ScenarioDefinitionSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(ScenarioDefinitionSchema.safeParse({ ...scenario, schemaVersion: 2 }).success).toBe(false);
    expect(ScenarioDefinitionSchema.safeParse({ ...scenario, directorCredential: 'not-allowed' }).success).toBe(false);
  });
  it('bounds complete native documents below the request limit, including multibyte text', () => {
    expect(ScenarioDefinitionSchema.safeParse({ ...scenario, facts: Array.from({ length: 50 }, (_, index) => ({ id: `fact-${index}`, text: 'a'.repeat(3000), visibility: 'public' })) }).success).toBe(false);
    expect(CharacterCardDefinitionSchema.safeParse({ ...card, extensions: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field-${index}`, '界'.repeat(2000)])) }).success).toBe(false);
  });
  it('rejects duplicate and dangling package references and impossible initial effects', () => {
    expect(ScenarioDefinitionSchema.safeParse({ ...scenario, facts: [{ ...scenario.facts[0], id: 'dock' }] }).success).toBe(false);
    expect(ScenarioDefinitionSchema.safeParse({ ...scenario, openingScene: { ...scenario.openingScene, locationId: 'missing' } }).success).toBe(false);
    expect(ScenarioDefinitionSchema.safeParse({ ...scenario, npcs: [{ ...scenario.npcs[0], locationId: 'missing' }] }).success).toBe(false);
    for (const effect of [
      { kind: 'track_delta', trackId: 'missing', delta: 1 },
      { kind: 'strain_delta', characterId: 'not-a-session-seat', delta: 1 },
      { kind: 'fact_add', factId: 'beacon', text: 'Conflicting duplicate.', visibility: 'public' },
    ]) expect(ScenarioDefinitionSchema.safeParse({ ...scenario, tracks: [{ ...scenario.tracks[0], completionEffects: [effect] }] }).success).toBe(false);
  });
  it('accepts only completion effects that the countdown executor can apply safely', () => {
    const effect = { kind: 'track_delta', trackId: 'signal', delta: 1 };
    const countdown = { id: 'arrival', label: 'Rescue arrival', kind: 'countdown', current: 0, max: 3, trigger: 'action_round', visibility: 'public', completionEffects: [effect] };
    const base = { ...scenario, openingScene: { ...scenario.openingScene, id: 'opening' }, tracks: [...scenario.tracks, countdown] };
    expect(ScenarioDefinitionSchema.safeParse(base).success).toBe(true);
    for (const changed of [
      { ...countdown, kind: 'progress' },
      { ...countdown, trigger: null },
      { ...countdown, completionEffects: [{ ...effect, incidentId: 'shared' }, { ...effect, incidentId: 'shared', delta: 2 }] },
      { ...countdown, completionEffects: [{ ...effect, trackId: 'arrival', delta: -1 }] },
    ]) expect(ScenarioDefinitionSchema.safeParse({ ...base, tracks: [...scenario.tracks, changed] }).success).toBe(false);
  });
  it('requires exact owned-version references for a custom two-to-six-seat session', () => {
    const ref = { templateId: 'card', version: 1 };
    expect(CreateSessionSchema.safeParse({ commandId: 'legacy' }).success).toBe(true);
    for (const count of [2, 6]) expect(CreateSessionSchema.safeParse({ commandId: 'custom', scenario: ref, characters: Array(count).fill(ref) }).success).toBe(true);
    for (const count of [0, 1, 7]) expect(CreateSessionSchema.safeParse({ commandId: 'custom', scenario: ref, characters: Array(count).fill(ref) }).success).toBe(false);
    expect(CreateSessionSchema.safeParse({ commandId: 'custom', scenario: ref }).success).toBe(false);
    const mine = { playerWritten: true };
    expect(CreateSessionSchema.safeParse({ commandId: 'custom', scenario: ref, characters: [mine, ref, mine] }).success).toBe(true);
    expect(CreateSessionSchema.safeParse({ commandId: 'custom', scenario: ref, characters: Array(6).fill(mine) }).success).toBe(true);
    expect(CreateSessionSchema.safeParse({ commandId: 'custom', scenario: ref, characters: [mine, { playerWritten: false }] }).success).toBe(false);
    expect(CreateSessionSchema.safeParse({ commandId: 'custom', scenario: ref, characters: [mine, { playerWritten: true, extra: 1 }] }).success).toBe(false);
    expect(CreateSessionSchema.safeParse({ commandId: 'custom', scenario: ref, characters: [mine] }).success).toBe(false);
    expect(CreateSessionSchema.safeParse({ commandId: 'custom', scenario: ref, characters: Array(7).fill(mine) }).success).toBe(false);
    expect(CreateSessionSchema.safeParse({ commandId: 'custom', characters: [mine, mine] }).success).toBe(false);
    expect(CreateSessionSchema.safeParse({ commandId: 'custom', characters: [ref, ref] }).success).toBe(false);
    expect(SaveScenarioSchema.safeParse({ commandId: 'new', expectedVersion: 0, definition: scenario }).success).toBe(true);
    expect(SaveScenarioSchema.safeParse({ commandId: 'new', expectedVersion: 2, definition: scenario }).success).toBe(false);
  });
  it('separates own draft edits, approval, acknowledgment and intentional missing-seat overrides', () => {
    expect(CommandSchema.safeParse({ type: 'save_character', commandId: 'save', expectedCharacterRevision: 0, card }).success).toBe(true);
    expect(CommandSchema.safeParse({ type: 'save_character', commandId: 'save', expectedCharacterRevision: 0, card, characterId: 'someone-else' }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: 'approve_character', commandId: 'approve', characterId: 'seat', expectedCharacterRevision: 1 }).success).toBe(true);
    expect(CommandSchema.safeParse({ type: 'set_ready', commandId: 'ready', expectedCharacterRevision: 1, expectedBoundariesRevision: 0, ready: true }).success).toBe(true);
    expect(CommandSchema.safeParse({ type: 'start_session', commandId: 'start', expectedStateRevision: 0, overrideUnreadyReason: ' ' }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: 'start_session', commandId: 'start', expectedStateRevision: 0, overrideUnreadyReason: 'The second player will arrive later.' }).success).toBe(true);
  });
});
