import type { Beat } from '@rpg/contracts';

export type StepId = 'open' | 'select' | 'plan' | 'stakes' | 'lock' | 'draft' | 'review' | 'publish';

export type BeatStepInput = {
  beat: Beat | null;
  selectedCount: number;
  contractsDirty: boolean;
  scriptDirty: boolean;
  rendering: boolean;
  paused: boolean;
  continuityPending: number;
  quickLock?: boolean;
};

export type BeatStepResult = { step: StepId; next: string; reason: string | null };

export const STEP_ORDER: readonly StepId[] = ['open', 'select', 'plan', 'stakes', 'lock', 'draft', 'review', 'publish'];

export const STEP_LABELS: Record<StepId, string> = {
  open: 'Open', select: 'Select lines', plan: 'Plan', stakes: 'Stakes', lock: 'Lock', draft: 'Draft', review: 'Review', publish: 'Publish',
};

const QUICK_LOCK_NEXT = 'Ordinary conversation. Choose Lock and draft to lock the lines and write the scene.';
const PAUSED_REASON = 'The table is paused. Resume to continue.';

function decide(input: BeatStepInput): BeatStepResult {
  const { beat } = input;
  if (!beat || beat.phase === 'published' || beat.phase === 'aborted') {
    return { step: 'open', next: 'Open a conversation, or an action round when the party tries something risky.', reason: null };
  }
  if (beat.phase === 'collecting') {
    if (beat.lastError && beat.selectedSubmissionIds.length > 0) {
      return { step: 'stakes', next: 'Planning failed. Review the stakes by hand or abandon the beat.', reason: null };
    }
    if (input.selectedCount === 0) {
      return { step: 'select', next: 'Tick the lines from the queue that belong in this beat.', reason: 'Select at least one line to plan.' };
    }
    return { step: 'plan', next: 'Plan the selected lines so the AI can suggest the stakes.', reason: null };
  }
  if (beat.phase === 'stakes_review') {
    if (input.contractsDirty) {
      return { step: 'stakes', next: 'Review the stakes, then approve them.', reason: 'Stakes changed since approval. Approve them again.' };
    }
    if (!beat.stakesApproved) {
      return { step: 'stakes', next: 'Review the stakes, then approve them.', reason: null };
    }
    return { step: 'lock', next: 'Lock the input. The dice roll once and stay fixed.', reason: null };
  }
  const hasDraft = Boolean(beat.draft);
  if (beat.phase === 'locked' && !hasDraft) {
    return { step: 'draft', next: 'Draft the scene from the locked input.', reason: input.rendering ? 'The script is being drafted.' : null };
  }
  if (beat.phase === 'draft_review' && !hasDraft) {
    return { step: 'draft', next: 'Draft the scene from the locked input.', reason: input.rendering ? 'The script is being drafted.' : null };
  }
  if (input.scriptDirty) {
    return { step: 'review', next: 'Review the script and fix anything you want changed.', reason: 'Save script edits before publishing.' };
  }
  if (input.continuityPending > 0) {
    return { step: 'review', next: 'Approve the continuity updates, then publish.', reason: null };
  }
  return { step: 'publish', next: 'Publish the beat when the script reads right.', reason: null };
}

export function beatStep(input: BeatStepInput): BeatStepResult {
  let result = decide(input);
  if (input.quickLock && result.step === 'stakes') result = { ...result, next: QUICK_LOCK_NEXT };
  return input.paused ? { ...result, reason: PAUSED_REASON } : result;
}
