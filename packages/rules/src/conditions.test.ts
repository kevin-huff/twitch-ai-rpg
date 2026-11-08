import { describe, expect, it, vi } from 'vitest';
import type { ActionContract, Effect, SessionState } from '@rpg/contracts';
import { applyEffects, applyResolution, isCardMismatch, resolveContracts, validateContracts, type ContractLine } from './index';

const state = () => ({
  characters: [
    { id: 'dash', displayName: 'Dash', traits: { force: 0, finesse: 2, wits: 1, presence: 1 }, strain: 0, possessions: ['lockpick'] },
    { id: 'mara', displayName: 'Mara', traits: { force: 2, finesse: 0, wits: 1, presence: 1 }, strain: 0, possessions: [] },
    { id: 'scrot', displayName: 'Scrot', traits: { force: 1, finesse: 1, wits: 2, presence: 0 }, strain: 0, possessions: [] },
  ],
  npcs: [
    { id: 'warden', displayName: 'The Warden', status: 'present', version: 3 },
    { id: 'ghost', displayName: 'Old Pell', status: 'offstage', version: 1, condition: 'dead' },
  ],
  tracks: [{ id: 'alarm', current: 0, max: 6 }],
  facts: [],
}) as unknown as SessionState;

const character = (current: SessionState, id: string) => current.characters.find(value => value.id === id)!;

const contract = (overrides: Partial<ActionContract> = {}): ActionContract => ({
  id: 'act', version: 1, actorCharacterId: 'dash', helperCharacterIds: [], submissionIds: ['line'],
  intent: 'Cross the bridge', approach: 'Run', ruling: 'check', trait: 'finesse',
  edge: 0, edgeReason: null, risk: 'high', prerequisites: [], fallback: { kind: 'hold' },
  outcomes: {
    clean: { publicText: 'Across.', effects: [] },
    costly: { publicText: 'Across, bruised.', effects: [] },
    setback: { publicText: 'The bridge gives way.', effects: [] },
  }, ...overrides,
});

const withEffects = (band: 'clean' | 'costly' | 'setback' | 'critical', effects: Effect[], overrides: Partial<ActionContract> = {}) => {
  const value = contract(overrides);
  if (band === 'critical') value.outcomes.critical = { publicText: 'It all goes wrong.', effects };
  else value.outcomes[band].effects = effects;
  return value;
};

function answer(run: () => void): string {
  try {
    run();
    return 'pass';
  } catch (error) {
    return (error as Error).message;
  }
}

describe('condition outcomes', () => {
  it('puts a character down, leaving strain where it is', () => {
    const current = state();
    character(current, 'dash').strain = 5;
    const next = applyEffects(current, [{ kind: 'character_down', characterId: 'dash' }]);
    expect(character(next, 'dash')).toMatchObject({ condition: 'down', strain: 5 });
    expect('condition' in character(current, 'dash')).toBe(false);
  });

  it('rescues a downed character back up at 6 of 8', () => {
    const current = state();
    Object.assign(character(current, 'dash'), { condition: 'down', strain: 8 });
    const next = applyEffects(current, [{ kind: 'character_rescue', characterId: 'dash' }]);
    expect('condition' in character(next, 'dash')).toBe(false);
    expect(character(next, 'dash').strain).toBe(6);
  });

  it('kills a non-player character: dead, offstage and one version on', () => {
    const next = applyEffects(state(), [{ kind: 'npc_death', npcId: 'warden' }]);
    expect(next.npcs[0]).toMatchObject({ condition: 'dead', status: 'offstage', version: 4 });
  });

  it('applies condition effects leniently on characters already in that state', () => {
    const current = state();
    Object.assign(character(current, 'dash'), { condition: 'down', strain: 3 });
    Object.assign(character(current, 'mara'), { condition: 'dead', strain: 2 });
    const next = applyEffects(current, [
      { kind: 'character_down', characterId: 'dash' },
      { kind: 'character_rescue', characterId: 'mara' },
      { kind: 'character_rescue', characterId: 'scrot' },
      { kind: 'npc_death', npcId: 'ghost' },
    ]);
    expect(character(next, 'dash')).toMatchObject({ condition: 'down', strain: 3 });
    expect(character(next, 'mara')).toMatchObject({ condition: 'dead', strain: 2 });
    expect('condition' in character(next, 'scrot')).toBe(false);
    expect(character(next, 'scrot').strain).toBe(0);
    expect(next.npcs[1]).toMatchObject({ condition: 'dead', version: 1 });
  });

  it('works on a state with no conditions anywhere', () => {
    const current = state();
    const next = applyEffects(current, [{ kind: 'strain_delta', characterId: 'dash', delta: 2 }, { kind: 'track_delta', trackId: 'alarm', delta: 1 }]);
    expect(next.characters.some(value => 'condition' in value)).toBe(false);
    expect(next.npcs.some(value => 'condition' in value && value.id === 'warden')).toBe(false);
    expect(character(next, 'dash').strain).toBe(2);
  });

  it('refuses unknown targets', () => {
    expect(answer(() => applyEffects(state(), [{ kind: 'character_down', characterId: 'nobody' }]))).toBe('Unknown character in effect.');
    expect(answer(() => applyEffects(state(), [{ kind: 'character_rescue', characterId: 'nobody' }]))).toBe('Unknown character in effect.');
    expect(answer(() => applyEffects(state(), [{ kind: 'npc_death', npcId: 'nobody' }]))).toBe('Unknown non-player character in effect.');
    expect(answer(() => validateContracts([withEffects('clean', [{ kind: 'npc_death', npcId: 'nobody' }])], state()))).toBe('Unknown non-player character in effect.');
  });
});

describe('a hit at full strain', () => {
  it('puts an up character already at 8 down and keeps them at 8', () => {
    const current = state();
    character(current, 'dash').strain = 8;
    const next = applyEffects(current, [{ kind: 'strain_delta', characterId: 'dash', delta: 1 }]);
    expect(character(next, 'dash')).toMatchObject({ condition: 'down', strain: 8 });
  });

  it('stops a character below 8 at 8 without putting them down', () => {
    const current = state();
    character(current, 'dash').strain = 7;
    const next = applyEffects(current, [{ kind: 'strain_delta', characterId: 'dash', delta: 2 }]);
    expect(character(next, 'dash').strain).toBe(8);
    expect('condition' in character(next, 'dash')).toBe(false);
  });

  it('judges the group as a whole, from the strain before it', () => {
    const current = state();
    character(current, 'dash').strain = 7;
    const split = applyEffects(current, [{ kind: 'strain_delta', characterId: 'dash', delta: 1 }, { kind: 'strain_delta', characterId: 'dash', delta: 1 }]);
    expect('condition' in character(split, 'dash')).toBe(false);
    character(current, 'dash').strain = 8;
    const net = applyEffects(current, [{ kind: 'strain_delta', characterId: 'dash', delta: 2 }, { kind: 'strain_delta', characterId: 'dash', delta: -2 }]);
    expect('condition' in character(net, 'dash')).toBe(false);
  });

  it('changes no condition for a character who is already down or dead', () => {
    const current = state();
    Object.assign(character(current, 'dash'), { condition: 'down', strain: 8 });
    Object.assign(character(current, 'mara'), { condition: 'dead', strain: 8 });
    const next = applyEffects(current, [{ kind: 'strain_delta', characterId: 'dash', delta: 2 }, { kind: 'strain_delta', characterId: 'mara', delta: 2 }]);
    expect(character(next, 'dash')).toMatchObject({ condition: 'down', strain: 8 });
    expect(character(next, 'mara')).toMatchObject({ condition: 'dead', strain: 8 });
  });

  it('applies strain before condition effects in one group, so a rescue in the same group still lands', () => {
    const current = state();
    character(current, 'dash').strain = 8;
    const next = applyEffects(current, [{ kind: 'character_rescue', characterId: 'dash' }, { kind: 'strain_delta', characterId: 'dash', delta: 1 }]);
    expect('condition' in character(next, 'dash')).toBe(false);
    expect(character(next, 'dash').strain).toBe(6);
  });

  it('puts a character down through an approved, rolled outcome', () => {
    const current = state();
    const fall = withEffects('setback', [{ kind: 'character_down', characterId: 'dash' }]);
    const result = resolveContracts([fall], current, () => 1);
    expect(result.outcomes[0].band).toBe('setback');
    expect(character(applyResolution(current, result), 'dash').condition).toBe('down');
  });
});

describe('condition refusals', () => {
  const down = (id: string, current = state()) => {
    character(current, id).condition = 'down';
    return current;
  };
  const dead = (id: string, current = state()) => {
    character(current, id).condition = 'dead';
    return current;
  };
  const say: ContractLine = { id: 'line', characterId: 'dash', kind: 'say' };

  it('refuses a dead actor or helper', () => {
    expect(answer(() => validateContracts([contract()], dead('dash')))).toBe('Dash has died, so they cannot act.');
    expect(answer(() => validateContracts([contract({ helperCharacterIds: ['mara'], edge: 1, edgeReason: 'She steadies the rope' })], dead('mara'))))
      .toBe('Mara has died, so they cannot act.');
  });

  it('lets a downed actor roll only their own Say line', () => {
    expect(answer(() => validateContracts([contract()], down('dash'), [{ ...say, kind: 'act' }])))
      .toBe('Dash is down, so only a few spoken words from them can roll. Mark their Do line Blocked.');
    expect(answer(() => validateContracts([contract()], down('dash'), [say]))).toBe('pass');
    expect(answer(() => validateContracts([contract({ ruling: 'blocked' })], down('dash'), [{ ...say, kind: 'act' }]))).toBe('pass');
  });

  it('refuses a downed helper', () => {
    expect(answer(() => validateContracts([contract({ helperCharacterIds: ['mara'], edge: 1, edgeReason: 'She steadies the rope' })], down('mara'))))
      .toBe('Mara is down, so they cannot help another action.');
  });

  it('allows going down only on setback and critical outcomes', () => {
    const effect: Effect = { kind: 'character_down', characterId: 'dash' };
    for (const band of ['clean', 'costly'] as const) {
      const roll = vi.fn(() => 6);
      expect(answer(() => resolveContracts([withEffects(band, [effect])], state(), roll))).toBe('Going down can only come from a setback or a critical failure.');
      expect(roll).not.toHaveBeenCalled();
    }
    expect(answer(() => validateContracts([withEffects('setback', [effect])], state()))).toBe('pass');
    expect(answer(() => validateContracts([withEffects('critical', [effect])], state()))).toBe('pass');
    expect(answer(() => validateContracts([withEffects('clean', [effect], { ruling: 'no_check' })], state()))).toBe('Going down can only come from a setback or a critical failure.');
    expect(answer(() => validateContracts([withEffects('clean', [effect], { ruling: 'blocked' })], state()))).toBe('pass');
  });

  it('refuses putting down someone already down or dead', () => {
    expect(answer(() => validateContracts([withEffects('setback', [{ kind: 'character_down', characterId: 'mara' }])], down('mara')))).toBe('Mara is already down.');
    expect(answer(() => validateContracts([withEffects('setback', [{ kind: 'character_down', characterId: 'mara' }])], dead('mara')))).toBe('Mara has died.');
  });

  it('allows a rescue only on clean and costly outcomes, from someone up, of someone down', () => {
    const rescue: Effect = { kind: 'character_rescue', characterId: 'mara' };
    expect(answer(() => validateContracts([withEffects('clean', [rescue])], down('mara')))).toBe('pass');
    expect(answer(() => validateContracts([withEffects('costly', [rescue])], down('mara')))).toBe('pass');
    for (const band of ['setback', 'critical'] as const) {
      expect(answer(() => validateContracts([withEffects(band, [rescue])], down('mara')))).toBe('A rescue can only come from a clean success or a success with a cost.');
    }
    expect(answer(() => validateContracts([withEffects('clean', [rescue])], state()))).toBe('Mara is not down, so there is nobody to rescue.');
    expect(answer(() => validateContracts([withEffects('clean', [{ kind: 'character_rescue', characterId: 'dash' }])], down('dash'), [say])))
      .toBe('Dash cannot rescue themselves. Another character\'s line has to do it.');
    expect(answer(() => validateContracts([withEffects('clean', [rescue])], down('dash', down('mara')), [say]))).toBe('Dash is down, so they cannot rescue anyone.');
  });

  it('refuses killing a non-player character who has already died', () => {
    expect(answer(() => validateContracts([withEffects('clean', [{ kind: 'npc_death', npcId: 'ghost' }])], state()))).toBe('Old Pell has already died.');
    expect(answer(() => validateContracts([withEffects('costly', [{ kind: 'npc_death', npcId: 'warden' }])], state()))).toBe('pass');
  });

  it('treats the condition-target refusals as card mismatches, matched as whole messages', () => {
    for (const message of ['Mara is already down.', 'Mara has died.', 'Mara is not down, so there is nobody to rescue.', 'Old Pell has already died.']) {
      expect(isCardMismatch(message), message).toBe(true);
    }
    for (const message of [
      'Dash has died, so they cannot act.', 'Dash is down, so they cannot rescue anyone.', 'Going down can only come from a setback or a critical failure.',
      'A selected line speaks to Old Pell, who has died. Untick it.', 'Old Pell has died. Bring them back with a correction first.',
    ]) expect(isCardMismatch(message), message).toBe(false);
  });
});

describe('shared incidents keyed by list, entry and item', () => {
  it('passes two card changes for one character on different lists sharing an incident tag', () => {
    const effects: Effect[] = [
      { kind: 'card_add', characterId: 'dash', list: 'owes', entry: 'Owes Mara a favour', incidentId: 'bargain' },
      { kind: 'card_add', characterId: 'dash', list: 'feelings', entry: 'Mara trusts Dash', incidentId: 'bargain' },
    ];
    const next = applyEffects(state(), effects);
    expect(character(next, 'dash')).toMatchObject({ owes: ['Owes Mara a favour'], feelings: ['Mara trusts Dash'] });
    const split = [withEffects('clean', [effects[0]], { id: 'left' }), withEffects('clean', [effects[1]], { id: 'right', actorCharacterId: 'mara' })];
    expect(answer(() => validateContracts(split, state()))).toBe('pass');
  });

  it('passes two different items sharing one incident tag', () => {
    const effects: Effect[] = [
      { kind: 'inventory_add', characterId: 'dash', item: 'rope', incidentId: 'cache' },
      { kind: 'inventory_add', characterId: 'dash', item: 'lamp', incidentId: 'cache' },
    ];
    expect(character(applyEffects(state(), effects), 'dash').possessions).toEqual(['lockpick', 'rope', 'lamp']);
    const split = [withEffects('clean', [effects[0]], { id: 'left' }), withEffects('clean', [effects[1]], { id: 'right', actorCharacterId: 'mara' })];
    expect(answer(() => validateContracts(split, state()))).toBe('pass');
  });

  it('still refuses two different changes to one target under one tag, and applies a shared one once', () => {
    expect(answer(() => applyEffects(state(), [
      { kind: 'strain_delta', characterId: 'dash', delta: 1, incidentId: 'cave-in' },
      { kind: 'strain_delta', characterId: 'dash', delta: 2, incidentId: 'cave-in' },
    ]))).toBe('Conflicting shared incident effects.');
    const shared: Effect = { kind: 'npc_death', npcId: 'warden', incidentId: 'collapse' };
    const result = resolveContracts([withEffects('clean', [shared], { id: 'left' }), withEffects('clean', [shared], { id: 'right', actorCharacterId: 'mara' })], state(), () => 6);
    expect(applyResolution(state(), result).npcs[0]).toMatchObject({ condition: 'dead', version: 4 });
  });

  it('words the card-list conflicts in plain language and keeps the possessions wording', () => {
    const twice = (list: 'wearing' | 'owes' | 'feelings') => answer(() => applyEffects(state(), [
      { kind: 'card_add', characterId: 'dash', list, entry: 'Red scarf' },
      { kind: 'card_remove', characterId: 'dash', list, entry: 'Red scarf' },
    ]));
    expect(twice('wearing')).toBe('The outcomes change one entry in Wearing twice. Keep one change, then approve again.');
    expect(twice('owes')).toBe('The outcomes change one entry in Promises and debts twice. Keep one change, then approve again.');
    expect(twice('feelings')).toBe('The outcomes change one entry in How people feel twice. Keep one change, then approve again.');
    expect(answer(() => applyEffects(state(), [
      { kind: 'inventory_add', characterId: 'dash', item: 'rope' }, { kind: 'inventory_remove', characterId: 'dash', item: 'rope' },
    ]))).toBe('Conflicting inventory changes require a ruling.');
  });
});
