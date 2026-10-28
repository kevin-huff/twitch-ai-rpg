import {
  ActionContractSchema, EffectSchema, TraitsSchema,
  type ActionContract, type Effect, type OutcomeBand, type Resolution, type SessionState,
} from '@rpg/contracts';

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
    const target = effect.kind === 'track_delta' ? effect.trackId : effect.kind === 'fact_add' ? effect.factId : effect.characterId;
    const key = `${effect.incidentId}:${effect.kind}:${target}`;
    const signature = JSON.stringify(effect);
    const previous = incidents.get(key);
    if (previous && previous !== signature) throw new Error('Conflicting shared incident effects.');
    if (previous) return false;
    incidents.set(key, signature);
    return true;
  });
}

export function applyEffects(state: SessionState, effects: Effect[], sourceEventId = 'pending'): SessionState {
  const next = structuredClone(state);
  const trackDeltas = new Map<string, number>();
  const strainDeltas = new Map<string, number>();
  const inventoryOperations = new Set<string>();
  for (const effect of uniqueEffects(effects)) {
    if (effect.kind === 'track_delta') {
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
      } else {
        const operation = `${effect.characterId}:${effect.item}`;
        if (inventoryOperations.has(operation)) throw new Error('Conflicting inventory changes require a ruling.');
        inventoryOperations.add(operation);
        if (effect.kind === 'inventory_remove') {
          const index = character.possessions.indexOf(effect.item);
          if (index < 0) throw new Error('Cannot consume an item the character does not possess.');
          character.possessions.splice(index, 1);
        } else {
          if (character.possessions.includes(effect.item)) throw new Error('Cannot duplicate an existing inventory item.');
          if (character.possessions.length >= 20) throw new Error('Inventory capacity exceeded.');
          character.possessions.push(effect.item);
        }
      }
    }
  }
  next.tracks = next.tracks.map(track => ({ ...track, current: Math.max(0, Math.min(track.max, track.current + (trackDeltas.get(track.id) ?? 0))) }));
  next.characters = next.characters.map(character => ({ ...character, strain: Math.max(0, Math.min(4, character.strain + (strainDeltas.get(character.id) ?? 0))) }));
  return next;
}

// Six seats with two lines each.
export const MAX_ROLLS_PER_ROUND = 12;

export function tooManyRollsMessage(count: number): string {
  return `A round can show at most ${MAX_ROLLS_PER_ROUND} rolls, and this plan needs ${count}. Untick some lines and plan again, then plan the rest in the next round.`;
}

export interface ContractLine { id: string; characterId: string; kind?: 'say' | 'act' | 'ooc' }

export function validateContracts(contracts: ActionContract[], state: SessionState, lines?: readonly ContractLine[]): void {
  if (contracts.length > MAX_ROLLS_PER_ROUND) throw new Error(tooManyRollsMessage(contracts.length));
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
    if (actor.strain >= 4 && contract.ruling === 'check') {
      const own = lines ? lines.filter(line => contract.submissionIds.includes(line.id) && line.characterId === contract.actorCharacterId) : [];
      if (!own.length || own.some(line => line.kind !== 'say')) throw new Error(`${nameOf(contract.actorCharacterId)} is at four strain, so only something they say can roll. Choose No check or Blocked, or make the line help another character.`);
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
      const key = effect.kind === 'fact_add' ? `fact:${effect.factId}`
        : effect.kind === 'inventory_add' || effect.kind === 'inventory_remove' ? `item:${effect.characterId}:${effect.item}` : null;
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

function applicableBands(contract: ActionContract): OutcomeBand[] {
  return contract.ruling === 'blocked' ? [] : contract.ruling === 'no_check' ? ['clean'] : contract.outcomes.critical ? ['clean', 'costly', 'setback', 'critical'] : ['clean', 'costly', 'setback'];
}

function incidentKey(effect: Effect): string {
  const target = effect.kind === 'track_delta' ? effect.trackId : effect.kind === 'fact_add' ? effect.factId : effect.characterId;
  return `${effect.incidentId}:${effect.kind}:${target}`;
}

// Mirrors applyResolution (global shared-incident check, then each group through applyEffects)
// without cloning the state: only track ids, facts and possessions can make a branch fail.
function possibleEffectsChecker(state: SessionState): (effectGroups: Effect[][]) => void {
  const trackIds = new Set(state.tracks.map(track => track.id));
  const baseFacts = new Map<string, { text: string; visibility: string }>();
  for (const fact of state.facts) if (!baseFacts.has(fact.id)) baseFacts.set(fact.id, fact);
  const basePossessions = new Map<string, readonly string[]>();
  for (const character of state.characters) if (!basePossessions.has(character.id)) basePossessions.set(character.id, character.possessions);
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
    const possessions = new Map<string, string[]>();
    for (const group of effectGroups) {
      const inventoryOperations = new Set<string>();
      for (const effect of group) {
        if (effect.incidentId) {
          const key = incidentKey(effect);
          if (seen.has(key)) continue;
          seen.add(key);
        }
        if (effect.kind === 'track_delta') {
          if (!trackIds.has(effect.trackId)) throw new Error('Unknown track in effect.');
        } else if (effect.kind === 'fact_add') {
          const existing = baseFacts.get(effect.factId) ?? addedFacts.get(effect.factId);
          if (existing && (existing.text !== effect.text || existing.visibility !== effect.visibility)) throw new Error('Conflicting fact updates require a ruling.');
          if (!existing) addedFacts.set(effect.factId, { text: effect.text, visibility: effect.visibility });
        } else {
          const base = basePossessions.get(effect.characterId);
          if (!base) throw new Error('Unknown character in effect.');
          if (effect.kind === 'strain_delta') continue;
          const operation = `${effect.characterId}:${effect.item}`;
          if (inventoryOperations.has(operation)) throw new Error('Conflicting inventory changes require a ruling.');
          inventoryOperations.add(operation);
          let items = possessions.get(effect.characterId);
          if (!items) possessions.set(effect.characterId, items = [...base]);
          if (effect.kind === 'inventory_remove') {
            const index = items.indexOf(effect.item);
            if (index < 0) throw new Error('Cannot consume an item the character does not possess.');
            items.splice(index, 1);
          } else {
            if (items.includes(effect.item)) throw new Error('Cannot duplicate an existing inventory item.');
            if (items.length >= 20) throw new Error('Inventory capacity exceeded.');
            items.push(effect.item);
          }
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
  applyResolution(state, result);
  return result;
}

export function applyResolution(state: SessionState, resolution: Resolution, sourceEventId = 'pending'): SessionState {
  if (!resolution.effectGroups) return applyEffects(state, resolution.effects, sourceEventId);
  uniqueEffects(resolution.effects);
  const seen = new Set<string>();
  return resolution.effectGroups.reduce((current, group) => applyEffects(current, group.filter(effect => {
    if (!effect.incidentId) return true;
    const target = effect.kind === 'track_delta' ? effect.trackId : effect.kind === 'fact_add' ? effect.factId : effect.characterId;
    const key = `${effect.incidentId}:${effect.kind}:${target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }), sourceEventId), state);
}
