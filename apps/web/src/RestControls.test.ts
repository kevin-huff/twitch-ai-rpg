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
const saveDisabled = (wrapper: ReturnType<typeof mountIt>) => (wrapper.get(field('save-rest')).element as HTMLButtonElement).disabled;

describe('rest panel', () => {
  it('shows the intro, each strain and no inputs', () => {
    const wrapper = mountIt();
    expect(wrapper.text()).toContain("Let every character catch their breath. Rest sets everyone's strain back to 0. Lines players sent stay where they are.");
    expect(wrapper.text()).toContain(`Ada: 1 of ${STRAIN_MAX}`);
    expect(wrapper.text()).toContain(`Bo: 5 of ${STRAIN_MAX}`);
    expect(wrapper.get(field('rest-none-cy')).text()).toBe('Cy has no strain.');
    expect(wrapper.findAll('input')).toHaveLength(0);
    expect(wrapper.get(field('save-rest')).text()).toBe('Rest everyone');
  });

  it('asks first, then sends one rest command with the captured revision', async () => {
    const wrapper = mountIt();
    await wrapper.get(field('save-rest')).trigger('click');
    expect(wrapper.emitted('command')).toBeUndefined();
    expect(wrapper.text()).toContain("Rest everyone? Every character's strain goes back to 0.");
    await wrapper.get(field('rest-confirm')).trigger('click');
    const [command, onSaved] = wrapper.emitted('command')![0] as [Record<string, unknown>, () => void];
    expect(CommandSchema.safeParse(command).success).toBe(true);
    expect(Object.keys(command).sort()).toEqual(['commandId', 'expectedStateRevision', 'type']);
    expect(command).toMatchObject({ type: 'rest', expectedStateRevision: 7 });
    onSaved();
    await wrapper.vm.$nextTick();
    expect(wrapper.get(field('rest-saved')).text()).toBe('Rest saved. Strain went down.');
    expect(wrapper.find(field('rest-confirm')).exists()).toBe(false);
  });

  it('Keep strain closes the question without sending', async () => {
    const wrapper = mountIt();
    await wrapper.get(field('save-rest')).trigger('click');
    await wrapper.get(field('rest-keep')).trigger('click');
    expect(wrapper.find(field('rest-confirm')).exists()).toBe(false);
    expect(wrapper.emitted('command')).toBeUndefined();
  });

  it('is disabled when nobody has strain, and says so', () => {
    const wrapper = mountIt(snapshot([['ada', 'Ada', 0]]));
    expect(saveDisabled(wrapper)).toBe(true);
    expect(wrapper.text()).toContain('Nobody has strain to rest.');
  });

  it('closes the question with the stale sentence when the show changes meanwhile', async () => {
    const wrapper = mountIt();
    await wrapper.get(field('save-rest')).trigger('click');
    const next = snapshot();
    next.session.stateRevision = 8;
    await wrapper.setProps({ snapshot: next });
    expect(wrapper.find(field('rest-confirm')).exists()).toBe(false);
    expect(wrapper.get(field('rest-stale')).text()).toBe('The show changed while you were choosing. Check the strain, then press Rest everyone again.');
    await wrapper.get(field('save-rest')).trigger('click');
    await wrapper.get(field('rest-confirm')).trigger('click');
    expect(wrapper.emitted('command')![0][0]).toMatchObject({ expectedStateRevision: 8 });
    expect(wrapper.find(field('rest-stale')).exists()).toBe(false);
  });

  it('labels the button and disables it while busy', async () => {
    expect(saveDisabled(mountIt(snapshot(), true))).toBe(true);
    expect(mountIt(snapshot(), true).get(field('save-rest')).text()).toBe('Rest everyone');
    expect(mountIt().text()).not.toContain('Waiting for the AI to finish');
    const wrapper = mountIt();
    await wrapper.get(field('save-rest')).trigger('click');
    await wrapper.get(field('rest-confirm')).trigger('click');
    await wrapper.setProps({ busy: true });
    await wrapper.vm.$nextTick();
    expect((wrapper.emitted('command')![0] as unknown[]).length).toBe(2);
  });

  it('does not call a successful save a stale show, even when the new revision arrives before the saved callback', async () => {
    const wrapper = mountIt();
    await wrapper.get(field('save-rest')).trigger('click');
    await wrapper.get(field('rest-confirm')).trigger('click');
    const [, onSaved] = wrapper.emitted('command')![0] as [unknown, () => void];
    const next = snapshot([['ada', 'Ada', 0], ['bo', 'Bo', 0], ['cy', 'Cy', 0]]);
    next.session.stateRevision = 8;
    await wrapper.setProps({ snapshot: next, busy: true });
    expect(wrapper.find(field('rest-stale')).exists()).toBe(false);
    onSaved();
    await wrapper.setProps({ busy: false });
    expect(wrapper.find(field('rest-stale')).exists()).toBe(false);
    expect(wrapper.get(field('rest-saved')).text()).toBe('Rest saved. Strain went down.');
  });

  it('clears an old stale notice when a later save succeeds', async () => {
    const wrapper = mountIt();
    await wrapper.get(field('save-rest')).trigger('click');
    const next = snapshot();
    next.session.stateRevision = 8;
    await wrapper.setProps({ snapshot: next });
    expect(wrapper.find(field('rest-stale')).exists()).toBe(true);
    await wrapper.get(field('save-rest')).trigger('click');
    await wrapper.get(field('rest-confirm')).trigger('click');
    const [, onSaved] = wrapper.emitted('command')![0] as [unknown, () => void];
    onSaved();
    await wrapper.vm.$nextTick();
    expect(wrapper.find(field('rest-stale')).exists()).toBe(false);
  });

  it('shows Saving… on the confirm button during its own save', async () => {
    const wrapper = mountIt();
    await wrapper.get(field('save-rest')).trigger('click');
    expect(wrapper.get(field('rest-confirm')).text()).toBe('Yes, rest everyone');
    await wrapper.get(field('rest-confirm')).trigger('click');
    await wrapper.setProps({ busy: true });
    const confirm = wrapper.get(field('rest-confirm'));
    expect(confirm.text()).toBe('Saving…');
    expect((confirm.element as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the round-open note and the longer saved notice only while a plan exists or is being made', async () => {
    const setJobs = (current: DirectorSnapshot, jobs: unknown[]) => { (current as unknown as { jobs: unknown[] }).jobs = jobs; };
    const beat = (phase: string) => ({ id: 'b1', phase }) as DirectorSnapshot['activeBeat'];
    const cases: Array<[string, (current: DirectorSnapshot) => void, boolean]> = [
      ['collecting with no plan', current => { current.activeBeat = beat('collecting'); setJobs(current, []); }, false],
      ['collecting with a running plan job', current => { current.activeBeat = beat('collecting'); setJobs(current, [{ beatId: 'b1', task: 'plan', status: 'running' }]); }, true],
      ['collecting with a finished plan job', current => { current.activeBeat = beat('collecting'); setJobs(current, [{ beatId: 'b1', task: 'plan', status: 'succeeded' }]); }, false],
      ['stakes review', current => { current.activeBeat = beat('stakes_review'); }, true],
    ];
    for (const [label, change, planned] of cases) {
      const current = snapshot();
      change(current);
      const wrapper = mountIt(current);
      expect(wrapper.find(field('rest-round-open')).exists(), label).toBe(planned);
      if (planned) expect(wrapper.get(field('rest-round-open')).text()).toBe('A round is open. Saving this sends it back to taking lines and throws away its plan, even one the AI is still making. Press Plan to plan it again. That is another AI call.');
      expect(saveDisabled(wrapper)).toBe(false);
      await wrapper.get(field('save-rest')).trigger('click');
      await wrapper.get(field('rest-confirm')).trigger('click');
      const [, onSaved] = wrapper.emitted('command')![0] as [unknown, () => void];
      onSaved();
      await wrapper.vm.$nextTick();
      expect(wrapper.get(field('rest-saved')).text(), label).toBe(planned ? 'Rest saved. Strain went down. The round went back to taking lines. Press Plan to plan it again.' : 'Rest saved. Strain went down.');
    }
    expect(mountIt().find(field('rest-round-open')).exists()).toBe(false);
  });

  it('shows the gate texts and only blocks once the dice are rolled', () => {
    const gateText = (change: (current: DirectorSnapshot) => void) => { const current = snapshot(); change(current); const wrapper = mountIt(current); return { text: wrapper.find(field('rest-gate')).exists() ? wrapper.get(field('rest-gate')).text() : '', disabled: saveDisabled(wrapper) }; };
    expect(gateText(() => {})).toEqual({ text: '', disabled: false });
    expect(gateText(current => { current.session.status = 'paused'; })).toEqual({ text: '', disabled: false });
    for (const phase of ['collecting', 'stakes_review', 'planning', 'rendering']) expect(gateText(current => { current.activeBeat = { phase } as DirectorSnapshot['activeBeat']; }), phase).toEqual({ text: '', disabled: false });
    expect(gateText(current => { current.setup = { started: false } as DirectorSnapshot['setup']; })).toEqual({ text: 'Start the show from Cast & lobby first.', disabled: true });
    expect(gateText(current => { current.session.status = 'ended'; })).toEqual({ text: 'The show has ended.', disabled: true });
    expect(gateText(current => { current.session.status = 'lobby'; })).toEqual({ text: 'Open a conversation or an action round first.', disabled: true });
    for (const phase of ['locked', 'draft_review']) {
      expect(gateText(current => { current.activeBeat = { phase } as DirectorSnapshot['activeBeat']; }), phase).toEqual({ text: 'Publish or abandon this round first.', disabled: true });
    }
  });
});
