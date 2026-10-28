// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { Beat } from '@rpg/contracts';
import { beatStep, goldAction, GOLD_LABELS, GOLD_TEST_IDS, stepPosition, STEP_ORDER, usesActionSteps, type BeatStepInput, type StepId } from './beat-step';
import BeatStepper from './BeatStepper.vue';

const beatOf = (patch: Partial<Beat>): Beat => ({
  id: 'b1', sessionId: 's1', kind: 'conversation', phase: 'collecting', revision: 1, inputEpoch: 1, sourceStateRevision: 1,
  selectedSubmissionIds: [], lockedSubmissions: [], contracts: [], stakesApproved: false, classification: null,
  inputSnapshotHash: null, resolution: null, draft: null, draftRevision: 0, approvedContinuity: [], generation: 0, lastError: null,
  ...patch,
});
const draft = { segments: [], continuity: [], directorSummary: '' } as unknown as Beat['draft'];
const run = (beat: Beat | null, patch: Partial<BeatStepInput> = {}) =>
  beatStep({ beat, selectedCount: 0, contractsDirty: false, scriptDirty: false, rendering: false, paused: false, continuityPending: 0, ...patch });

describe('beatStep', () => {
  it('opens when there is no beat, or it is published or aborted', () => {
    for (const beat of [null, beatOf({ phase: 'published' }), beatOf({ phase: 'aborted' })]) {
      expect(run(beat, { selectedCount: 2 })).toEqual({ step: 'open', next: 'Answer the ticked lines, or open an action round for something risky.', reason: null });
      expect(run(beat)).toEqual({ step: 'open', next: 'Waiting for lines from the cast.', reason: null });
    }
  });
  it('asks to tick lines, then plan', () => {
    expect(run(beatOf({}))).toMatchObject({ step: 'select', next: 'Tick the lines this beat should answer.' });
    expect(run(beatOf({}), { selectedCount: 2 })).toMatchObject({ step: 'plan', next: "Plan the ticked lines to see what's at risk.", reason: null });
    expect(run(beatOf({ kind: 'action' }), { selectedCount: 2 })).toMatchObject({ step: 'plan', next: "Plan the ticked actions to see what's at risk." });
  });
  it('checks the planning-failed case first', () => {
    expect(run(beatOf({ lastError: 'boom', selectedSubmissionIds: ['x'] })))
      .toMatchObject({ step: 'stakes', next: "Planning failed. Set what's at risk by hand, or plan again." });
    expect(run(beatOf({ lastError: 'boom' })).step).toBe('select');
  });
  it('gives the stakes-changed reason only after approved stakes were edited', () => {
    const unapproved = beatOf({ phase: 'stakes_review', classification: 'needs_action' });
    expect(run(unapproved, { contractsDirty: true }).reason).toBeNull();
    expect(run(beatOf({ phase: 'stakes_review', stakesApproved: true }), { contractsDirty: true }).reason).toBe('Stakes changed since approval. Approve them again.');
  });
  it('names Lock and draft at the lock step for ordinary stakes', () => {
    const approved = beatOf({ phase: 'stakes_review', stakesApproved: true });
    expect(run(approved, { quickLock: true })).toMatchObject({ step: 'lock', next: 'Ordinary conversation. Lock and draft writes the script.' });
  });
  it('handles stakes review and lock', () => {
    const stakes = beatOf({ phase: 'stakes_review' });
    expect(run(stakes)).toMatchObject({ step: 'stakes', next: "Read what's at risk, then approve and roll." });
    expect(run(stakes, { quickLock: true })).toMatchObject({ step: 'stakes', next: 'Ordinary conversation. Lock and draft writes the script.' });
    const approved = beatOf({ phase: 'stakes_review', stakesApproved: true });
    expect(run(approved, { contractsDirty: true })).toMatchObject({ step: 'stakes', reason: 'Stakes changed since approval. Approve them again.' });
    expect(run(approved)).toMatchObject({ step: 'lock', next: 'Approve and roll to lock the lines. The dice roll once and never change.' });
  });
  it('drafts when locked without a draft, with a retry sentence after an error', () => {
    expect(run(beatOf({ phase: 'locked', selectedSubmissionIds: ['say-1'] }))).toMatchObject({ step: 'draft', next: 'Draft the scene from the locked lines.', reason: null });
    expect(run(beatOf({ phase: 'locked' }))).toMatchObject({ step: 'draft', next: 'Draft the narration that sets the scene.', reason: null });
    expect(run(beatOf({ phase: 'locked' }), { rendering: true })).toMatchObject({ step: 'draft', reason: 'The script is being drafted.' });
    expect(run(beatOf({ phase: 'locked', lastError: 'x' }))).toMatchObject({ step: 'draft', next: 'The script could not be written. Try again, or write it yourself.' });
  });
  it('reviews unsaved edits, otherwise publishes, whatever the continuity', () => {
    const beat = beatOf({ phase: 'draft_review', draft });
    expect(run(beat, { scriptDirty: true })).toMatchObject({ step: 'review', next: 'Save your edits under More before publishing.' });
    expect(run(beat, { continuityPending: 2 })).toMatchObject({ step: 'publish', next: 'Read the script, then publish.' });
    expect(run(beat)).toMatchObject({ step: 'publish', reason: null });
  });
  it('overrides the reason while paused and keeps the step', () => {
    expect(run(beatOf({}), { paused: true })).toMatchObject({ step: 'select', reason: 'The show is paused.' });
    expect(run(null, { paused: true }).reason).toBe('The show is paused.');
  });
});

describe('usesActionSteps', () => {
  it('is true for every beat except one classified or reviewed as ordinary', () => {
    expect(usesActionSteps(null)).toBe(true);
    expect(usesActionSteps(beatOf({}))).toBe(true);
    expect(usesActionSteps(beatOf({ classification: 'ordinary' }))).toBe(false);
    expect(usesActionSteps(beatOf({ classification: 'ordinary' }), 'action')).toBe(true);
    expect(usesActionSteps(beatOf({ kind: 'action', classification: 'ordinary' }), 'ordinary')).toBe(true);
    expect(usesActionSteps(beatOf({ kind: 'action' }))).toBe(true);
    expect(usesActionSteps(beatOf({ classification: 'needs_action' }))).toBe(true);
    expect(usesActionSteps(beatOf({ classification: 'action' as Beat['classification'] }))).toBe(true);
    expect(usesActionSteps(beatOf({}), 'action')).toBe(true);
    expect(usesActionSteps(beatOf({}), 'ordinary')).toBe(false);
  });
});

describe('stepPosition', () => {
  it('counts three stages in a conversation', () => {
    const got = STEP_ORDER.map(step => [step, stepPosition(step, false).n, stepPosition(step, false).m]);
    expect(got).toEqual([['open', 1, 3], ['select', 1, 3], ['plan', 1, 3], ['stakes', 1, 3], ['lock', 1, 3], ['draft', 2, 3], ['review', 2, 3], ['publish', 3, 3]]);
    expect(stepPosition('lock', false).stage).toBe('lines');
  });
  it('counts five stages in an action round', () => {
    const got = STEP_ORDER.map(step => [step, stepPosition(step, true).stage, stepPosition(step, true).n, stepPosition(step, true).m]);
    expect(got).toEqual([
      ['open', 'lines', 1, 5], ['select', 'lines', 1, 5], ['plan', 'plan', 2, 5], ['stakes', 'stakes', 3, 5],
      ['lock', 'stakes', 3, 5], ['draft', 'script', 4, 5], ['review', 'script', 4, 5], ['publish', 'publish', 5, 5],
    ]);
  });
});

describe('goldAction', () => {
  const g = (step: StepId, patch: Partial<{ beat: Beat | null; paused: boolean; ordinary: boolean }> = {}) =>
    goldAction({ step, beat: beatOf({}), paused: false, ordinary: false, ...patch });
  it('picks one action per step', () => {
    expect(g('open', { beat: null })).toBe('answer');
    expect(g('select')).toBe('plan');
    expect(g('plan')).toBe('plan');
    expect(g('select', { beat: beatOf({ kind: 'action' }) })).toBe('plan');
    expect(g('plan', { beat: beatOf({ kind: 'action' }) })).toBe('plan');
    for (const step of ['stakes', 'lock'] as const) {
      expect(g(step, { ordinary: true })).toBe('lock-and-draft');
      expect(g(step)).toBe('approve-and-roll');
    }
    expect(g('draft')).toBe('draft');
    expect(g('draft', { beat: beatOf({ lastError: 'x' }) })).toBe('try-again');
    expect(g('review')).toBe('publish');
    expect(g('publish')).toBe('publish');
  });
  it('resumes when paused, at every step', () => {
    for (const step of STEP_ORDER) expect(g(step, { paused: true })).toBe('resume');
  });
  it('has a label and test id for every action', () => {
    expect(Object.values(GOLD_LABELS)).toEqual(['Answer these lines', 'Plan', 'Lock and draft', 'Approve and roll', 'Draft the scene', 'Try again', 'Publish', 'Resume show']);
    expect(Object.values(GOLD_TEST_IDS)).toEqual(['answer-lines', 'plan', 'lock-and-draft', 'approve-and-roll', 'render', 'render', 'publish', 'resume-show']);
  });
});

describe('BeatStepper', () => {
  it('shows the step count and links to help with the identity', () => {
    const identity = 'a'.repeat(32);
    window.history.replaceState(null, '', `/?identity=${identity}`);
    const wrapper = mount(BeatStepper, { props: { n: 2, m: 5 } });
    expect(wrapper.get('[data-testid="beat-step-count"]').text()).toBe('Step 2 of 5');
    const link = wrapper.get('a');
    expect(link.text()).toBe('How a beat works');
    expect(link.attributes('href')).toContain(`identity=${identity}`);
    expect(link.attributes('href')).toContain('#running-a-show');
  });
});
