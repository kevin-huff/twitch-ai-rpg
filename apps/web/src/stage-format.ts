import type { OutcomeBand, PublicActionContract, PublicCharacter, Roll, ScriptSegment, SessionSnapshot, Trait } from '@rpg/contracts';

export const AI_BADGE = 'AI-generated narration and character voices';

export type SlateKind = 'lobby' | 'paused' | 'ended' | 'waiting';

export function initials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(word => Array.from(word)[0]!.toUpperCase()).join('');
}

export function speakerName(segment: Pick<ScriptSegment, 'kind' | 'speaker'>): string {
  if (segment.speaker) return segment.speaker.displayName;
  return segment.kind === 'system' ? 'The show' : 'Narrator';
}

export function speakerRole(segment: Pick<ScriptSegment, 'kind'>): 'Narrator' | 'Character' | 'Player' | 'Action' {
  if (segment.kind === 'npc_dialogue') return 'Character';
  if (segment.kind === 'player_action') return 'Action';
  if (segment.kind === 'player_dialogue') return 'Player';
  return 'Narrator';
}

export function bandLabel(band: OutcomeBand): string {
  return band === 'clean' ? 'Clean success' : band === 'costly' ? 'Success with a cost' : band === 'critical' ? 'Critical failure' : 'Setback';
}

export function bandSymbol(band: OutcomeBand): string {
  return band === 'clean' ? '+' : band === 'costly' ? '~' : band === 'critical' ? '!' : 'x';
}

export function traitName(trait: Trait): string {
  return trait.charAt(0).toUpperCase() + trait.slice(1);
}

export function rollBreakdown(roll: Pick<Roll, 'faces' | 'trait' | 'traitModifier' | 'edge' | 'lastChance'>): string {
  if (roll.lastChance) return roll.faces.join(' + ');
  const parts = [...roll.faces.map(String), `${traitName(roll.trait)} ${roll.traitModifier}`];
  if (roll.edge === 1) parts.push('Edge 1');
  return parts.join(' + ');
}

export function rollSentence(roll: Pick<Roll, 'total' | 'band' | 'lastChance'>, name: string): string {
  if (roll.lastChance) return `${name}'s last chance rolled ${roll.total}: ${lastChanceResult(roll.band).toLowerCase()}`;
  return `${name} rolled ${roll.total}: ${bandLabel(roll.band)}`;
}

export function lastChanceResult(band: OutcomeBand): 'Pulls through' | 'Dies' {
  return band === 'clean' || band === 'costly' ? 'Pulls through' : 'Dies';
}

// Mirrors the rules: no check takes the clean result; a blocked action publishes its setback text.
export function wagerOutcomes(stake: Pick<PublicActionContract, 'ruling' | 'outcomes'>): Array<{ label: string; text: string }> {
  if (stake.ruling === 'no_check') return [{ label: 'No roll needed', text: stake.outcomes.clean }];
  if (stake.ruling === 'blocked') return [{ label: 'Blocked', text: stake.outcomes.setback }];
  const rows = [
    { label: '10+ Clean success', text: stake.outcomes.clean },
    { label: '7-9 Success with a cost', text: stake.outcomes.costly },
    { label: '6 or less Setback', text: stake.outcomes.setback },
  ];
  const critical = stake.outcomes.critical;
  if (typeof critical === 'string' && critical.trim()) rows.push({ label: 'Double 1s Critical failure', text: critical });
  return rows;
}

export function helperCredit(stake: Pick<PublicActionContract, 'ruling' | 'edge'>, names: string[]): string {
  return `With ${names.join(', ')}${stake.ruling === 'check' && stake.edge === 1 ? ' (+1 Edge)' : ''}`;
}

export function sortRolls(rolls: Roll[], characters: Pick<PublicCharacter, 'id'>[]): Roll[] {
  const rank = (roll: Roll) => {
    const index = characters.findIndex(character => character.id === roll.actorCharacterId);
    return index === -1 ? characters.length : index;
  };
  return rolls.map((roll, index) => ({ roll, index }))
    .sort((a, b) => rank(a.roll) - rank(b.roll) || a.index - b.index)
    .map(entry => entry.roll);
}

export function slateKind(snapshot: Pick<SessionSnapshot, 'session' | 'history' | 'activeBeat' | 'role'>): SlateKind | null {
  const status = snapshot.session.status;
  if (status === 'lobby' || status === 'paused' || status === 'ended') return status;
  if (snapshot.history.length > 0) return null;
  const publicStakes = snapshot.role !== 'director' && ((snapshot.activeBeat as { stakes?: unknown[] } | null)?.stakes?.length ?? 0) > 0;
  return publicStakes ? null : 'waiting';
}

export function statusLabel(status: string, connected: boolean): string {
  if (!connected) return 'Reconnecting';
  if (status === 'lobby') return 'Starting soon';
  if (status === 'paused') return 'Paused';
  if (status === 'ended') return 'Ended';
  return 'Live';
}

export type StageChip = { label: string; warn: boolean; waiting: boolean };

type RoundFacts = { phase?: string; planning?: boolean; stakesApproved?: boolean; stakes?: unknown[]; lastChanceFor?: string[] };

export function stageChip(snapshot: Pick<SessionSnapshot, 'session' | 'activeBeat'>, connected: boolean): StageChip {
  const status = snapshot.session.status;
  if (!connected || status !== 'live') return { label: statusLabel(status, connected), warn: true, waiting: false };
  const beat = (snapshot.activeBeat ?? null) as RoundFacts | null;
  const live = (label: string): StageChip => ({ label, warn: false, waiting: label !== 'Live' && label !== 'Stakes are set' });
  if (!beat) return live('Live');
  if (beat.phase === 'collecting') return live(beat.planning ? 'Setting stakes' : 'Taking lines');
  if (beat.phase === 'stakes_review') return live(beat.planning || !beat.stakesApproved ? 'Setting stakes' : 'Stakes are set');
  if (beat.phase === 'locked') return live('Writing the story');
  if (beat.phase === 'draft_review') return live('Story coming up');
  return live('Live');
}

export type StageCard =
  | { kind: 'stake'; id: string; stake: PublicActionContract }
  | { kind: 'last-chance'; id: string; characterId: string; rolled: boolean };

export function stageCards(snapshot: Pick<SessionSnapshot, 'role' | 'characters' | 'activeBeat'>, characterId?: string | null): StageCard[] {
  if (snapshot.role === 'director') return [];
  const beat = (snapshot.activeBeat ?? null) as RoundFacts | null;
  if (!beat) return [];
  const known = (id: string) => snapshot.characters.some(character => character.id === id);
  if (characterId && !known(characterId)) return [];
  const rank = (id: string) => {
    const index = snapshot.characters.findIndex(character => character.id === id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const found = Array.isArray(beat.stakes) ? (beat.stakes as PublicActionContract[]) : [];
  const cards: StageCard[] = [...found]
    .sort((a, b) => rank(a.actorCharacterId) - rank(b.actorCharacterId))
    .filter(stake => !characterId || stake.actorCharacterId === characterId)
    .map(stake => ({ kind: 'stake', id: stake.id, stake }));
  if (beat.stakesApproved === true && Array.isArray(beat.lastChanceFor)) {
    const rolled = beat.phase === 'locked' || beat.phase === 'draft_review';
    const ids = snapshot.characters.map(character => character.id).filter(id => beat.lastChanceFor!.includes(id) && (!characterId || id === characterId));
    for (const id of ids) cards.push({ kind: 'last-chance', id: `last-chance:${id}`, characterId: id, rolled });
  }
  return cards;
}

export function lastChanceCardText(name: string, rolled: boolean): string {
  // After the dice the card gives nothing away: a rescue and a last chance read the same until the beat is published.
  if (rolled) return `${name} is down. The dice are rolled. The story will tell what happens.`;
  return `${name} is down. If nobody saves ${name} this round, one roll decides: 7 or more and ${name} pulls through; 6 or less, or double 1s, and ${name} dies.`;
}
