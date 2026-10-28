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

const PAUSED_REASON = 'The show is paused.';

function decide(input: BeatStepInput): BeatStepResult {
  const { beat } = input;
  if (!beat || beat.phase === 'published' || beat.phase === 'aborted') {
    return input.selectedCount > 0
      ? { step: 'open', next: 'Answer the ticked lines, or open an action round for something risky.', reason: null }
      : { step: 'open', next: 'Waiting for lines from the cast.', reason: null };
  }
  if (beat.phase === 'collecting') {
    if (beat.lastError && beat.selectedSubmissionIds.length > 0) {
      return { step: 'stakes', next: "Planning failed. Set what's at risk by hand, or plan again.", reason: null };
    }
    if (input.selectedCount === 0) {
      return { step: 'select', next: 'Tick the lines this beat should answer.', reason: 'Select at least one line to plan.' };
    }
    return {
      step: 'plan',
      next: beat.kind === 'action' ? "Plan the ticked actions to see what's at risk." : "Plan the ticked lines to see what's at risk.",
      reason: null,
    };
  }
  if (beat.phase === 'stakes_review') {
    if (input.contractsDirty && beat.stakesApproved) {
      return { step: 'stakes', next: "Read what's at risk, then approve and roll.", reason: 'Stakes changed since approval. Approve them again.' };
    }
    if (!beat.stakesApproved) {
      return { step: 'stakes', next: "Read what's at risk, then approve and roll.", reason: null };
    }
    return { step: 'lock', next: 'Approve and roll to lock the lines. The dice roll once and never change.', reason: null };
  }
  const hasDraft = Boolean(beat.draft);
  if ((beat.phase === 'locked' || beat.phase === 'draft_review') && !hasDraft) {
    return {
      step: 'draft',
      next: beat.lastError ? 'The script could not be written. Try again, or write it yourself.' : beat.selectedSubmissionIds.length ? 'Draft the scene from the locked lines.' : 'Draft the narration that sets the scene.',
      reason: input.rendering ? 'The script is being drafted.' : null,
    };
  }
  if (input.scriptDirty) {
    return { step: 'review', next: 'Save your edits under More before publishing.', reason: null };
  }
  return { step: 'publish', next: 'Read the script, then publish.', reason: null };
}

export function beatStep(input: BeatStepInput): BeatStepResult {
  let result = decide(input);
  if (input.quickLock && (result.step === 'stakes' || result.step === 'lock')) result = { ...result, next: 'Ordinary conversation. Lock and draft writes the script.' };
  return input.paused ? { ...result, reason: PAUSED_REASON } : result;
}

export type StageId = 'lines' | 'plan' | 'stakes' | 'script' | 'publish';

export function usesActionSteps(beat: Beat | null, reviewClassification?: 'ordinary' | 'action'): boolean {
  if (beat?.kind === 'action' || beat?.classification === 'needs_action') return true;
  return (reviewClassification ?? beat?.classification) !== 'ordinary';
}

export function stepPosition(step: StepId, action: boolean): { stage: StageId; n: number; m: number } {
  const stages: StageId[] = action ? ['lines', 'plan', 'stakes', 'script', 'publish'] : ['lines', 'script', 'publish'];
  let stage: StageId;
  if (step === 'open' || step === 'select') stage = 'lines';
  else if (step === 'plan') stage = action ? 'plan' : 'lines';
  else if (step === 'stakes' || step === 'lock') stage = action ? 'stakes' : 'lines';
  else if (step === 'draft' || step === 'review') stage = 'script';
  else stage = 'publish';
  return { stage, n: stages.indexOf(stage) + 1, m: stages.length };
}

export type GoldAction = 'answer' | 'plan' | 'lock-and-draft' | 'approve-and-roll' | 'draft' | 'try-again' | 'publish' | 'resume';

export function goldAction(input: { step: StepId; beat: Beat | null; paused: boolean; ordinary: boolean }): GoldAction {
  if (input.paused) return 'resume';
  switch (input.step) {
    case 'open': return 'answer';
    case 'select':
    case 'plan': return 'plan';
    case 'stakes':
    case 'lock': return input.ordinary ? 'lock-and-draft' : 'approve-and-roll';
    case 'draft': return input.beat?.lastError ? 'try-again' : 'draft';
    default: return 'publish';
  }
}

export const GOLD_LABELS: Record<GoldAction, string> = {
  answer: 'Answer these lines',
  plan: 'Plan',
  'lock-and-draft': 'Lock and draft',
  'approve-and-roll': 'Approve and roll',
  draft: 'Draft the scene',
  'try-again': 'Try again',
  publish: 'Publish',
  resume: 'Resume show',
};

export const GOLD_TEST_IDS: Record<GoldAction, string> = {
  answer: 'answer-lines',
  plan: 'plan',
  'lock-and-draft': 'lock-and-draft',
  'approve-and-roll': 'approve-and-roll',
  draft: 'render',
  'try-again': 'render',
  publish: 'publish',
  resume: 'resume-show',
};
