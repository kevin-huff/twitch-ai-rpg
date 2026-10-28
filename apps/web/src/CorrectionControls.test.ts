// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { CommandSchema, NpcSchema } from '@rpg/contracts';
import type { Command, DirectorSnapshot } from '@rpg/contracts';
import CorrectionControls from './CorrectionControls.vue';

const memory = { id: 'known-fact', statement: 'The bridge is closed.', category: 'fact', acquisition: 'scenario', sourceEventId: 'event', sourceEntityId: null, learnedBeatNumber: 0 };
const npc = NpcSchema.parse({ id: 'mara', displayName: 'Mara', role: 'Keeper', locationId: 'bar', status: 'present', voiceProfileId: 'mara', knowledge: [memory, { ...memory, id: 'belief', category: 'belief' }, { ...memory, id: 'different', statement: 'Private unrelated memory' }] });
function snapshot(): DirectorSnapshot {
  return { schemaVersion: 1, role: 'director', eventSeq: 3, session: { id: 'show', title: 'Show', stateRevision: 7, status: 'live', mode: 'conversation', beatNumber: 2, actionRoundNumber: 0, inputEpoch: 0, scene: { id: 'scene', title: 'The bar', description: '', locationId: 'bar' } }, locations: [], characters: [{ id: 'aster', displayName: 'Aster', traits: { force: 0, finesse: 2, wits: 1, presence: 1 }, strain: 2, appearance: '', approved: true, ready: true }], characterDetails: [], npcs: [], npcDetails: [npc, { ...npc, id: 'dax', displayName: 'Dax', knowledge: [{ ...npc.knowledge[0]!, id: 'dax-fact' }] }], tracks: [{ id: 'danger', label: 'Alarm', current: 2, max: 4, kind: 'danger', enabled: true, completionText: '' }], facts: [{ id: 'bridge', text: 'The bridge is closed.' }, { id: 'weather', text: 'It is raining.' }], history: [1, 2].map(beatNumber => ({ id: `beat-${beatNumber}`, kind: 'conversation', beatNumber, actionRoundNumber: 0, stateRevision: beatNumber, publishedAt: '2026-10-22T12:00:00.000Z', segments: [], rolls: [], outcomes: [], textOnly: true })), corrections: [], activeBeat: null, submissions: [], jobs: [], picturesEnabled: false, scenePicture: null, scenePictureStatus: null, actionPicture: null, pictureSettings: null, lastSceneBeatId: null, portraitJobs: [], gallery: null, directorNotes: 'Private director notes' } as DirectorSnapshot;
}
const field = (name: string) => `[data-testid="${name}"]`;
async function begin(wrapper: ReturnType<typeof mount>) { await wrapper.get(field('begin-correction')).trigger('click'); }
async function common(wrapper: ReturnType<typeof mount>) {
  await wrapper.get(field('correction-public-text')).setValue('The bridge is open; the earlier narration was mistaken.');
  await wrapper.get(field('correction-reason')).setValue('I misread the scenario.');
  await wrapper.get(field('correction-discard-input')).setValue(true);
}
function command(wrapper: ReturnType<typeof mount>, index = 0) { return wrapper.emitted('command')![index]![0] as Command; }

describe('director corrections', () => {
  it('records an older published beat clarification with a separate public preview and private audit reason', async () => {
    const wrapper = mount(CorrectionControls, { props: { snapshot: snapshot(), busy: false } });
    expect(wrapper.get('summary').text()).toBe('Corrections'); await begin(wrapper); await common(wrapper);
    await wrapper.get(field('correction-beat')).setValue('beat-1');
    expect(wrapper.get(field('correction-public-preview')).text()).toContain('The bridge is open');
    expect(wrapper.get(field('correction-public-preview')).text()).not.toContain('misread');
    await wrapper.get(field('save-correction')).trigger('click');
    expect(command(wrapper)).toEqual({ type: 'record_correction', commandId: expect.any(String), expectedStateRevision: 7, publishedBeatId: 'beat-1', publicText: 'The bridge is open; the earlier narration was mistaken.', reason: 'I misread the scenario.', discardQueuedInput: true, changes: [] });
    expect(CommandSchema.safeParse(command(wrapper)).success).toBe(true);
    (wrapper.emitted('command')![0]![1] as () => void)();
    await wrapper.vm.$nextTick();
    expect(wrapper.find(field('correction-public-text')).exists()).toBe(false);
    expect(wrapper.get('[role="status"]').text()).toContain('Correction published'); wrapper.unmount();
  });

  it('requires one explicit disposition for every exact matching fact memory and previews both outcomes', async () => {
    const wrapper = mount(CorrectionControls, { props: { snapshot: snapshot(), busy: false } }); await begin(wrapper); await common(wrapper);
    await wrapper.get(field('add-correction-fact')).trigger('click');
    await wrapper.get(field('correction-fact-text-0')).setValue('The bridge is open.');
    const knowledge = wrapper.findAll('[data-testid^="correction-knowledge-0-"]');
    expect(knowledge).toHaveLength(2);
    await knowledge[1]!.setValue('retain_belief');
    expect(wrapper.text()).not.toContain('Private unrelated memory');
    expect(wrapper.get(field('correction-change-preview-0')).text()).toContain('The bridge is closed. becomes The bridge is open.');
    expect(wrapper.get(field('correction-memory-preview-0')).text()).toContain('Mara');
    expect(wrapper.get(field('correction-memory-preview-0')).text()).toContain('Dax');
    expect(wrapper.get(field('correction-memory-preview-0')).text()).toContain('belief');
    await wrapper.get(field('save-correction')).trigger('click');
    expect(command(wrapper)).toMatchObject({ changes: [{ kind: 'fact_replace', factId: 'bridge', text: 'The bridge is open.', knowledgeUpdates: [{ npcId: 'mara', knowledgeId: 'known-fact', mode: 'correct' }, { npcId: 'dax', knowledgeId: 'dax-fact', mode: 'retain_belief' }] }] });
    wrapper.unmount();
  });

  it('previews strain and track values and respects the selected track maximum', async () => {
    const wrapper = mount(CorrectionControls, { props: { snapshot: snapshot(), busy: false } }); await begin(wrapper); await common(wrapper);
    await wrapper.get(field('add-correction-strain')).trigger('click');
    await wrapper.get(field('correction-value-0')).setValue('1');
    await wrapper.get(field('add-correction-track')).trigger('click');
    expect(wrapper.get(field('correction-value-1')).attributes('max')).toBe('4');
    await wrapper.get(field('correction-value-1')).setValue('5');
    await wrapper.get(field('save-correction')).trigger('click');
    expect(wrapper.emitted('command')).toBeUndefined(); expect(wrapper.get('[role="alert"]').text()).toContain('Alarm');
    await wrapper.get(field('correction-value-1')).setValue('4');
    expect(wrapper.get(field('correction-change-preview-0')).text()).toContain('2 becomes 1');
    expect(wrapper.get(field('correction-change-preview-1')).text()).toContain('2 becomes 4');
    expect(wrapper.text()).toMatch(/does not.*completion effects/i);
    await wrapper.get(field('save-correction')).trigger('click');
    expect(command(wrapper)).toMatchObject({ changes: [{ kind: 'strain_set', characterId: 'aster', value: 1 }, { kind: 'track_set', trackId: 'danger', value: 4 }] }); wrapper.unmount();
  });

  it('reports missing acknowledgement and no-op changes at Save without losing words', async () => {
    const wrapper = mount(CorrectionControls, { props: { snapshot: snapshot(), busy: false } }); await begin(wrapper);
    await wrapper.get(field('save-correction')).trigger('click');
    expect(wrapper.get('[role="alert"]').text()).toMatch(/public correction|reason|acknowledge/i);
    await common(wrapper); await wrapper.get(field('add-correction-fact')).trigger('click');
    await wrapper.get(field('save-correction')).trigger('click');
    expect(wrapper.emitted('command')).toBeUndefined(); expect(wrapper.get('[role="alert"]').text()).toMatch(/unchanged/i);
    expect((wrapper.get(field('correction-public-text')).element as HTMLTextAreaElement).value).toContain('earlier narration'); wrapper.unmount();
  });

  it('avoids duplicate targets and rebuilds only the selected fact’s existing knowledge choices', async () => {
    const wrapper = mount(CorrectionControls, { props: { snapshot: snapshot(), busy: false } }); await begin(wrapper); await common(wrapper);
    await wrapper.get(field('add-correction-fact')).trigger('click');
    await wrapper.get(field('add-correction-fact')).trigger('click');
    expect((wrapper.get(field('correction-target-1')).element as HTMLSelectElement).value).toBe('weather');
    expect(wrapper.get(`${field('correction-target-1')} option[value="bridge"]`).attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('[data-testid^="correction-knowledge-1-"]')).toHaveLength(0);
    await wrapper.get(field('remove-correction-0')).trigger('click');
    await wrapper.get(field('correction-target-0')).setValue('bridge');
    expect(wrapper.findAll('[data-testid^="correction-knowledge-0-"]')).toHaveLength(2); wrapper.unmount();
  });

  it('retains failed saves, reuses the command identifier, and requires explicit reload after state changes', async () => {
    const wrapper = mount(CorrectionControls, { props: { snapshot: snapshot(), busy: false } }); await begin(wrapper); await common(wrapper);
    await wrapper.get(field('save-correction')).trigger('click');
    await wrapper.setProps({ busy: true }); expect(wrapper.get(field('correction-public-text')).element.matches(':disabled')).toBe(true);
    await wrapper.setProps({ busy: false }); await wrapper.get(field('save-correction')).trigger('click');
    expect(command(wrapper, 1)).toEqual(command(wrapper));
    const next = snapshot(); next.session.stateRevision = 8;
    await wrapper.setProps({ snapshot: next });
    expect(wrapper.get(field('save-correction')).attributes('disabled')).toBeDefined();
    expect((wrapper.get(field('correction-public-text')).element as HTMLTextAreaElement).value).toContain('earlier narration');
    await wrapper.get(field('reload-correction')).trigger('click');
    expect((wrapper.get(field('correction-public-text')).element as HTMLTextAreaElement).value).toBe('');
    await common(wrapper); await wrapper.get(field('save-correction')).trigger('click');
    expect(command(wrapper, 2)).toMatchObject({ expectedStateRevision: 8 }); wrapper.unmount();
  });

  it('caps a correction at ten changes and describes every editable field accessibly', async () => {
    const current = snapshot(); current.facts = Array.from({ length: 11 }, (_, index) => ({ id: `fact-${index}`, text: `Public fact ${index}` }));
    const wrapper = mount(CorrectionControls, { props: { snapshot: current, busy: false } }); await begin(wrapper);
    for (let index = 0; index < 10; index++) await wrapper.get(field('add-correction-fact')).trigger('click');
    expect(wrapper.findAll('[data-testid^="correction-fact-text-"]')).toHaveLength(10);
    expect(wrapper.get(field('add-correction-fact')).attributes('disabled')).toBeDefined();
    const ids: string[] = [];
    for (const control of wrapper.findAll('input, select, textarea')) {
      const id = control.attributes('aria-describedby')!; ids.push(id);
      const help = wrapper.findAll('[id]').filter(item => item.attributes('id') === id);
      expect(help).toHaveLength(1); expect(help[0]!.text().length).toBeGreaterThan(15);
      expect(control.element.closest('label')).not.toBeNull();
    }
    expect(new Set(ids).size).toBe(ids.length); wrapper.unmount();
  });

  it.each(['active', 'empty', 'ended', 'not-started'])('blocks corrections when %s', state => {
    const current = snapshot();
    if (state === 'active') current.activeBeat = { id: 'active' } as DirectorSnapshot['activeBeat'];
    if (state === 'empty') current.history = [];
    if (state === 'ended') current.session.status = 'ended';
    if (state === 'not-started') current.setup = { started: false } as DirectorSnapshot['setup'];
    const wrapper = mount(CorrectionControls, { props: { snapshot: current, busy: false } });
    expect(wrapper.get(field('begin-correction')).attributes('disabled')).toBeDefined(); wrapper.unmount();
  });

  it.each([undefined, true])('explains that a practice show before its first beat has no corrections yet (setup started: %s)', started => {
    const current = snapshot();
    current.session.status = 'lobby';
    if (started !== undefined) current.setup = { started } as DirectorSnapshot['setup'];
    const wrapper = mount(CorrectionControls, { props: { snapshot: current, busy: false } });
    expect(wrapper.get('.notice').text()).toBe("Corrections start after the show's first beat. Open a conversation or an action round first.");
    expect(wrapper.get(field('begin-correction')).attributes('disabled')).toBeDefined();
    expect(wrapper.text()).not.toMatch(/session|table/i); wrapper.unmount();
  });

  it('says the show has ended when the show is over', () => {
    const current = snapshot();
    current.session.status = 'ended';
    const wrapper = mount(CorrectionControls, { props: { snapshot: current, busy: false } });
    expect(wrapper.get('.notice').text()).toBe('The show has ended.');
    expect(wrapper.get(field('begin-correction')).attributes('disabled')).toBeDefined(); wrapper.unmount();
  });

  it('uses show wording for a not-started show and a changed-show warning', async () => {
    const current = snapshot();
    current.setup = { started: false } as DirectorSnapshot['setup'];
    const notStarted = mount(CorrectionControls, { props: { snapshot: current, busy: false } });
    expect(notStarted.get('.notice').text()).toBe('Start the show before recording corrections.'); notStarted.unmount();
    const live = mount(CorrectionControls, { props: { snapshot: snapshot(), busy: false } });
    await begin(live);
    await live.setProps({ snapshot: { ...snapshot(), session: { ...snapshot().session, stateRevision: 8 } } });
    expect(live.get('.notice').text()).toContain('The show changed while you were editing.');
    expect(live.text()).not.toMatch(/session|table/i); live.unmount();
  });
});
