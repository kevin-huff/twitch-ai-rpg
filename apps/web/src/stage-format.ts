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
  const name: string = band;
  return name === 'clean' ? 'Clean success' : name === 'costly' ? 'Success with a cost' : name === 'critical' ? 'Critical failure' : 'Setback';
}

export function bandSymbol(band: OutcomeBand): string {
  const name: string = band;
  return name === 'clean' ? '+' : name === 'costly' ? '~' : name === 'critical' ? '!' : 'x';
}

export function traitName(trait: Trait): string {
  return trait.charAt(0).toUpperCase() + trait.slice(1);
}

export function rollBreakdown(roll: Pick<Roll, 'faces' | 'trait' | 'traitModifier' | 'edge'>): string {
  const parts = [...roll.faces.map(String), `${traitName(roll.trait)} ${roll.traitModifier}`];
  if (roll.edge === 1) parts.push('Edge 1');
  return parts.join(' + ');
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
  const critical = (stake.outcomes as { critical?: string }).critical;
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
