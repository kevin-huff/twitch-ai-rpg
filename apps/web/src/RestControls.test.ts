// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { CommandSchema, STRAIN_MAX } from '@rpg/contracts';
import type { DirectorSnapshot } from '@rpg/contracts';
import RestControls from './RestControls.vue';

const character = (id: string, displayName: string, strain: number) => ({ id, displayName, strain });
function snapshot(strains: [string, string, number][] = [['ada', 'Ada', 1], ['bo', 'Bo', 5], ['cy', 'Cy', 0]]): DirectorSnapshot {
  return { schemaVersion: 1, role: 'director', eventSeq: 0, session: { id: 'show', title: 'Test show', stateRevision: 7, status: 'live', mode: 'conversation', beatNumber: 1, actionRoundNumber: 0, inputEpoch: 3, scene: { id: 'scene', title: 'The bar', description: 'A quiet place.', locationId: 'bar' } }, characters: strains.map(([id, name, strain]) => character(id, name, strain)), npcs: [], npcDetails: [], activeBeat: null, submissions: [] } as unknown as DirectorSnapshot;
}
const field = (id: string) => `[data-testid="${id}"]`;
const mountIt = (current = snapshot(), busy = false) => mount(RestControls, { props: { snapshot: current, busy } });
const value = (wrapper: ReturnType<typeof mountIt>, id: string) => (wrapper.get(field(`rest-amount-${id}`)).element as HTMLInputElement).value;
const saveDisabled = (wrapper: ReturnType<typeof mountIt>) => (wrapper.get(field('save-rest')).element as HTMLButtonElement).disabled;

describe('rest panel', () => {
  it('starts each strained character at 2 or their whole strain and says when there is none', () => {
    const wrapper = mountIt();
    expect(value(wrapper, 'ada')).toBe('1');
    expect(value(wrapper, 'bo')).toBe('2');
    expect(wrapper.text()).toContain(`Ada: 1 of ${STRAIN_MAX}`);
    expect(wrapper.text()).toContain(`Bo: 5 of ${STRAIN_MAX}`);
    expect(wrapper.find(field('rest-amount-cy')).exists()).toBe(false);
    expect(wrapper.get(field('rest-none-cy')).text()).toBe('Cy has no strain.');
    expect(wrapper.text()).toContain('Lines players sent stay where they are.');
  });

  it('sends a valid rest command with only the amounts of 1 or more and the captured revision', async () => {
    const wrapper = mountIt();
    await wrapper.get(field('rest-amount-ada')).setValue('0');
    await wrapper.get(field('rest-amount-bo')).setValue('3');
    await wrapper.get(field('save-rest')).trigger('submit');
    const [command, onSaved] = wrapper.emitted('command')![0] as [unknown, () => void];
    expect(CommandSchema.safeParse(command).success).toBe(true);
    expect(command).toMatchObject({ type: 'rest', expectedStateRevision: 7, rests: [{ characterId: 'bo', amount: 3 }] });
    expect((command as { rests: unknown[] }).rests).toHaveLength(1);
    onSaved();
    await wrapper.vm.$nextTick();
    expect(wrapper.get(field('rest-saved')).text()).toBe('Rest saved. Strain went down.');
    expect(value(wrapper, 'bo')).toBe('2');
  });

  it('disables Rest while busy, gated, at all zeros, or with a bad amount', async () => {
    expect(saveDisabled(mountIt())).toBe(false);
    expect(saveDisabled(mountIt(snapshot(), true))).toBe(true);
    const wrapper = mountIt();
    await wrapper.get(field('rest-amount-ada')).setValue('0');
    await wrapper.get(field('rest-amount-bo')).setValue('0');
    expect(saveDisabled(wrapper)).toBe(true);
    for (const bad of ['6', '1.5', '-1', '']) {
      await wrapper.get(field('rest-amount-bo')).setValue(bad);
      expect(saveDisabled(wrapper), `amount "${bad}"`).toBe(true);
    }
    await wrapper.get(field('rest-amount-bo')).setValue('5');
    expect(saveDisabled(wrapper)).toBe(false);
    await wrapper.get(field('save-rest')).trigger('submit');
    expect(wrapper.emitted('command')).toHaveLength(1);
    const blocked = mountIt(snapshot(), true);
    await blocked.get(field('save-rest')).trigger('submit');
    expect(blocked.emitted('command')).toBeUndefined();
  });

  it('shows the gate texts and only blocks past collecting', () => {
    const gateText = (change: (current: DirectorSnapshot) => void) => { const current = snapshot(); change(current); const wrapper = mountIt(current); return { text: wrapper.find(field('rest-gate')).exists() ? wrapper.get(field('rest-gate')).text() : '', disabled: saveDisabled(wrapper) }; };
    expect(gateText(() => {})).toEqual({ text: '', disabled: false });
    expect(gateText(current => { current.session.status = 'paused'; })).toEqual({ text: '', disabled: false });
    expect(gateText(current => { current.activeBeat = { phase: 'collecting' } as DirectorSnapshot['activeBeat']; })).toEqual({ text: '', disabled: false });
    expect(gateText(current => { current.setup = { started: false } as DirectorSnapshot['setup']; })).toEqual({ text: 'Start the show from Cast & lobby first.', disabled: true });
    expect(gateText(current => { current.session.status = 'ended'; })).toEqual({ text: 'The show has ended.', disabled: true });
    expect(gateText(current => { current.session.status = 'lobby'; })).toEqual({ text: 'Open a conversation or an action round first.', disabled: true });
    for (const phase of ['planning', 'stakes_review', 'locked', 'rendering', 'draft_review']) {
      expect(gateText(current => { current.activeBeat = { phase } as DirectorSnapshot['activeBeat']; }), phase).toEqual({ text: 'Publish or abandon this round first.', disabled: true });
    }
  });

  it('rebuilds quietly when nothing was edited, and offers Start over once a number was edited', async () => {
    const wrapper = mountIt();
    const next = snapshot([['ada', 'Ada', 4], ['bo', 'Bo', 1], ['cy', 'Cy', 3]]);
    next.session.stateRevision = 8;
    await wrapper.setProps({ snapshot: next });
    expect(value(wrapper, 'ada')).toBe('2');
    expect(value(wrapper, 'bo')).toBe('1');
    expect(value(wrapper, 'cy')).toBe('2');
    expect(wrapper.find(field('rest-stale')).exists()).toBe(false);

    await wrapper.get(field('rest-amount-ada')).setValue('4');
    const later = snapshot([['ada', 'Ada', 3], ['bo', 'Bo', 1], ['cy', 'Cy', 3]]);
    later.session.stateRevision = 9;
    await wrapper.setProps({ snapshot: later });
    expect(wrapper.get(field('rest-stale')).text()).toContain('Strain changed since you started. Press Start over to load the new numbers.');
    expect(value(wrapper, 'ada')).toBe('4');
    expect(saveDisabled(wrapper)).toBe(true);
    await wrapper.get(field('rest-reset')).trigger('click');
    expect(wrapper.find(field('rest-stale')).exists()).toBe(false);
    expect(value(wrapper, 'ada')).toBe('2');
    expect(saveDisabled(wrapper)).toBe(false);
    await wrapper.get(field('save-rest')).trigger('submit');
    expect(wrapper.emitted('command')![0][0]).toMatchObject({ expectedStateRevision: 9 });
  });

  it('gives every input its own help line outside its label', () => {
    const wrapper = mountIt(snapshot([['ada', 'Ada', 1], ['bo', 'Bo', 5], ['cy', 'Cy', 2]]));
    const inputs = wrapper.findAll('input');
    expect(inputs).toHaveLength(3);
    const ids = new Set<string>();
    for (const control of inputs) {
      const id = control.attributes('aria-describedby')!;
      expect(id).toBeTruthy();
      ids.add(id);
      const matches = wrapper.findAll('[id]').filter(item => item.attributes('id') === id);
      expect(matches).toHaveLength(1);
      expect(matches[0].classes()).toContain('field-help');
      expect(matches[0].text().length).toBeGreaterThan(20);
      expect(control.element.closest('label')?.contains(matches[0].element)).toBe(false);
    }
    expect(ids.size).toBe(3);
    expect(wrapper.get(field('rest-amount-bo')).element.closest('label')!.textContent).toContain('Bo: strain to take off');
    expect(wrapper.findAll('p.field-help')[1].text()).toBe('How much strain Bo loses, from 0 to 5. 0 means Bo does not rest.');
  });
});
