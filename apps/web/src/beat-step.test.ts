// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { Beat } from '@rpg/contracts';
import { beatStep, type BeatStepInput } from './beat-step';
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
      const result = run(beat);
      expect(result.step).toBe('open');
      expect(result.next).toBe('Open a conversation, or an action round when the party tries something risky.');
      expect(result.reason).toBeNull();
    }
  });
  it('asks to select lines, then plan', () => {
    expect(run(beatOf({}))).toMatchObject({ step: 'select', reason: 'Select at least one line to plan.' });
    expect(run(beatOf({}), { selectedCount: 2 })).toMatchObject({ step: 'plan', reason: null });
  });
  it('checks the planning-failed case first', () => {
    const result = run(beatOf({ lastError: 'boom', selectedSubmissionIds: ['x'] }));
    expect(result).toMatchObject({ step: 'stakes', next: 'Planning failed. Review the stakes by hand or abandon the beat.' });
    expect(run(beatOf({ lastError: 'boom' })).step).toBe('select');
  });
  it('handles stakes review', () => {
    expect(run(beatOf({ phase: 'stakes_review' })).step).toBe('stakes');
    expect(run(beatOf({ phase: 'stakes_review', stakesApproved: true }), { contractsDirty: true }))
      .toMatchObject({ step: 'stakes', reason: 'Stakes changed since approval. Approve them again.' });
    expect(run(beatOf({ phase: 'stakes_review', stakesApproved: true })).step).toBe('lock');
  });
  it('drafts when locked without a draft', () => {
    expect(run(beatOf({ phase: 'locked' }))).toMatchObject({ step: 'draft', reason: null });
    expect(run(beatOf({ phase: 'locked' }), { rendering: true })).toMatchObject({ step: 'draft', reason: 'The script is being drafted.' });
  });
  it('reviews then publishes', () => {
    const beat = beatOf({ phase: 'draft_review', draft });
    expect(run(beat, { scriptDirty: true })).toMatchObject({ step: 'review', reason: 'Save script edits before publishing.' });
    expect(run(beat, { continuityPending: 2 })).toMatchObject({ step: 'review', next: 'Approve the continuity updates, then publish.' });
    expect(run(beat)).toMatchObject({ step: 'publish', reason: null });
  });
  it('overrides the reason while paused and keeps the step', () => {
    const result = run(beatOf({}), { paused: true });
    expect(result).toMatchObject({ step: 'select', reason: 'The table is paused. Resume to continue.' });
    expect(run(null, { paused: true }).reason).toBe('The table is paused. Resume to continue.');
  });
  it('gives every result a plain next sentence', () => {
    const beats = [null, beatOf({}), beatOf({ phase: 'stakes_review' }), beatOf({ phase: 'locked' }), beatOf({ phase: 'draft_review', draft })];
    for (const beat of beats) expect(run(beat, { selectedCount: 1 }).next.length).toBeGreaterThan(10);
  });
});

describe('BeatStepper', () => {
  it('marks the current step, earlier steps done, and links to help with the identity', () => {
    const identity = 'a'.repeat(32);
    window.history.replaceState(null, '', `/?identity=${identity}`);
    const wrapper = mount(BeatStepper, { props: { step: 'lock', next: 'Lock the input.', reason: 'Because.' } });
    const items = wrapper.findAll('ol[aria-label="Beat steps"] > li');
    expect(items.map(item => item.find('.step-label').text())).toEqual(['Open', 'Select lines', 'Plan', 'Stakes', 'Lock', 'Draft', 'Review', 'Publish']);
    expect(wrapper.findAll('[aria-current="step"]')).toHaveLength(1);
    expect(items[4].attributes('aria-current')).toBe('step');
    expect(items.filter(item => item.text().includes('Done'))).toHaveLength(4);
    expect(items[5].text()).not.toContain('Done');
    expect(wrapper.find('h1,h2,h3,h4,h5,h6').exists()).toBe(false);
    expect(wrapper.find('button,input,select,textarea').exists()).toBe(false);
    expect(wrapper.find('[aria-live="polite"]').text()).toContain('Lock the input.');
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    const link = wrapper.get('a');
    expect(link.text()).toBe('How a beat works');
    expect(link.attributes('href')).toContain(`identity=${identity}`);
    expect(link.attributes('href')).toContain('#running-a-show');
  });
});
