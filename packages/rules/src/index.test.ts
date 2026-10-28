import { describe, expect, it, vi } from 'vitest';
import type { ActionContract, SessionState } from '@rpg/contracts';
import { MAX_ROLLS_PER_ROUND, applyEffects, applyResolution, outcomeForTotal, tooManyRollsMessage, resolveContracts, validateContracts, validateTraits } from './index';

const state = () => ({
  characters: [
    { id: 'lead', traits: { force: 0, finesse: 2, wits: 1, presence: 1 }, strain: 0, possessions: ['lockpick'] },
    { id: 'helper', traits: { force: 2, finesse: 0, wits: 1, presence: 1 }, strain: 0, possessions: [] },
    { id: 'other', traits: { force: 1, finesse: 1, wits: 2, presence: 0 }, strain: 0, possessions: [] },
  ],
  tracks: [{ id: 'access', current: 0, max: 4 }, { id: 'alarm', current: 5, max: 6 }],
  facts: [],
}) as unknown as SessionState;

const contract = (overrides: Partial<ActionContract> = {}): ActionContract => ({
  id: 'lock', version: 1, actorCharacterId: 'lead', helperCharacterIds: [], submissionIds: ['input'],
  intent: 'Open the archive lock', approach: 'Pick the mechanism', ruling: 'check', trait: 'finesse',
  edge: 0, edgeReason: null, risk: 'normal', prerequisites: [], fallback: { kind: 'hold' },
  outcomes: {
    clean: { publicText: 'The lock opens quietly.', effects: [{ kind: 'track_delta', trackId: 'access', delta: 2 }] },
    costly: { publicText: 'The lock opens with a loud click.', effects: [{ kind: 'track_delta', trackId: 'access', delta: 2 }, { kind: 'track_delta', trackId: 'alarm', delta: 1 }] },
    setback: { publicText: 'The lock jams and the alarm rises.', effects: [{ kind: 'track_delta', trackId: 'alarm', delta: 2 }] },
  }, ...overrides,
});

describe('RULE-01 exact 2d6 probabilities', () => {
  it.each([[0, 15, 15, 6], [1, 10, 16, 10], [2, 6, 15, 15], [3, 3, 12, 21]])('modifier %i has exact counts', (modifier, setback, costly, clean) => {
    const counts: Record<ReturnType<typeof outcomeForTotal>, number> = { setback: 0, costly: 0, clean: 0, critical: 0 };
    for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) counts[outcomeForTotal(a + b + modifier)]++;
    expect(counts).toEqual({ setback, costly, clean, critical: 0 });
  });
  it('validates allocation and dice supplied through the test seam', () => {
    expect(validateTraits({ force: 2, finesse: 1, wits: 1, presence: 0 })).toBe(true);
    expect(validateTraits({ force: 2, finesse: 2, wits: 0, presence: 0 })).toBe(false);
    expect(() => resolveContracts([contract()], state(), () => 7)).toThrow(/die|dice/i);
  });
});

describe('RULE-02, RULE-03, RULE-04, RULE-07 declared outcomes', () => {
  it('grants the goal AND only the declared cost on 7-9 without mutating live state', () => {
    const before = state();
    const result = resolveContracts([contract()], before, () => 3);
    expect(result.rolls[0]).toMatchObject({ faces: [3, 3], traitModifier: 2, total: 8, band: 'costly' });
    expect(result.outcomes[0]).toMatchObject({ goalAchieved: true, band: 'costly' });
    expect(result.effects).toEqual(contract().outcomes.costly.effects);
    expect(before.tracks[0].current).toBe(0);
  });
  it('clean success cannot acquire a consequence from prose or other branches', () => {
    const result = resolveContracts([contract()], state(), () => 6);
    expect(result.effects).toEqual(contract().outcomes.clean.effects);
  });
  it('does not stack helpers and prevents spending a helper action twice', () => {
    const assisted = contract({ helperCharacterIds: ['helper', 'other'], edge: 1, edgeReason: 'They watch the hallway' });
    expect(resolveContracts([assisted], state(), () => 3).rolls[0].total).toBe(9);
    expect(() => validateContracts([assisted, contract({ id: 'second', actorCharacterId: 'helper' })], state())).toThrow(/action|helper|spent/i);
  });
  it('holds failed dependent checks without rolling and rejects cycles', () => {
    const rolls = vi.fn(() => 1);
    const dependent = contract({ id: 'dependent', actorCharacterId: 'other', prerequisites: [{ contractId: 'lock', requirement: 'goal_achieved' }] });
    const result = resolveContracts([dependent, contract()], state(), rolls);
    expect(rolls).toHaveBeenCalledTimes(2);
    expect(result.outcomes.find(outcome => outcome.contractId === 'dependent')).toMatchObject({ status: 'held', band: null, goalAchieved: false });
    expect(() => validateContracts([dependent, contract({ prerequisites: [{ contractId: 'dependent', requirement: 'goal_achieved' }] })], state())).toThrow(/cycle/i);
  });
  it('no-check actions succeed without dice and blocked actions do not spend dice', () => {
    const roll = vi.fn(() => 6);
    expect(resolveContracts([contract({ ruling: 'no_check' })], state(), roll).outcomes[0].goalAchieved).toBe(true);
    expect(resolveContracts([contract({ ruling: 'blocked' })], state(), roll).outcomes[0].goalAchieved).toBe(false);
    expect(roll).not.toHaveBeenCalled();
  });
  it('validates every branch before any dice, including unknown targets', () => {
    const bad = contract();
    bad.outcomes.setback.effects = [{ kind: 'track_delta', trackId: 'unknown', delta: 1 }];
    const roll = vi.fn(() => 6);
    expect(() => resolveContracts([bad], state(), roll)).toThrow(/track/i);
    expect(roll).not.toHaveBeenCalled();
  });
});

describe('critical failure on double ones', () => {
  const withCritical = (overrides: Partial<ActionContract> = {}) => {
    const value = contract(overrides);
    value.outcomes.critical = { publicText: 'The lock shatters and the alarm screams.', effects: [{ kind: 'track_delta', trackId: 'alarm', delta: 3 }, { kind: 'strain_delta', characterId: 'lead', delta: 2 }] };
    return value;
  };
  const ones = () => 1;

  it('turns a double 1 into a critical failure whatever the trait and Edge, applying only the critical effects', () => {
    const edged = withCritical({ edge: 1, edgeReason: 'A lookout', helperCharacterIds: ['helper'] });
    const result = resolveContracts([edged], state(), ones);
    expect(result.rolls[0]).toMatchObject({ faces: [1, 1], traitModifier: 2, edge: 1, total: 5, band: 'critical' });
    expect(result.outcomes[0]).toMatchObject({ status: 'resolved', band: 'critical', goalAchieved: false, publicText: 'The lock shatters and the alarm screams.' });
    expect(result.effects).toEqual(edged.outcomes.critical!.effects);
    expect(resolveContracts([withCritical({ trait: 'force' })], state(), ones).outcomes[0].band).toBe('critical');
  });

  it('gives critical only on two ones', () => {
    for (const faces of [[1, 2], [2, 1], [1, 6]]) {
      const queue = [...faces];
      expect(resolveContracts([withCritical()], state(), () => queue.shift()!).outcomes[0].band).not.toBe('critical');
    }
  });

  it('is a plain setback on a double 1 when the contract has no critical branch', () => {
    const result = resolveContracts([contract()], state(), ones);
    expect(result.rolls[0]).toMatchObject({ band: 'setback', total: 4 });
    expect(result.outcomes[0]).toMatchObject({ band: 'setback', goalAchieved: false });
    expect(result.effects).toEqual(contract().outcomes.setback.effects);
  });

  it('holds a dependent check after a critical failure', () => {
    const dependent = contract({ id: 'dependent', actorCharacterId: 'other', prerequisites: [{ contractId: 'lock', requirement: 'goal_achieved' }] });
    const result = resolveContracts([withCritical(), dependent], state(), ones);
    expect(result.outcomes.find(outcome => outcome.contractId === 'dependent')).toMatchObject({ status: 'held', goalAchieved: false });
  });

  it('refuses an impossible critical effect before any dice', () => {
    const bad = withCritical();
    bad.outcomes.critical!.effects = [{ kind: 'inventory_remove', characterId: 'other', item: 'brass key' }];
    const roll = vi.fn(() => 6);
    expect(() => resolveContracts([bad], state(), roll)).toThrow(/possess|consume|item/i);
    expect(roll).not.toHaveBeenCalled();
  });

  it('refuses conflicting item claims that only appear in a critical branch', () => {
    const left = withCritical();
    const right = contract({ id: 'right', actorCharacterId: 'other' });
    left.outcomes.critical!.effects = [{ kind: 'inventory_add', characterId: 'lead', item: 'new key' }];
    right.outcomes.clean.effects = [{ kind: 'inventory_add', characterId: 'lead', item: 'new key' }];
    expect(() => validateContracts([left, right], state())).toThrow(/conflict|ruling/i);
  });

  it('times six checks whose four bands all differ', () => {
    const heavy = Array.from({ length: 6 }, (_, index) => {
      const value = withCritical({ id: `c${index}`, actorCharacterId: ['lead', 'helper', 'other'][index % 3] });
      value.outcomes.clean.effects = [{ kind: 'track_delta', trackId: 'access', delta: 1 }];
      value.outcomes.costly.effects = [{ kind: 'track_delta', trackId: 'access', delta: 1 }, { kind: 'track_delta', trackId: 'alarm', delta: 1 }];
      value.outcomes.setback.effects = [{ kind: 'track_delta', trackId: 'alarm', delta: 2 }];
      value.outcomes.critical!.effects = [{ kind: 'track_delta', trackId: 'alarm', delta: 3 }];
      return value;
    });
    const actors = ['lead', 'helper', 'other', 'lead', 'helper', 'other'];
    heavy.forEach((value, index) => { value.actorCharacterId = actors[index]; value.submissionIds = [`input-${index}`]; });
    const lines = heavy.map((value, index) => ({ id: `input-${index}`, characterId: actors[index] }));
    const started = performance.now();
    validateContracts(heavy, state(), lines);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('Say-led rolls at four strain', () => {
  const tired = () => {
    const current = state();
    current.characters[0].strain = 4;
    (current.characters[0] as { displayName?: string }).displayName = 'Dash';
    return current;
  };
  const say = { id: 'input', characterId: 'lead', kind: 'say' as const };

  it('allows a check led by the character\'s own Say line', () => {
    expect(() => validateContracts([contract()], tired(), [say])).not.toThrow();
    expect(resolveContracts([contract()], tired(), () => 6, [say]).rolls).toHaveLength(1);
  });

  it('refuses a check led by a Do line, naming the character', () => {
    expect(() => validateContracts([contract()], tired(), [{ ...say, kind: 'act' }])).toThrow(/Dash is at four strain/);
    expect(() => validateContracts([contract()], tired(), [{ ...say, kind: 'act' }])).toThrow(/four strain/);
  });

  it('refuses a check when the actor leads with a Say line and a Do line', () => {
    const both = contract({ submissionIds: ['input', 'second'] });
    expect(() => validateContracts([both], tired(), [say, { id: 'second', characterId: 'lead', kind: 'act' }])).toThrow(/four strain/);
  });

  it('refuses a check with no lines, a line of unknown kind, or no own line cited', () => {
    expect(() => validateContracts([contract()], tired())).toThrow(/Dash is at four strain/);
    expect(() => validateContracts([contract()], tired(), [{ id: 'input', characterId: 'lead' }])).toThrow(/four strain/);
    expect(() => validateContracts([contract()], tired(), [{ ...say, characterId: 'other' }])).toThrow(/four strain/);
  });

  it('still lets No check and Blocked contracts through at four strain', () => {
    expect(() => validateContracts([contract({ ruling: 'no_check' })], tired())).not.toThrow();
    expect(() => validateContracts([contract({ ruling: 'blocked' })], tired())).not.toThrow();
  });
});

describe('RULE-05 bounded atomic effect application', () => {
  it('applies dependency layers in causal order while aggregating independent effects', () => {
    const current = state();
    current.tracks[0].current = 3;
    const parent = contract({ id: 'parent', ruling: 'no_check' });
    const child = contract({ id: 'child', actorCharacterId: 'other', ruling: 'no_check', prerequisites: [{ contractId: 'parent', requirement: 'goal_achieved' }] });
    child.outcomes.clean.effects = [{ kind: 'track_delta', trackId: 'access', delta: -2 }];
    const dependent = resolveContracts([child, parent], current, () => 6);
    expect(applyResolution(current, dependent).tracks[0].current).toBe(2);
    child.prerequisites = [];
    expect(applyResolution(current, resolveContracts([parent, child], current, () => 6)).tracks[0].current).toBe(3);
    expect(dependent.effects).toEqual([...parent.outcomes.clean.effects, ...child.outcomes.clean.effects]);
  });
  it('aggregates opposing effects against one snapshot before bounding', () => {
    const current = state();
    const updated = applyEffects(current, [
      { kind: 'track_delta', trackId: 'alarm', delta: 3 },
      { kind: 'track_delta', trackId: 'alarm', delta: -2 },
      { kind: 'strain_delta', characterId: 'lead', delta: 4 },
    ]);
    expect(updated.tracks.find(track => track.id === 'alarm')?.current).toBe(6);
    expect(updated.characters[0].strain).toBe(4);
    expect(current.characters[0].strain).toBe(0);
    expect(updated.characters[0].traits).toEqual(current.characters[0].traits);
    expect(applyEffects(updated, [{ kind: 'strain_delta', characterId: 'lead', delta: -2 }]).characters[0].strain).toBe(2);
    expect(() => validateContracts([contract()], updated)).toThrow(/strain|help/i);
  });
  it('deduplicates one shared incident per target but allows different targets', () => {
    const updated = applyEffects(state(), [
      { kind: 'track_delta', trackId: 'access', delta: 2, incidentId: 'shared' },
      { kind: 'track_delta', trackId: 'access', delta: 2, incidentId: 'shared' },
      { kind: 'strain_delta', characterId: 'lead', delta: 1, incidentId: 'shared' },
    ]);
    expect(updated.tracks[0].current).toBe(2);
    expect(updated.characters[0].strain).toBe(1);
  });
  it('rejects conflicting incident deltas and fact identifiers instead of last writer wins', () => {
    expect(() => applyEffects(state(), [
      { kind: 'track_delta', trackId: 'access', delta: 2, incidentId: 'shared' },
      { kind: 'track_delta', trackId: 'access', delta: 3, incidentId: 'shared' },
    ])).toThrow(/conflict/i);
    expect(() => applyEffects(state(), [
      { kind: 'fact_add', factId: 'ledger', text: 'The ledger is safe.', visibility: 'public' },
      { kind: 'fact_add', factId: 'ledger', text: 'The ledger burned.', visibility: 'public' },
    ])).toThrow(/conflict/i);
  });
});

describe('RULE-04 dependent inventory preflight', () => {
  function inventoryChain(parentRuling: ActionContract['ruling'] = 'no_check') {
    const parent = contract({ id: 'supply', ruling: parentRuling });
    parent.outcomes.clean.effects = [{ kind: 'inventory_add', characterId: 'other', item: 'brass key' }];
    parent.outcomes.costly.effects = [{ kind: 'inventory_add', characterId: 'other', item: 'brass key' }, { kind: 'track_delta', trackId: 'alarm', delta: 1 }];
    parent.outcomes.setback.effects = [{ kind: 'track_delta', trackId: 'alarm', delta: 2 }];
    const child = contract({ id: 'consume', actorCharacterId: 'other', ruling: 'no_check', prerequisites: [{ contractId: parent.id, requirement: 'goal_achieved' }] });
    child.outcomes.clean.effects = [{ kind: 'inventory_remove', characterId: 'other', item: 'brass key' }];
    return { parent, child };
  }

  it('allows a no-check prerequisite to supply an item that its dependent consumes', () => {
    const { parent, child } = inventoryChain();
    const roll = vi.fn(() => 6);
    const current = state();
    const result = resolveContracts([child, parent], current, roll);
    expect(result.outcomes.map(outcome => outcome.goalAchieved)).toEqual([true, true]);
    expect(applyResolution(current, result).characters[2].possessions).toEqual([]);
    expect(roll).not.toHaveBeenCalled();
    expect(current.characters[2].possessions).toEqual([]);
  });

  it.each([[6, 'clean'], [3, 'costly']] as const)('accepts successful prerequisite band %s supplying the required item', (face, band) => {
    const { parent, child } = inventoryChain('check');
    const roll = vi.fn(() => face);
    const current = state();
    const result = resolveContracts([child, parent], current, roll);
    expect(result.outcomes[0].band).toBe(band);
    expect(result.outcomes[1].goalAchieved).toBe(true);
    expect(applyResolution(current, result).characters[2].possessions).toEqual([]);
    expect(roll).toHaveBeenCalledTimes(2);
  });

  it('holds the consumer after prerequisite failure without inventing inventory', () => {
    const { parent, child } = inventoryChain('check');
    const current = state();
    const roll = vi.fn(() => 1);
    const result = resolveContracts([child, parent], current, roll);
    expect(result.outcomes[1]).toMatchObject({ status: 'held', goalAchieved: false });
    expect(result.effects.some(effect => effect.kind === 'inventory_add' || effect.kind === 'inventory_remove')).toBe(false);
    expect(applyResolution(current, result).characters[2].possessions).toEqual([]);
    expect(roll).toHaveBeenCalledTimes(2);
  });

  it('rejects a chain whose costly prerequisite branch does not supply the item before rolling', () => {
    const { parent, child } = inventoryChain('check');
    parent.outcomes.costly.effects = [];
    const roll = vi.fn(() => 6);
    expect(() => resolveContracts([parent, child], state(), roll)).toThrow(/consume|possess|inventory/i);
    expect(roll).not.toHaveBeenCalled();
  });

  it('rejects independent double consumption and competing item claims before rolling', () => {
    for (const kind of ['inventory_remove', 'inventory_add'] as const) {
      const item = kind === 'inventory_remove' ? 'lockpick' : 'new key';
      const left = contract({ id: 'left' });
      const right = contract({ id: 'right', actorCharacterId: 'other' });
      for (const action of [left, right]) action.outcomes.clean.effects = [{ kind, characterId: 'lead', item }];
      const roll = vi.fn(() => 6);
      expect(() => resolveContracts([left, right], state(), roll)).toThrow(/conflict|ruling/i);
      expect(roll).not.toHaveBeenCalled();
    }
  });

  it('rejects combined inventory capacity overflow before any dice', () => {
    const current = state();
    current.characters[0].possessions = Array.from({ length: 19 }, (_, index) => `item-${index}`);
    const left = contract({ id: 'left' });
    const right = contract({ id: 'right', actorCharacterId: 'other' });
    left.outcomes.clean.effects = [{ kind: 'inventory_add', characterId: 'lead', item: 'first key' }];
    right.outcomes.clean.effects = [{ kind: 'inventory_add', characterId: 'lead', item: 'second key' }];
    const roll = vi.fn(() => 6);
    expect(() => resolveContracts([left, right], current, roll)).toThrow(/capacity/i);
    expect(roll).not.toHaveBeenCalled();
  });
});

describe('one action per line', () => {
  const lines = (...characterIds: string[]) => characterIds.map((characterId, index) => ({ id: `line-${index}`, characterId }));
  const second = (overrides: Partial<ActionContract> = {}) => contract({ id: 'second', ...overrides });

  it('lets one character lead two contracts with two lines and rolls twice', () => {
    const roll = vi.fn(() => 3);
    const result = resolveContracts([contract(), second()], state(), roll, lines('lead', 'lead'));
    expect(result.rolls).toHaveLength(2);
    expect(roll).toHaveBeenCalledTimes(4);
  });

  it('refuses the same two contracts with one line', () => {
    const roll = vi.fn(() => 3);
    expect(() => resolveContracts([contract(), second()], state(), roll, lines('lead'))).toThrow('lead has more actions than lines this round. Each line can be one action.');
    expect(roll).not.toHaveBeenCalled();
  });

  it('refuses two contracts led by one character when no lines are given', () => {
    expect(() => validateContracts([contract(), second()], state())).toThrow(/more actions than lines/);
  });

  it('lets a character lead one contract and help another with two lines', () => {
    const helped = second({ actorCharacterId: 'other', helperCharacterIds: ['lead'], edge: 1, edgeReason: 'A lookout' });
    expect(() => validateContracts([contract(), helped], state(), lines('lead', 'lead', 'other'))).not.toThrow();
  });

  it('refuses a character helping their own contract', () => {
    const own = contract({ helperCharacterIds: ['lead'], edge: 1, edgeReason: 'Hands full' });
    expect(() => validateContracts([own], state(), lines('lead', 'lead'))).toThrow('lead cannot help their own action.');
  });

  it('refuses helping two contracts even with three lines', () => {
    const first = contract({ helperCharacterIds: ['helper'], edge: 1, edgeReason: 'Watching' });
    const next = second({ actorCharacterId: 'other', helperCharacterIds: ['helper'], edge: 1, edgeReason: 'Watching' });
    expect(() => validateContracts([first, next], state(), lines('lead', 'helper', 'helper', 'helper', 'other'))).toThrow('helper can help only one action in a round.');
  });

  it('counts a repeated helper inside one contract', () => {
    const doubled = contract({ helperCharacterIds: ['helper', 'helper'], edge: 1, edgeReason: 'Watching' });
    expect(() => validateContracts([doubled], state(), lines('lead', 'helper', 'helper'))).toThrow(/can help only one action/);
  });

  it('names the character by display name when there is one', () => {
    const current = state();
    (current.characters[0] as { displayName?: string }).displayName = 'Dash';
    expect(() => validateContracts([contract(), second()], current, lines('lead'))).toThrow(/^Dash has more actions/);
  });

  it('refuses more than six contracts with the exact message', () => {
    const many = Array.from({ length: MAX_ROLLS_PER_ROUND + 1 }, (_, index) => contract({ id: `c${index}` }));
    expect(() => validateContracts(many, state())).toThrow(tooManyRollsMessage(7));
    expect(tooManyRollsMessage(7)).toBe('A round can show at most six rolls, and this plan needs 7. Untick some lines and plan again, then plan the rest in the next round.');
  });
});
