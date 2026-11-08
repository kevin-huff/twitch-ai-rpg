import { describe, expect, it } from 'vitest';
import type { ActionContract, Effect, SessionState } from '@rpg/contracts';
import { applyResolution, resolveContracts, validateContracts } from './index';

const state = () => ({
  characters: [
    { id: 'dash', displayName: 'Dash', traits: { force: 0, finesse: 2, wits: 1, presence: 1 }, strain: 0, possessions: [] },
    { id: 'mara', displayName: 'Mara', traits: { force: 2, finesse: 0, wits: 1, presence: 1 }, strain: 3, possessions: [] },
    { id: 'scrot', displayName: 'Scrot', traits: { force: 1, finesse: 1, wits: 2, presence: 0 }, strain: 8, possessions: [] },
  ],
  npcs: [],
  tracks: [{ id: 'alarm', current: 0, max: 6 }],
  facts: [],
}) as unknown as SessionState;

const character = (current: SessionState, id: string) => current.characters.find(value => value.id === id)!;
const down = (current: SessionState, ...ids: string[]) => { for (const id of ids) character(current, id).condition = 'down'; return current; };

const contract = (overrides: Partial<ActionContract> = {}): ActionContract => ({
  id: 'act', version: 1, actorCharacterId: 'dash', helperCharacterIds: [], submissionIds: ['line'],
  intent: 'Drag Scrot clear', approach: 'Haul', ruling: 'check', trait: 'finesse',
  edge: 0, edgeReason: null, risk: 'high', prerequisites: [], fallback: { kind: 'hold' },
  outcomes: {
    clean: { publicText: 'Clear.', effects: [] },
    costly: { publicText: 'Clear, bruised.', effects: [] },
    setback: { publicText: 'No luck.', effects: [] },
  }, ...overrides,
});

const rescue = (characterId = 'scrot'): ActionContract => {
  const value = contract();
  const effect: Effect = { kind: 'character_rescue', characterId };
  value.outcomes.clean.effects = [effect];
  value.outcomes.costly.effects = [effect];
  return value;
};

const dice = (...faces: number[]) => {
  const queue = [...faces];
  return () => {
    const face = queue.shift();
    if (face === undefined) throw new Error('The scripted dice ran out.');
    return face;
  };
};

describe('last-chance roll', () => {
  it('rolls nothing extra when nobody is down', () => {
    const resolution = resolveContracts([contract()], state(), dice(6, 6));
    expect(resolution.rolls).toHaveLength(1);
    expect(resolution.rolls.some(roll => roll.lastChance)).toBe(false);
    expect(resolution.outcomes).toHaveLength(1);
  });

  it('rolls no last chance for a character a resolved rescue saves', () => {
    const current = down(state(), 'scrot');
    const resolution = resolveContracts([rescue()], current, dice(6, 6));
    expect(resolution.rolls).toHaveLength(1);
    expect(resolution.rolls.some(roll => roll.lastChance)).toBe(false);
    const next = applyResolution(current, resolution);
    expect('condition' in character(next, 'scrot')).toBe(false);
    expect(character(next, 'scrot').strain).toBe(6);
  });

  it('still rolls the last chance when the rescue rolled a setback', () => {
    const current = down(state(), 'scrot');
    const resolution = resolveContracts([rescue()], current, dice(1, 2, 6, 5));
    expect(resolution.rolls.map(roll => roll.band)).toEqual(['setback', 'clean']);
    expect(resolution.rolls[1]).toMatchObject({ actorCharacterId: 'scrot', lastChance: true, total: 11 });
    const next = applyResolution(current, resolution);
    expect('condition' in character(next, 'scrot')).toBe(false);
    expect(character(next, 'scrot').strain).toBe(7);
  });

  it('rolls the last chance in a round with no contracts', () => {
    const current = down(state(), 'scrot');
    const resolution = resolveContracts([], current, dice(2, 3));
    expect(resolution.rolls).toHaveLength(1);
    expect(resolution.rolls[0]!.lastChance).toBe(true);
    expect(resolution.effects).toEqual([]);
    expect(resolution.effectGroups).toEqual([]);
    expect(character(applyResolution(current, resolution), 'scrot').condition).toBe('dead');
  });

  it.each([
    [[6, 5], 11, 'clean', 'up'],
    [[4, 4], 8, 'costly', 'up'],
    [[2, 3], 5, 'setback', 'dead'],
    [[1, 1], 2, 'critical', 'dead'],
  ] as const)('rolls %j as %i (%s) and leaves the character %s', (faces, total, band, result) => {
    const current = down(state(), 'scrot');
    const resolution = resolveContracts([], current, dice(...faces));
    expect(resolution.rolls[0]).toMatchObject({ faces, total, band });
    const next = applyResolution(current, resolution);
    if (result === 'up') {
      expect('condition' in character(next, 'scrot')).toBe(false);
      expect(character(next, 'scrot').strain).toBe(7);
    } else {
      expect(character(next, 'scrot').condition).toBe('dead');
      expect(character(next, 'scrot').strain).toBe(8);
    }
    expect(character(current, 'scrot').condition).toBe('down');
  });

  it('counts 1 and 2 as a plain setback, not a critical failure', () => {
    const resolution = resolveContracts([], down(state(), 'scrot'), dice(1, 2));
    expect(resolution.rolls[0]!.band).toBe('setback');
  });

  it('rolls one last chance per downed character, in character order, after the contract dice', () => {
    const current = down(state(), 'scrot', 'mara');
    const resolution = resolveContracts([contract()], current, dice(3, 3, 6, 6, 1, 1));
    expect(resolution.rolls.map(roll => [roll.actorCharacterId, roll.lastChance ?? false, roll.faces])).toEqual([
      ['dash', false, [3, 3]], ['mara', true, [6, 6]], ['scrot', true, [1, 1]],
    ]);
    const next = applyResolution(current, resolution);
    expect('condition' in character(next, 'mara')).toBe(false);
    expect(character(next, 'mara').strain).toBe(7);
    expect(character(next, 'scrot').condition).toBe('dead');
  });

  it('records the roll and its outcome with the agreed fields and words', () => {
    const resolution = resolveContracts([], down(state(), 'scrot', 'mara'), dice(5, 5, 2, 2));
    expect(resolution.rolls).toEqual([
      { id: 'last-chance:mara', contractId: 'last-chance:mara', contractVersion: 1, actorCharacterId: 'mara', faces: [5, 5], trait: 'force', traitModifier: 0, edge: 0, total: 10, band: 'clean', lastChance: true },
      { id: 'last-chance:scrot', contractId: 'last-chance:scrot', contractVersion: 1, actorCharacterId: 'scrot', faces: [2, 2], trait: 'force', traitModifier: 0, edge: 0, total: 4, band: 'setback', lastChance: true },
    ]);
    expect(resolution.outcomes).toEqual([
      { contractId: 'last-chance:mara', actorCharacterId: 'mara', status: 'resolved', band: 'clean', goalAchieved: true, publicText: "Mara's last chance: Mara pulls through at 7 of 8." },
      { contractId: 'last-chance:scrot', actorCharacterId: 'scrot', status: 'resolved', band: 'setback', goalAchieved: false, publicText: "Scrot's last chance: Scrot dies." },
    ]);
  });

  it('lands after the round\'s effects and only on characters still down', () => {
    const current = down(state(), 'scrot');
    const resolution = resolveContracts([], current, dice(1, 1));
    // A correction between lock and publish brought Scrot back: the last chance no longer applies.
    delete character(current, 'scrot').condition;
    expect('condition' in character(applyResolution(current, resolution), 'scrot')).toBe(false);
  });

  it('ignores dead characters and characters who are up', () => {
    const current = state();
    character(current, 'scrot').condition = 'dead';
    const resolution = resolveContracts([], current, dice());
    expect(resolution.rolls).toEqual([]);
  });

  it('counts downed characters toward the 12-roll cap', () => {
    const current = state();
    for (let index = 0; index < 4; index++) current.characters.push({ ...structuredClone(current.characters[0]!), id: `extra${index}`, displayName: `Extra ${index}` });
    down(current, 'scrot', 'mara');
    const eleven = Array.from({ length: 11 }, (_, index) => contract({ id: `act${index}` }));
    expect(() => validateContracts(eleven, current)).toThrow('A round can show at most 12 rolls, and this plan needs 13. Untick some lines and plan again, then plan the rest in the next round.');
    expect(() => resolveContracts(eleven, current, dice())).toThrow('this plan needs 13');
  });

  it('allows ten contracts plus two downed characters', () => {
    const current = down(state(), 'scrot', 'mara');
    const lines = Array.from({ length: 10 }, (_, index) => ({ id: `line${index}`, characterId: 'dash', kind: 'say' as const }));
    const ten = Array.from({ length: 10 }, (_, index) => contract({ id: `act${index}`, submissionIds: [`line${index}`] }));
    expect(() => validateContracts(ten, current, lines)).not.toThrow();
  });
});
