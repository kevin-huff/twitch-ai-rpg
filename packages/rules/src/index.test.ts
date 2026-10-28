import { describe, expect, it, vi } from 'vitest';
import { ActionContractSchema, type ActionContract, type Effect, type OutcomeBand, type SessionState } from '@rpg/contracts';
import { MAX_ROLLS_PER_ROUND, applyEffects, applyResolution, outcomeForTotal, tooManyRollsMessage, resolveContracts, validateContracts, validateTraits, type ContractLine } from './index';

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

// The walk validateContracts used before the fast check, kept here to prove the answers match.
function oldValidateContracts(contracts: ActionContract[], current: SessionState, lines?: readonly ContractLine[]): void {
  if (contracts.length > MAX_ROLLS_PER_ROUND) throw new Error(tooManyRollsMessage(contracts.length));
  const parsed = contracts.map(value => ActionContractSchema.parse(value));
  const byId = new Map(parsed.map(value => [value.id, value]));
  if (byId.size !== parsed.length) throw new Error('Contract IDs must be unique.');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: ActionContract[] = [];
  const order = (value: ActionContract) => {
    if (visiting.has(value.id)) throw new Error('Contract dependency cycle.');
    if (visited.has(value.id)) return;
    visiting.add(value.id);
    for (const prerequisite of value.prerequisites) {
      const parent = byId.get(prerequisite.contractId);
      if (!parent) throw new Error('Unknown prerequisite contract.');
      order(parent);
    }
    visiting.delete(value.id);
    visited.add(value.id);
    ordered.push(value);
  };
  [...parsed].sort((a, b) => a.id.localeCompare(b.id)).forEach(order);
  const allowed = new Map<string, number>();
  for (const line of lines ?? []) allowed.set(line.characterId, (allowed.get(line.characterId) ?? 0) + 1);
  const used = new Map<string, number>();
  const helped = new Map<string, number>();
  const nameOf = (characterId: string) => current.characters.find(character => character.id === characterId)?.displayName ?? characterId;
  const spend = (characterId: string) => {
    const count = (used.get(characterId) ?? 0) + 1;
    used.set(characterId, count);
    if (count > (lines ? allowed.get(characterId) ?? 0 : 1)) throw new Error(`${nameOf(characterId)} has more actions than lines this round. Each line can be one action.`);
  };
  for (const value of ordered) {
    const actor = current.characters.find(character => character.id === value.actorCharacterId);
    if (!actor) throw new Error('Unknown action actor.');
    if (!validateTraits(actor.traits)) throw new Error('Invalid character traits.');
    if (actor.strain >= 4 && value.ruling === 'check') {
      const own = lines ? lines.filter(line => value.submissionIds.includes(line.id) && line.characterId === value.actorCharacterId) : [];
      if (!own.length || own.some(line => line.kind !== 'say')) throw new Error(`${nameOf(value.actorCharacterId)} is at four strain, so only something they say can roll. Choose No check or Blocked, or make the line help another character.`);
    }
    if (value.edge && !value.edgeReason?.trim()) throw new Error('Edge requires an established reason.');
    if (value.helperCharacterIds.length && value.edge !== 1) throw new Error('Meaningful helpers grant one Edge.');
    spend(value.actorCharacterId);
    for (const characterId of value.helperCharacterIds) {
      if (!current.characters.some(character => character.id === characterId)) throw new Error('Unknown action helper.');
      if (characterId === value.actorCharacterId) throw new Error(`${nameOf(characterId)} cannot help their own action.`);
      const helps = (helped.get(characterId) ?? 0) + 1;
      helped.set(characterId, helps);
      if (helps > 1) throw new Error(`${nameOf(characterId)} can help only one action in a round.`);
      spend(characterId);
    }
  }
  const bands = (value: ActionContract): OutcomeBand[] => value.ruling === 'blocked' ? [] : value.ruling === 'no_check' ? ['clean'] : value.outcomes.critical ? ['clean', 'costly', 'setback', 'critical'] : ['clean', 'costly', 'setback'];
  const ancestors = new Map<string, Set<string>>();
  const depths = new Map<string, number>();
  const claims = new Map<string, Set<string>>();
  for (const value of ordered) {
    const inherited = new Set<string>();
    for (const prerequisite of value.prerequisites) {
      inherited.add(prerequisite.contractId);
      for (const ancestor of ancestors.get(prerequisite.contractId)!) inherited.add(ancestor);
    }
    ancestors.set(value.id, inherited);
    depths.set(value.id, value.prerequisites.length ? 1 + Math.max(...value.prerequisites.map(prerequisite => depths.get(prerequisite.contractId)!)) : 0);
    for (const band of bands(value)) for (const effect of value.outcomes[band]!.effects) {
      const key = effect.kind === 'fact_add' ? `fact:${effect.factId}`
        : effect.kind === 'inventory_add' || effect.kind === 'inventory_remove' ? `item:${effect.characterId}:${effect.item}` : null;
      if (!key) continue;
      const owners = claims.get(key) ?? new Set<string>();
      for (const owner of owners) {
        if (owner !== value.id && !inherited.has(owner)) throw new Error('Conflicting nonnumeric changes require a ruling before lock.');
      }
      owners.add(value.id);
      claims.set(key, owners);
    }
  }
  const goals = new Map<string, boolean>();
  const groups: Effect[][] = [];
  const visit = (index: number) => {
    if (index === ordered.length) {
      const effectGroups = groups.filter(group => group?.length);
      applyResolution(current, { rolls: [], outcomes: [], effects: effectGroups.flat(), effectGroups });
      return;
    }
    const value = ordered[index];
    if (value.ruling === 'blocked' || value.prerequisites.some(prerequisite => !goals.get(prerequisite.contractId))) {
      goals.set(value.id, false);
      visit(index + 1);
    } else {
      const depth = depths.get(value.id)!;
      const previous = groups[depth] ?? [];
      for (const band of bands(value)) {
        goals.set(value.id, band === 'clean' || band === 'costly');
        groups[depth] = [...previous, ...value.outcomes[band]!.effects];
        visit(index + 1);
      }
      groups[depth] = previous;
    }
    goals.delete(value.id);
  };
  visit(0);
}

function answer(run: () => void): string {
  try {
    run();
    return 'pass';
  } catch (error) {
    return (error as Error).message;
  }
}

function seeded(seed: number) {
  let value = seed >>> 0;
  const next = () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max: number) => Math.floor(next() * max);
  const pick = <T,>(items: readonly T[]): T => items[int(items.length)];
  return { next, int, pick };
}

describe('fast possible-effects check', () => {
  const generatedState = (random: ReturnType<typeof seeded>) => {
    const current = state();
    current.characters[0].possessions = random.next() < 0.3 ? Array.from({ length: 19 }, (_, index) => `item-${index}`) : ['lockpick', 'rope'];
    current.characters[1].possessions = random.next() < 0.5 ? ['brass key'] : [];
    current.facts = random.next() < 0.6 ? [{ id: 'ledger', text: 'The ledger is safe.', visibility: 'public', sourceEventId: 'start' }] : [];
    return current;
  };

  const generatedEffect = (random: ReturnType<typeof seeded>): Effect => {
    const incident = random.next() < 0.25 ? { incidentId: random.pick(['shared', 'other']) } : {};
    const roll = random.next();
    if (roll < 0.3) return { kind: 'track_delta', trackId: random.pick(['access', 'alarm', 'access', 'alarm', 'missing']), delta: random.pick([1, 2, -1]), ...incident };
    if (roll < 0.45) return { kind: 'strain_delta', characterId: random.pick(['lead', 'helper', 'other', 'ghost']), delta: random.pick([1, 2]), ...incident };
    if (roll < 0.6) return { kind: 'fact_add', factId: random.pick(['ledger', 'door', 'door']), text: random.pick(['The ledger is safe.', 'The door is open.', 'The ledger burned.']), visibility: random.pick(['public', 'public', 'director']), ...incident } as Effect;
    return {
      kind: random.pick(['inventory_add', 'inventory_remove'] as const),
      characterId: random.pick(['lead', 'helper', 'other', 'ghost']),
      item: random.pick(['lockpick', 'brass key', 'rope', 'new key', 'lamp']),
      ...incident,
    };
  };

  const generatedPlan = (random: ReturnType<typeof seeded>) => {
    const count = 1 + random.int(6);
    const actors = ['lead', 'helper', 'other'];
    const plan = Array.from({ length: count }, (_, index) => {
      const value = contract({
        id: `c${index}`,
        actorCharacterId: random.pick(actors),
        ruling: random.pick(['check', 'check', 'check', 'no_check', 'blocked'] as const),
        submissionIds: [`line-${index}`],
      });
      const prerequisites = index > 0 && random.next() < 0.35 ? [{ contractId: `c${random.int(index)}`, requirement: 'goal_achieved' as const }] : [];
      value.prerequisites = prerequisites;
      const effects = () => Array.from({ length: random.int(3) }, () => generatedEffect(random));
      value.outcomes.clean.effects = effects();
      value.outcomes.costly.effects = effects();
      value.outcomes.setback.effects = effects();
      if (random.next() < 0.5) value.outcomes.critical = { publicText: 'It all goes wrong.', effects: effects() };
      return value;
    });
    const lines = plan.map((value, index) => ({ id: `line-${index}`, characterId: value.actorCharacterId }));
    return { plan: random.next() < 0.5 ? [...plan].reverse() : plan, lines };
  };

  it('gives the same pass or fail and the same first error as the old walk on generated plans', () => {
    const random = seeded(20261028);
    const answers = new Map<string, number>();
    for (let run = 0; run < 1500; run++) {
      const current = generatedState(random);
      const { plan, lines } = generatedPlan(random);
      const expected = answer(() => oldValidateContracts(structuredClone(plan), structuredClone(current), lines));
      expect(answer(() => validateContracts(plan, current, lines)), `generated plan ${run}`).toBe(expected);
      answers.set(expected, (answers.get(expected) ?? 0) + 1);
    }
    expect(answers.get('pass') ?? 0).toBeGreaterThan(100);
    for (const message of [
      'Unknown track in effect.', 'Unknown character in effect.', 'Conflicting shared incident effects.',
      'Conflicting fact updates require a ruling.', 'Cannot consume an item the character does not possess.',
      'Cannot duplicate an existing inventory item.', 'Conflicting inventory changes require a ruling.',
      'Inventory capacity exceeded.', 'Conflicting nonnumeric changes require a ruling before lock.',
    ]) expect(answers.get(message) ?? 0, message).toBeGreaterThan(0);
  });

  it('matches the old walk on dependent chains that add and spend items across depths', () => {
    const random = seeded(7);
    for (let run = 0; run < 400; run++) {
      const current = generatedState(random);
      const parent = contract({ id: 'a-parent', ruling: random.pick(['check', 'no_check'] as const) });
      const child = contract({ id: 'b-child', actorCharacterId: 'other', ruling: random.pick(['check', 'no_check'] as const), prerequisites: [{ contractId: 'a-parent', requirement: 'goal_achieved' }] });
      const grandchild = contract({ id: 'c-grandchild', actorCharacterId: 'helper', prerequisites: [{ contractId: 'b-child', requirement: 'goal_achieved' }] });
      for (const value of [parent, child, grandchild]) {
        for (const band of ['clean', 'costly', 'setback'] as const) value.outcomes[band].effects = Array.from({ length: random.int(3) }, () => generatedEffect(random));
        if (random.next() < 0.5) value.outcomes.critical = { publicText: 'It breaks.', effects: [generatedEffect(random)] };
      }
      const plan = [grandchild, parent, child];
      const expected = answer(() => oldValidateContracts(structuredClone(plan), structuredClone(current)));
      expect(answer(() => validateContracts(plan, current)), `chain ${run}`).toBe(expected);
    }
  });

  it('checks six four-outcome contracts on a 100 KB state in under 100 ms', () => {
    const current = state();
    const filler = 'The archive hums with old secrets and older dust. '.repeat(8);
    current.facts = Array.from({ length: 220 }, (_, index) => ({ id: `fact-${index}`, text: `${index}: ${filler}`, visibility: 'public', sourceEventId: 'start' }));
    for (const character of current.characters) Object.assign(character, { backstory: filler.repeat(4), appearance: filler, possessions: ['lockpick', 'rope', 'lamp'].map(item => `${character.id} ${item}`) });
    expect(JSON.stringify(current).length).toBeGreaterThan(100_000);
    const actors = ['lead', 'helper', 'other', 'lead', 'helper', 'other'];
    const heavy = actors.map((actor, index) => {
      const value = contract({ id: `heavy-${index}`, actorCharacterId: actor, submissionIds: [`input-${index}`] });
      value.outcomes.clean.effects = [{ kind: 'track_delta', trackId: 'access', delta: 1 }, { kind: 'fact_add', factId: `won-${index}`, text: `Contract ${index} won.`, visibility: 'public' }];
      value.outcomes.costly.effects = [{ kind: 'track_delta', trackId: 'access', delta: 1 }, { kind: 'track_delta', trackId: 'alarm', delta: 1 }, { kind: 'inventory_add', characterId: actor, item: `token ${index}` }];
      value.outcomes.setback.effects = [{ kind: 'track_delta', trackId: 'alarm', delta: 2 }, { kind: 'strain_delta', characterId: actor, delta: 1, incidentId: 'cave-in' }];
      value.outcomes.critical = { publicText: 'It all collapses.', effects: [{ kind: 'track_delta', trackId: 'alarm', delta: 3 }, { kind: 'inventory_remove', characterId: actor, item: index < 3 ? `${actor} lamp` : `${actor} rope` }] };
      return value;
    });
    const lines = heavy.map((value, index) => ({ id: `input-${index}`, characterId: actors[index] }));
    const times = [0, 1, 2].map(() => {
      const started = performance.now();
      validateContracts(heavy, current, lines);
      return performance.now() - started;
    });
    expect(Math.min(...times)).toBeLessThan(100);
  });
});
