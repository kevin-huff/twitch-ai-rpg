import type { DirectorSnapshot } from '@rpg/contracts';

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
