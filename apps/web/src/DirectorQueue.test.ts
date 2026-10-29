// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { DirectorSnapshot } from '@rpg/contracts';
import DirectorQueue from './DirectorQueue.vue';

const sub = (id: string, kind: 'say' | 'act' | 'ooc', patch: Record<string, unknown> = {}) => ({ id, sessionId: 's', characterId: 'c1', contextBeatId: null, inputEpoch: 0, revision: 1, kind, text: `text ${id}`, recipientNpcIds: [], intent: 'Enter', approach: 'Sneak', stageDirection: '', alreadySpokenAloud: true, status: 'queued', ...patch });
const snap = (submissions: unknown[], activeBeat: unknown = null) => ({ role: 'director', characters: [{ id: 'c1', displayName: 'Mara' }], npcs: [{ id: 'n1', displayName: 'Old Tom' }], submissions, activeBeat } as unknown as DirectorSnapshot);
const mountQueue = (submissions: unknown[], activeBeat: unknown = null, modelValue: string[] = []) => mount(DirectorQueue, { props: { snapshot: snap(submissions, activeBeat), modelValue } });

describe('DirectorQueue', () => {
  it('gives every checkbox its own help with whitespace-safe ids', () => {
    const wrapper = mountQueue([sub('one space', 'say'), sub('two space', 'act'), sub('three', 'ooc')]);
    const ids = wrapper.findAll('input[type="checkbox"]').map(box => box.attributes('aria-describedby')!);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(id).not.toMatch(/\s/);
      expect(wrapper.get(`[id="${id}"]`).text().length).toBeGreaterThan(20);
    }
    expect(wrapper.findAll('.queue-item strong').map(node => node.text())).toEqual(['Mara', 'Mara', 'Mara']);
    expect(wrapper.findAll('.queue-item').every(item => item.findAll('input[type="checkbox"]').length === 1)).toBe(true);
  });

  it('describes each kind of line', () => {
    const wrapper = mountQueue([sub('a', 'say', { recipientNpcIds: ['n1'] }), sub('b', 'say'), sub('c', 'act', { status: 'selected' }), sub('d', 'ooc')]);
    const help = wrapper.findAll('.field-help').map(node => node.text());
    expect(help).toEqual(['Exact dialogue to Old Tom · queued', 'Exact dialogue to the party · queued', 'Action from Mara · selected', 'Question for the director · cannot be planned']);
  });

  it('lists questions after in-character lines in their own group and disables them', () => {
    const wrapper = mountQueue([sub('q', 'ooc'), sub('s', 'say')]);
    const items = wrapper.findAll('.queue-item');
    expect(items[0].text()).toContain('text s');
    expect(items[1].text()).toContain('text q');
    expect(wrapper.get('h3').text()).toBe('Questions and pause requests');
    expect(items[1].get('input').attributes('disabled')).toBeDefined();
    expect(items[0].get('input').attributes('disabled')).toBeUndefined();
  });

  it('tags lines from an earlier exchange and shows stage directions', () => {
    const wrapper = mountQueue([sub('old', 'say', { contextBeatId: 'b0', stageDirection: 'whispers' }), sub('new', 'say', { contextBeatId: 'b1' })], { id: 'b1', phase: 'collecting' });
    const items = wrapper.findAll('.queue-item');
    expect(items[0].text()).toContain('From an earlier exchange');
    expect(items[0].get('.stage-direction').text()).toBe('whispers');
    expect(items[1].text()).not.toContain('From an earlier exchange');
  });

  it('shows a one-box action once and a two-box action with its approach', () => {
    const wrapper = mountQueue([sub('one', 'act', { intent: 'Climb the fire escape', approach: 'Climb the fire escape' }), sub('two', 'act')]);
    const [one, two] = wrapper.findAll('.queue-item');
    expect(one.text().split('Climb the fire escape')).toHaveLength(2);
    expect(one.find('small').exists()).toBe(false);
    expect(two.get('small').text()).toBe('Sneak');
  });

  it('selects all lines and clears', async () => {
    const wrapper = mountQueue([sub('s', 'say'), sub('a', 'act'), sub('q', 'ooc')], null, ['s']);
    const buttons = wrapper.findAll('button');
    await buttons.find(button => button.text() === 'Select all lines')!.trigger('click');
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([['s', 'a']]);
    await buttons.find(button => button.text() === 'Clear')!.trigger('click');
    expect(wrapper.emitted('update:modelValue')![1]).toEqual([[]]);
    expect(wrapper.findAll('.queue-item button')).toHaveLength(0);
  });

  it('emits the new selection when a box is ticked', async () => {
    const wrapper = mountQueue([sub('s', 'say')]);
    await wrapper.get('input').setValue(true);
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([['s']]);
  });

  it('uses the cast heading and counts lines and questions', () => {
    const two = mountQueue([sub('a', 'say'), sub('b', 'act'), sub('q', 'ooc')]);
    expect(two.get('h2').text()).toBe('Lines from the cast');
    expect(two.get('.status').text()).toBe('2 lines waiting · 1 question');
    const one = mountQueue([sub('a', 'say')]);
    expect(one.get('.status').text()).toBe('1 line waiting');
    const none = mountQueue([sub('q', 'ooc'), sub('r', 'ooc')]);
    expect(none.get('.status').text()).toBe('No lines waiting · 2 questions');
  });

  it('explains that lines arrive ticked', () => {
    const wrapper = mountQueue([sub('s', 'say')]);
    expect(wrapper.get('.queue-hint').text()).toBe('Lines arrive ticked. Untick any you want to leave for later. Questions and pause requests are never ticked.');
  });

  describe('Not in this plan tag', () => {
    const beat = (patch: Record<string, unknown> = {}) => ({ id: 'b1', generation: 1, phase: 'stakes_review', selectedSubmissionIds: ['in'], ...patch });
    const mountWith = (activeBeat: unknown, jobs: unknown[], ticked: string[]) => mount(DirectorQueue, { props: { snapshot: { ...snap([sub('in', 'say'), sub('late', 'say')], activeBeat), jobs } as unknown as DirectorSnapshot, modelValue: ticked } });
    const job = (patch: Record<string, unknown> = {}) => ({ id: 'j', beatId: 'b1', generation: 1, task: 'plan', status: 'running', ...patch });

    it('shows for a ticked line missing from the plan in stakes review', () => {
      const items = mountWith(beat(), [], ['in', 'late']).findAll('.queue-item');
      expect(items[0].text()).not.toContain('Not in this plan');
      expect(items[1].text()).toContain('Not in this plan');
    });

    it('shows while a plan job is running', () => {
      const wrapper = mountWith(beat({ phase: 'collecting' }), [job()], ['late']);
      expect(wrapper.text()).toContain('Not in this plan');
    });

    it('does not show while collecting with no plan job', () => {
      expect(mountWith(beat({ phase: 'collecting' }), [], ['late']).text()).not.toContain('Not in this plan');
      expect(mountWith(beat({ phase: 'collecting' }), [job({ status: 'succeeded' })], ['late']).text()).not.toContain('Not in this plan');
    });

    it('does not show for a line already in the plan', () => {
      expect(mountWith(beat(), [], ['in']).text()).not.toContain('Not in this plan');
    });

    it('does not show for an unticked line', () => {
      expect(mountWith(beat(), [], []).text()).not.toContain('Not in this plan');
    });
  });
});
