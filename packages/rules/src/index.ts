import {
  ActionContractSchema, CARD_LIST_MAX, CardListSchema, EffectSchema, LAST_CHANCE_STRAIN, RESCUE_STRAIN, STRAIN_MAX, TraitsSchema, cardListChange, incidentKey, strainStep,
  type ActionContract, type CardList, type CardListChange, type Character, type Effect, type OutcomeBand, type Resolution, type Roll, type SessionState,
} from '@rpg/contracts';
export { STRAIN_MAX } from '@rpg/contracts';

export function outcomeForTotal(total: number): OutcomeBand {
  if (!Number.isInteger(total)) throw new Error('A dice total must be an integer.');
  return total >= 10 ? 'clean' : total >= 7 ? 'costly' : 'setback';
}

export function validateTraits(traits: unknown): boolean {
  return TraitsSchema.safeParse(traits).success;
}

function orderedContracts(contracts: ActionContract[]): ActionContract[] {
  const byId = new Map(contracts.map(contract => [contract.id, contract]));
  if (byId.size !== contracts.length) throw new Error('Contract IDs must be unique.');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const result: ActionContract[] = [];
  const visit = (contract: ActionContract) => {
    if (visiting.has(contract.id)) throw new Error('Contract dependency cycle.');
    if (visited.has(contract.id)) return;
    visiting.add(contract.id);
    for (const prerequisite of contract.prerequisites) {
      const parent = byId.get(prerequisite.contractId);
      if (!parent) throw new Error('Unknown prerequisite contract.');
      visit(parent);
    }
    visiting.delete(contract.id);
    visited.add(contract.id);
    result.push(contract);
  };
  [...contracts].sort((a, b) => a.id.localeCompare(b.id)).forEach(visit);
  return result;
}

function uniqueEffects(effects: Effect[]): Effect[] {
  const incidents = new Map<string, string>();
  return effects.filter(effect => {
    EffectSchema.parse(effect);
    if (!effect.incidentId) return true;
    const key = incidentKey(effect);
    const signature = JSON.stringify(effect);
    const previous = incidents.get(key);
    if (previous && previous !== signature) throw new Error('Conflicting shared incident effects.');
    if (previous) return false;
    incidents.set(key, signature);
    return true;
  });
}

const LIST_LABELS: Record<CardList, string> = { wearing: 'Wearing', owes: 'Promises and debts', feelings: 'How people feel' };

// One engine for every exact-text list on a card: possessions (Carrying) keep their old messages word for word.
function applyListChange(entries: string[], change: CardListChange, operations: Set<string>): void {
  const possessions = change.list === 'possessions';
  const operation = JSON.stringify([change.characterId, change.list, change.entry]);
  if (operations.has(operation)) throw new Error(change.list === 'possessions' ? 'Conflicting inventory changes require a ruling.' : `The outcomes change one entry in ${LIST_LABELS[change.list]} twice. Keep one change, then approve again.`);
  operations.add(operation);
  if (change.op === 'remove') {
    const index = entries.indexOf(change.entry);
    if (index < 0) throw new Error(possessions
      ? `Cannot consume an item the character does not possess. Copy one of their possession lines exactly: ${JSON.stringify(entries)}`
      : `Cannot remove an entry the character does not have. Copy one of their ${change.list} lines exactly: ${JSON.stringify(entries)}`);
    entries.splice(index, 1);
  } else {
    if (entries.includes(change.entry)) throw new Error(possessions ? 'Cannot duplicate an existing inventory item.' : `Cannot duplicate an existing ${change.list} entry.`);
    if (entries.length >= CARD_LIST_MAX[change.list]) throw new Error(possessions ? 'Inventory capacity exceeded.' : `The ${change.list} list is full.`);
    entries.push(change.entry);
  }
}

const LOOK_CONFLICT = 'Conflicting look changes require a ruling.';

const cardLists = CardListSchema.options.join('|');
const mismatches = [
  /^Cannot consume an item the character does not possess/, /^Cannot duplicate an existing inventory item\.$/, /^Inventory capacity exceeded\.$/,
  /^Cannot remove an entry the character does not have\. /, new RegExp(`^Cannot duplicate an existing (${cardLists}) entry\\.$`), new RegExp(`^The (${cardLists}) list is full\\.$`),
  /^.+ is already down\.$/, /^.+ has died\.$/, /^.+ is not down, so there is nobody to rescue\.$/, /^.+ has already died\.$/,
];

export function isCardMismatch(message: string): boolean {
  return mismatches.some(pattern => pattern.test(message));
}

export function applyEffects(state: SessionState, effects: Effect[], sourceEventId = 'pending'): SessionState {
  const next = structuredClone(state);
  const trackDeltas = new Map<string, number>();
  const strainDeltas = new Map<string, number>();
  const listOperations = new Set<string>();
  const lookChanges = new Set<string>();
  const conditionEffects: Effect[] = [];
  for (const effect of uniqueEffects(effects)) {
    if (effect.kind === 'npc_death') {
      if (!(next.npcs ?? []).some(npc => npc.id === effect.npcId)) throw new Error('Unknown non-player character in effect.');
      conditionEffects.push(effect);
    } else if (effect.kind === 'track_delta') {
      if (!next.tracks.some(track => track.id === effect.trackId)) throw new Error('Unknown track in effect.');
      trackDeltas.set(effect.trackId, (trackDeltas.get(effect.trackId) ?? 0) + effect.delta);
    } else if (effect.kind === 'fact_add') {
      const existing = next.facts.find(fact => fact.id === effect.factId);
      if (existing && (existing.text !== effect.text || existing.visibility !== effect.visibility)) throw new Error('Conflicting fact updates require a ruling.');
      if (!existing) next.facts.push({ id: effect.factId, text: effect.text, visibility: effect.visibility, sourceEventId });
    } else {
      const character = next.characters.find(character => character.id === effect.characterId);
      if (!character) throw new Error('Unknown character in effect.');
      if (effect.kind === 'strain_delta') {
        strainDeltas.set(effect.characterId, (strainDeltas.get(effect.characterId) ?? 0) + effect.delta);
      } else if (effect.kind === 'character_down' || effect.kind === 'character_rescue') {
        conditionEffects.push(effect);
      } else if (effect.kind === 'looks_set') {
        if (lookChanges.has(effect.characterId)) throw new Error(LOOK_CONFLICT);
        lookChanges.add(effect.characterId);
        if (effect.text.trim()) character.looksChanged = effect.text;
        else delete character.looksChanged;
      } else {
        const change = cardListChange(effect)!;
        if (change.list === 'possessions') applyListChange(character.possessions, change, listOperations);
        else {
          const entries = [...(character[change.list] ?? [])];
          applyListChange(entries, change, listOperations);
          if (entries.length) character[change.list] = entries;
          else delete character[change.list];
        }
      }
    }
  }
  next.tracks = next.tracks.map(track => ({ ...track, current: Math.max(0, Math.min(track.max, track.current + (trackDeltas.get(track.id) ?? 0))) }));
  // Strain lands first, judged on the strain and condition from before the group: a hit on someone up and already full puts them down.
  next.characters = next.characters.map(character => {
    const step = strainStep(character.strain, character.condition, strainDeltas.get(character.id) ?? 0);
    return step.down ? { ...character, strain: step.strain, condition: 'down' } : { ...character, strain: step.strain };
  });
  for (const effect of conditionEffects) {
    if (effect.kind === 'npc_death') {
      const npc = next.npcs.find(npc => npc.id === effect.npcId)!;
      if (npc.condition !== 'dead') Object.assign(npc, { condition: 'dead', status: 'offstage', version: npc.version + 1 });
    } else if (effect.kind === 'character_down' || effect.kind === 'character_rescue') {
      const character = next.characters.find(character => character.id === effect.characterId)!;
      if (effect.kind === 'character_down' && character.condition === undefined) character.condition = 'down';
      else if (effect.kind === 'character_rescue' && character.condition === 'down') {
        delete character.condition;
        character.strain = RESCUE_STRAIN;
      }
    }
  }
  return next;
}

// Six seats with two lines each.
export const MAX_ROLLS_PER_ROUND = 12;

export function tooManyRollsMessage(count: number): string {
  return `A round can show at most ${MAX_ROLLS_PER_ROUND} rolls, and this plan needs ${count}. Untick some lines and plan again, then plan the rest in the next round.`;
}

export interface ContractLine { id: string; characterId: string; kind?: 'say' | 'act' | 'ooc' }

export function validateContracts(contracts: ActionContract[], state: SessionState, lines?: readonly ContractLine[]): void {
  // Every downed character rolls a last chance when the round's dice are rolled, so those rolls count toward the cap too.
  const rolls = contracts.length + state.characters.filter(character => character.condition === 'down').length;
  if (rolls > MAX_ROLLS_PER_ROUND) throw new Error(tooManyRollsMessage(rolls));
  const ordered = orderedContracts(contracts.map(contract => ActionContractSchema.parse(contract)));
  const allowed = new Map<string, number>();
  for (const line of lines ?? []) allowed.set(line.characterId, (allowed.get(line.characterId) ?? 0) + 1);
  const used = new Map<string, number>();
  const helped = new Map<string, number>();
  const nameOf = (characterId: string) => state.characters.find(character => character.id === characterId)?.displayName ?? characterId;
  const spend = (characterId: string) => {
    const count = (used.get(characterId) ?? 0) + 1;
    used.set(characterId, count);
    if (count > (lines ? allowed.get(characterId) ?? 0 : 1)) throw new Error(`${nameOf(characterId)} has more actions than lines this round. Each line can be one action.`);
  };
  for (const contract of ordered) {
    const actor = state.characters.find(character => character.id === contract.actorCharacterId);
    if (!actor) throw new Error('Unknown action actor.');
    if (!validateTraits(actor.traits)) throw new Error('Invalid character traits.');
    checkConditions(contract, state, lines);
    if (actor.strain >= STRAIN_MAX && contract.ruling === 'check') {
      const own = lines ? lines.filter(line => contract.submissionIds.includes(line.id) && line.characterId === contract.actorCharacterId) : [];
      if (!own.length || own.some(line => line.kind !== 'say')) throw new Error(`${nameOf(contract.actorCharacterId)} is at full strain (${STRAIN_MAX} of ${STRAIN_MAX}), so only something they say can roll. Choose No check or Blocked, or make the line help another character.`);
    }
    if (contract.edge && !contract.edgeReason?.trim()) throw new Error('Edge requires an established reason.');
    if (contract.helperCharacterIds.length && contract.edge !== 1) throw new Error('Meaningful helpers grant one Edge.');
    spend(contract.actorCharacterId);
    for (const characterId of contract.helperCharacterIds) {
      if (!state.characters.some(character => character.id === characterId)) throw new Error('Unknown action helper.');
      if (characterId === contract.actorCharacterId) throw new Error(`${nameOf(characterId)} cannot help their own action.`);
      const helps = (helped.get(characterId) ?? 0) + 1;
      helped.set(characterId, helps);
      if (helps > 1) throw new Error(`${nameOf(characterId)} can help only one action in a round.`);
      spend(characterId);
    }
  }
  const ancestors = new Map<string, Set<string>>();
  const depths = new Map<string, number>();
  const claims = new Map<string, Set<string>>();
  for (const contract of ordered) {
    const inherited = new Set<string>();
    for (const prerequisite of contract.prerequisites) {
      inherited.add(prerequisite.contractId);
      for (const ancestor of ancestors.get(prerequisite.contractId)!) inherited.add(ancestor);
    }
    ancestors.set(contract.id, inherited);
    depths.set(contract.id, contract.prerequisites.length ? 1 + Math.max(...contract.prerequisites.map(prerequisite => depths.get(prerequisite.contractId)!)) : 0);
    for (const band of applicableBands(contract)) for (const effect of contract.outcomes[band]!.effects) {
      const change = cardListChange(effect);
      const key = effect.kind === 'fact_add' ? `fact:${effect.factId}`
        : effect.kind === 'looks_set' ? `looks:${effect.characterId}`
        : !change ? null
        : change.list === 'possessions' ? `item:${change.characterId}:${change.entry}` : `card:${change.characterId}:${change.list}:${change.entry}`;
      if (!key) continue;
      const owners = claims.get(key) ?? new Set<string>();
      for (const owner of owners) {
        if (owner !== contract.id && !inherited.has(owner)) throw new Error('Conflicting nonnumeric changes require a ruling before lock.');
      }
      owners.add(contract.id);
      claims.set(key, owners);
    }
  }
  validatePossibleEffects(ordered, depths, state);
}

function checkConditions(contract: ActionContract, state: SessionState, lines?: readonly ContractLine[]): void {
  const characterById = (characterId: string) => state.characters.find(character => character.id === characterId);
  const actor = characterById(contract.actorCharacterId)!;
  if (actor.condition === 'dead') throw new Error(`${actor.displayName} has died, so they cannot act.`);
  if (actor.condition === 'down' && lines && contract.ruling !== 'blocked'
    && lines.some(line => contract.submissionIds.includes(line.id) && line.characterId === actor.id && line.kind !== 'say')) {
    throw new Error(`${actor.displayName} is down, so only a few spoken words from them can roll. Mark their Do line Blocked.`);
  }
  for (const helperId of contract.helperCharacterIds) {
    const helper = characterById(helperId);
    if (helper?.condition === 'dead') throw new Error(`${helper.displayName} has died, so they cannot act.`);
    if (helper?.condition === 'down') throw new Error(`${helper.displayName} is down, so they cannot help another action.`);
  }
  for (const band of applicableBands(contract)) for (const effect of contract.outcomes[band]!.effects) {
    if (effect.kind === 'character_down') {
      if (band !== 'setback' && band !== 'critical') throw new Error('Going down can only come from a setback or a critical failure.');
      const target = characterById(effect.characterId);
      if (target?.condition === 'down') throw new Error(`${target.displayName} is already down.`);
      if (target?.condition === 'dead') throw new Error(`${target.displayName} has died.`);
    } else if (effect.kind === 'character_rescue') {
      if (band !== 'clean' && band !== 'costly') throw new Error('A rescue can only come from a clean success or a success with a cost.');
      if (effect.characterId === actor.id) throw new Error(`${actor.displayName} cannot rescue themselves. Another character's line has to do it.`);
      if (actor.condition === 'down') throw new Error(`${actor.displayName} is down, so they cannot rescue anyone.`);
      const target = characterById(effect.characterId);
      if (target?.condition === 'dead') throw new Error(`${target.displayName} has died.`);
      if (target && target.condition !== 'down') throw new Error(`${target.displayName} is not down, so there is nobody to rescue.`);
    } else if (effect.kind === 'npc_death') {
      const npc = (state.npcs ?? []).find(npc => npc.id === effect.npcId);
      if (!npc) throw new Error('Unknown non-player character in effect.');
      if (npc.condition === 'dead') throw new Error(`${npc.displayName} has already died.`);
    }
  }
}

function applicableBands(contract: ActionContract): OutcomeBand[] {
  return contract.ruling === 'blocked' ? [] : contract.ruling === 'no_check' ? ['clean'] : contract.outcomes.critical ? ['clean', 'costly', 'setback', 'critical'] : ['clean', 'costly', 'setback'];
}

// Mirrors applyResolution (global shared-incident check, then each group through applyEffects)
// without cloning the state: only track ids, facts, card lists, look changes and missing condition targets can make a branch fail.
function possibleEffectsChecker(state: SessionState): (effectGroups: Effect[][]) => void {
  const trackIds = new Set(state.tracks.map(track => track.id));
  const npcIds = new Set((state.npcs ?? []).map(npc => npc.id));
  const baseFacts = new Map<string, { text: string; visibility: string }>();
  for (const fact of state.facts) if (!baseFacts.has(fact.id)) baseFacts.set(fact.id, fact);
  const baseCharacters = new Map<string, Character>();
  for (const character of state.characters) if (!baseCharacters.has(character.id)) baseCharacters.set(character.id, character);
  const signatures = new WeakMap<Effect, string>();
  const signature = (effect: Effect) => {
    let value = signatures.get(effect);
    if (value === undefined) signatures.set(effect, value = JSON.stringify(effect));
    return value;
  };
  return effectGroups => {
    const incidents = new Map<string, string>();
    for (const group of effectGroups) for (const effect of group) {
      if (!effect.incidentId) continue;
      const key = incidentKey(effect);
      const previous = incidents.get(key);
      if (previous === undefined) incidents.set(key, signature(effect));
      else if (previous !== signature(effect)) throw new Error('Conflicting shared incident effects.');
    }
    const seen = new Set<string>();
    const addedFacts = new Map<string, { text: string; visibility: string }>();
    const lists = new Map<string, string[]>();
    for (const group of effectGroups) {
      const listOperations = new Set<string>();
      const lookChanges = new Set<string>();
      for (const effect of group) {
        if (effect.incidentId) {
          const key = incidentKey(effect);
          if (seen.has(key)) continue;
          seen.add(key);
        }
        if (effect.kind === 'track_delta') {
          if (!trackIds.has(effect.trackId)) throw new Error('Unknown track in effect.');
        } else if (effect.kind === 'npc_death') {
          if (!npcIds.has(effect.npcId)) throw new Error('Unknown non-player character in effect.');
        } else if (effect.kind === 'fact_add') {
          const existing = baseFacts.get(effect.factId) ?? addedFacts.get(effect.factId);
          if (existing && (existing.text !== effect.text || existing.visibility !== effect.visibility)) throw new Error('Conflicting fact updates require a ruling.');
          if (!existing) addedFacts.set(effect.factId, { text: effect.text, visibility: effect.visibility });
        } else {
          const base = baseCharacters.get(effect.characterId);
          if (!base) throw new Error('Unknown character in effect.');
          if (effect.kind === 'strain_delta' || effect.kind === 'character_down' || effect.kind === 'character_rescue') continue;
          if (effect.kind === 'looks_set') {
            if (lookChanges.has(effect.characterId)) throw new Error(LOOK_CONFLICT);
            lookChanges.add(effect.characterId);
            continue;
          }
          const change = cardListChange(effect)!;
          const key = JSON.stringify([change.characterId, change.list]);
          let entries = lists.get(key);
          if (!entries) lists.set(key, entries = [...(change.list === 'possessions' ? base.possessions : base[change.list] ?? [])]);
          applyListChange(entries, change, listOperations);
        }
      }
    }
  };
}

function validatePossibleEffects(contracts: ActionContract[], depths: Map<string, number>, state: SessionState): void {
  for (const contract of contracts) for (const band of applicableBands(contract)) for (const effect of contract.outcomes[band]!.effects) EffectSchema.parse(effect);
  const check = possibleEffectsChecker(state);
  const goals = new Map<string, boolean>();
  const groups: Effect[][] = [];
  const visit = (index: number) => {
    if (index === contracts.length) {
      check(groups.filter(group => group?.length));
      return;
    }
    const contract = contracts[index];
    if (contract.ruling === 'blocked' || contract.prerequisites.some(prerequisite => !goals.get(prerequisite.contractId))) {
      goals.set(contract.id, false);
      visit(index + 1);
    } else {
      const depth = depths.get(contract.id)!;
      const previous = groups[depth] ?? [];
      for (const band of applicableBands(contract)) {
        goals.set(contract.id, band === 'clean' || band === 'costly');
        groups[depth] = [...previous, ...contract.outcomes[band]!.effects];
        visit(index + 1);
      }
      groups[depth] = previous;
    }
    goals.delete(contract.id);
  };
  visit(0);
}

export function resolveContracts(contracts: ActionContract[], state: SessionState, rollDie: () => number, lines?: readonly ContractLine[]): Resolution {
  validateContracts(contracts, state, lines);
  const result: Resolution = { rolls: [], effects: [], outcomes: [], effectGroups: [] };
  const depths = new Map<string, number>();
  for (const contract of orderedContracts(contracts)) {
    const depth = contract.prerequisites.length ? 1 + Math.max(...contract.prerequisites.map(prerequisite => depths.get(prerequisite.contractId)!)) : 0;
    depths.set(contract.id, depth);
    const base = { contractId: contract.id, actorCharacterId: contract.actorCharacterId };
    if (contract.prerequisites.some(prerequisite => !result.outcomes.find(outcome => outcome.contractId === prerequisite.contractId)?.goalAchieved)) {
      result.outcomes.push({ ...base, status: 'held', band: null, goalAchieved: false, publicText: 'Holding position: the required opportunity did not arise.' });
      continue;
    }
    if (contract.ruling === 'blocked') {
      result.outcomes.push({ ...base, status: 'blocked', band: null, goalAchieved: false, publicText: contract.outcomes.setback.publicText });
      continue;
    }
    let band: OutcomeBand = 'clean';
    if (contract.ruling === 'check') {
      const faces: [number, number] = [rollDie(), rollDie()];
      if (faces.some(face => !Number.isInteger(face) || face < 1 || face > 6)) throw new Error('Dice must return integer faces between one and six.');
      const actor = state.characters.find(character => character.id === contract.actorCharacterId)!;
      const traitModifier = actor.traits[contract.trait];
      const total = faces[0] + faces[1] + traitModifier + contract.edge;
      band = faces[0] === 1 && faces[1] === 1 && contract.outcomes.critical ? 'critical' : outcomeForTotal(total);
      result.rolls.push({ ...base, id: `${contract.id}:v${contract.version}`, contractVersion: contract.version, faces, trait: contract.trait, traitModifier, edge: contract.edge, total, band });
    }
    const branch = contract.outcomes[band]!;
    result.effects.push(...structuredClone(branch.effects));
    (result.effectGroups![depth] ??= []).push(...structuredClone(branch.effects));
    result.outcomes.push({ ...base, status: 'resolved', band, goalAchieved: band === 'clean' || band === 'costly', publicText: branch.publicText });
  }
  result.effects = uniqueEffects(result.effects);
  result.effectGroups = result.effectGroups!.filter(Boolean);
  for (const character of state.characters) {
    if (character.condition !== 'down') continue;
    if (result.effects.some(effect => effect.kind === 'character_rescue' && effect.characterId === character.id)) continue;
    const faces: [number, number] = [rollDie(), rollDie()];
    if (faces.some(face => !Number.isInteger(face) || face < 1 || face > 6)) throw new Error('Dice must return integer faces between one and six.');
    const total = faces[0] + faces[1];
    const band: OutcomeBand = faces[0] === 1 && faces[1] === 1 ? 'critical' : outcomeForTotal(total);
    const base = { contractId: `last-chance:${character.id}`, actorCharacterId: character.id };
    const survives = band === 'clean' || band === 'costly';
    result.rolls.push({ ...base, id: base.contractId, contractVersion: 1, faces, trait: 'force', traitModifier: 0, edge: 0, total, band, lastChance: true });
    result.outcomes.push({ ...base, status: 'resolved', band, goalAchieved: survives,
      publicText: `${character.displayName}'s last chance: ${character.displayName} ${survives ? `pulls through at ${LAST_CHANCE_STRAIN} of 8.` : 'dies.'}` });
  }
  applyResolution(state, result);
  return result;
}

export function applyResolution(state: SessionState, resolution: Resolution, sourceEventId = 'pending'): SessionState {
  return applyLastChances(applyEffectGroups(state, resolution, sourceEventId), resolution.rolls);
}

function applyEffectGroups(state: SessionState, resolution: Resolution, sourceEventId: string): SessionState {
  if (!resolution.effectGroups) return applyEffects(state, resolution.effects, sourceEventId);
  uniqueEffects(resolution.effects);
  const seen = new Set<string>();
  return resolution.effectGroups.reduce((current, group) => applyEffects(current, group.filter(effect => {
    if (!effect.incidentId) return true;
    const key = incidentKey(effect);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }), sourceEventId), state);
}

// Last chances land after every effect group, and only on characters who are still down by then.
function applyLastChances(state: SessionState, rolls: readonly Roll[]): SessionState {
  const lastChances = rolls.filter(roll => roll.lastChance);
  if (!lastChances.length) return state;
  const next = structuredClone(state);
  for (const roll of lastChances) {
    const character = next.characters.find(character => character.id === roll.actorCharacterId);
    if (character?.condition !== 'down') continue;
    if (roll.band === 'clean' || roll.band === 'costly') {
      delete character.condition;
      character.strain = LAST_CHANCE_STRAIN;
    } else character.condition = 'dead';
  }
  return next;
}
