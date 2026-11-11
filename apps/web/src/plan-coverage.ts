import { conditionLineRefusal, countWords, DOWNED_SAY_WORDS, playerWords, type DirectorSnapshot, type Submission } from '@rpg/contracts';

// A ticked line only matters to the plan while a plan is being made or reviewed, so the tag is limited to those moments.
export function ticksOutsidePlan(snapshot: DirectorSnapshot, selected: string[]): string[] {
  const beat = snapshot.activeBeat;
  if (!beat) return [];
  const planning = beat.phase === 'stakes_review'
    || (snapshot.jobs ?? []).some(job => job.beatId === beat.id && job.generation === beat.generation && job.task === 'plan' && ['queued', 'running'].includes(job.status));
  if (!planning) return [];
  const planned = new Set(beat.selectedSubmissionIds);
  const pending = new Set(snapshot.submissions.filter(item => ['queued', 'selected'].includes(item.status) && item.kind !== 'ooc').map(item => item.id));
  return selected.filter(id => pending.has(id) && !planned.has(id));
}

// Why a waiting line cannot be planned, or null. The same helper the server uses decides down and dead.
export function lineBlock(snapshot: DirectorSnapshot, item: Submission): string | null {
  if (item.kind === 'ooc') return null;
  const characters = snapshot.characterDetails ?? snapshot.characters;
  const speaker = characters.find(character => character.id === item.characterId);
  if (speaker) {
    const words = countWords(playerWords(item));
    const refusal = conditionLineRefusal(speaker, item.kind, words);
    if (refusal) {
      if (speaker.condition === 'dead') return `${speaker.displayName} has died, so this line can't be used.`;
      if (item.kind === 'act') return `${speaker.displayName} is down, so this Do line can't be used.`;
      return `${speaker.displayName} is down, so this Say line can't be used: it has ${words} words and the limit is ${DOWNED_SAY_WORDS}.`;
    }
  }
  for (const id of item.recipientNpcIds ?? []) {
    const npc = (snapshot.npcDetails ?? []).find(candidate => candidate.id === id);
    if (npc?.condition === 'dead') return `This line speaks to ${npc.displayName}, who has died, so it can't be used.`;
  }
  return null;
}
