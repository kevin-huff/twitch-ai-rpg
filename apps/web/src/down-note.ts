import { DOWNED_SAY_WORDS } from '@rpg/contracts';

type NoteBeat = { phase: string; lastChanceFor?: string[] | undefined } | null | undefined;

export function downNote({ name, characterId, beat }: { name: string; characterId: string; beat: NoteBeat }): string {
  const base = `${name} is down. You can say a few words, up to ${DOWNED_SAY_WORDS}.`;
  const ladder = `7 or more on two dice and ${name} pulls through; 6 or less, or double 1s, and ${name} dies.`;
  const phase = beat?.phase;
  if (phase === 'collecting' || phase === 'stakes_review') return `${base} Someone can still save ${name} in this round. If nobody does, one last-chance roll decides when the dice are rolled: ${ladder}`;
  if (phase === 'locked' || phase === 'draft_review') {
    // After the dice the note gives nothing away: a rescue and a last chance read the same until the story is published.
    if (beat?.lastChanceFor?.includes(characterId)) return `${base} The dice are rolled. The story will tell what happens to ${name}.`;
    if (beat?.lastChanceFor) return `${base} This part of the story has no dice, so someone can still save ${name} in the next round. If nobody does, one last-chance roll decides: ${ladder}`;
    return `${base} The next part of the story is being written.`;
  }
  return `${base} Someone can still save ${name} in the next round. If nobody does, one last-chance roll decides: ${ladder}`;
}
