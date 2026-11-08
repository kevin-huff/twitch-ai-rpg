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
    expect(command(wrapper)).toEqual({ type: 'record_correction', commandId: expect.any(String), expectedStateRevision: 7, publishedBeatId: 'beat-1', publicText: 'The bridge is open; the earlier narration was mistaken.', reason: 'I misread the scenario.', changes: [] });
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

  it('accepts strain up to the maximum of 8 and refuses 9', async () => {
    const wrapper = mount(CorrectionControls, { props: { snapshot: snapshot(), busy: false } }); await begin(wrapper); await common(wrapper);
    await wrapper.get(field('add-correction-strain')).trigger('click');
    expect(wrapper.get(field('correction-value-0')).attributes('max')).toBe('8');
    await wrapper.get(field('correction-value-0')).setValue('9');
    await wrapper.get(field('save-correction')).trigger('click');
    expect(wrapper.emitted('command')).toBeUndefined(); expect(wrapper.get('[role="alert"]').text()).toContain('0 to 8');
    await wrapper.get(field('correction-value-0')).setValue('8');
    await wrapper.get(field('save-correction')).trigger('click');
    expect(command(wrapper)).toMatchObject({ changes: [{ kind: 'strain_set', characterId: 'aster', value: 8 }] }); wrapper.unmount();
  });

  it('reports missing words and no-op changes at Save without losing words', async () => {
    const wrapper = mount(CorrectionControls, { props: { snapshot: snapshot(), busy: false } }); await begin(wrapper);
    await wrapper.get(field('save-correction')).trigger('click');
    expect(wrapper.get('[role="alert"]').text()).toMatch(/public correction|reason/i);
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

  const R1 = 'A round is open. Saving this sends it back to taking lines and throws away its plan, even one the AI is still making. Press Plan to plan it again. That is another AI call.';
  const R3 = 'The dice for this round are already rolled. Publish or abandon the round, then record the correction.';
  const withPhase = (phase: string) => { const current = snapshot(); current.activeBeat = { id: 'active', phase } as unknown as DirectorSnapshot['activeBeat']; return current; };

  const SAVED_PLAN = 'Correction published. Earlier narration and dice remain unchanged. The round went back to taking lines. Press Plan to plan it again.';
  const planJob = (status: string) => ({ id: 'job', beatId: 'active', task: 'plan', generation: 1, status, error: null });
  async function saveWith(current: DirectorSnapshot) {
    const wrapper = mount(CorrectionControls, { props: { snapshot: current, busy: false } });
    expect(wrapper.get(field('begin-correction')).attributes('disabled')).toBeUndefined();
    await begin(wrapper); await common(wrapper);
    await wrapper.get(field('save-correction')).trigger('click');
    expect(command(wrapper)).toMatchObject({ type: 'record_correction' });
    (wrapper.emitted('command')![0]![1] as () => void)();
    await wrapper.vm.$nextTick();
    return wrapper;
  }

  it('is usable while a round is only taking lines and mentions no plan', async () => {
    const wrapper = await saveWith(withPhase('collecting'));
    expect(wrapper.find(field('correction-round-open')).exists()).toBe(false);
    expect(wrapper.get('[role="status"]').text()).toBe('Correction published. Earlier narration and dice remain unchanged.');
    wrapper.unmount();
  });

  it('shows the round-open note and the plan sentence while a plan job is queued or running', async () => {
    for (const status of ['queued', 'running']) {
      const current = withPhase('collecting'); current.jobs = [planJob(status)] as unknown as DirectorSnapshot['jobs'];
      const wrapper = mount(CorrectionControls, { props: { snapshot: current, busy: false } });
      expect(wrapper.get(field('correction-round-open')).text()).toBe(R1); wrapper.unmount();
      const saved = await saveWith(current);
      expect(saved.get('[role="status"]').text()).toBe(SAVED_PLAN); saved.unmount();
    }
  });

  it('ignores finished plan jobs and render jobs when the round is only taking lines', () => {
    const current = withPhase('collecting');
    current.jobs = [planJob('succeeded'), { ...planJob('running'), task: 'render' }, { ...planJob('running'), beatId: 'other' }] as unknown as DirectorSnapshot['jobs'];
    const wrapper = mount(CorrectionControls, { props: { snapshot: current, busy: false } });
    expect(wrapper.find(field('correction-round-open')).exists()).toBe(false); wrapper.unmount();
  });

  it('shows the round-open note and the plan sentence during stakes review', async () => {
    const current = withPhase('stakes_review');
    const wrapper = mount(CorrectionControls, { props: { snapshot: current, busy: false } });
    expect(wrapper.get(field('correction-round-open')).text()).toBe(R1); wrapper.unmount();
    const saved = await saveWith(current);
    expect(saved.get('[role="status"]').text()).toBe(SAVED_PLAN); saved.unmount();
  });

  it.each(['locked', 'draft_review'])('refuses with the rolled-dice text when a round is %s', phase => {
    const wrapper = mount(CorrectionControls, { props: { snapshot: withPhase(phase), busy: false } });
    expect(wrapper.get('.notice').text()).toBe(R3);
    expect(wrapper.get(field('begin-correction')).attributes('disabled')).toBeDefined();
    expect(wrapper.find(field('correction-round-open')).exists()).toBe(false); wrapper.unmount();
  });

  it('shows no round-open note between rounds and keeps the plain saved notice', async () => {
    const wrapper = mount(CorrectionControls, { props: { snapshot: snapshot(), busy: false } });
    expect(wrapper.find(field('correction-round-open')).exists()).toBe(false);
    await begin(wrapper); await common(wrapper);
    await wrapper.get(field('save-correction')).trigger('click');
    (wrapper.emitted('command')![0]![1] as () => void)();
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[role="status"]').text()).toBe('Correction published. Earlier narration and dice remain unchanged.'); wrapper.unmount();
  });

  it('draws a strain bar for the value being set', async () => {
    const wrapper = mount(CorrectionControls, { props: { snapshot: snapshot(), busy: false } }); await begin(wrapper);
    await wrapper.get(field('add-correction-strain')).trigger('click');
    await wrapper.get(field('correction-value-0')).setValue('5');
    expect(wrapper.get(field('strain-meter-text')).text()).toContain('Strain 5 of 8'); wrapper.unmount();
  });

  it.each(['empty', 'ended', 'not-started'])('blocks corrections when %s', state => {
    const current = snapshot();
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

  describe('conditions', () => {
    function withConditions(): DirectorSnapshot {
      const current = snapshot();
      current.characters = [
        { ...current.characters[0]! },
        { ...current.characters[0]!, id: 'bram', displayName: 'Bram', condition: 'down' },
        { ...current.characters[0]!, id: 'cora', displayName: 'Cora', condition: 'dead' },
      ] as DirectorSnapshot['characters'];
      current.npcDetails = [npc, { ...npc, id: 'dax', displayName: 'Dax', condition: 'dead', status: 'offstage' }] as DirectorSnapshot['npcDetails'];
      return current;
    }
    const optionLabels = (wrapper: ReturnType<typeof mount>, testid: string) => wrapper.findAll(`${field(testid)} option`).map(option => option.text());

    it('brings back a downed character with the right words and payload', async () => {
      const wrapper = mount(CorrectionControls, { props: { snapshot: withConditions(), busy: false } }); await begin(wrapper); await common(wrapper);
      await wrapper.get(field('add-correction-condition')).trigger('click');
      expect(wrapper.get('h4').text()).toBe('Set a condition');
      await wrapper.get(field('correction-target-0')).setValue('character:bram');
      expect(optionLabels(wrapper, 'correction-condition-0')).toEqual(['Bring back', 'Dead']);
      expect(wrapper.get(field('correction-change-preview-0')).text()).toBe('Down becomes Up');
      await wrapper.get(field('save-correction')).trigger('click');
      expect(command(wrapper)).toMatchObject({ changes: [{ kind: 'condition_set', characterId: 'bram', condition: 'up' }] });
      expect(CommandSchema.safeParse(command(wrapper)).success).toBe(true); wrapper.unmount();
    });

    it('sets Down on a character who is up and offers only different conditions', async () => {
      const wrapper = mount(CorrectionControls, { props: { snapshot: withConditions(), busy: false } }); await begin(wrapper); await common(wrapper);
      await wrapper.get(field('add-correction-condition')).trigger('click');
      expect((wrapper.get(field('correction-target-0')).element as HTMLSelectElement).value).toBe('character:aster');
      expect(optionLabels(wrapper, 'correction-condition-0')).toEqual(['Down', 'Dead']);
      expect(wrapper.get(field('correction-change-preview-0')).text()).toBe('Up becomes Down');
      await wrapper.get(field('save-correction')).trigger('click');
      expect(command(wrapper)).toMatchObject({ changes: [{ kind: 'condition_set', characterId: 'aster', condition: 'down' }] });
      await wrapper.get(field('correction-condition-0')).setValue('dead');
      expect(wrapper.get(field('correction-change-preview-0')).text()).toBe('Up becomes Dead');
      await wrapper.get(field('save-correction')).trigger('click');
      expect(command(wrapper, 1)).toMatchObject({ changes: [{ kind: 'condition_set', characterId: 'aster', condition: 'dead' }] }); wrapper.unmount();
    });

    it('lists players then non-player characters in two groups and offers a dead character Bring back and Down', async () => {
      const wrapper = mount(CorrectionControls, { props: { snapshot: withConditions(), busy: false } }); await begin(wrapper);
      await wrapper.get(field('add-correction-condition')).trigger('click');
      const groups = wrapper.findAll(`${field('correction-target-0')} optgroup`);
      expect(groups.map(group => group.attributes('label'))).toEqual(["Players' characters", 'Non-player characters']);
      expect(groups[0]!.findAll('option').map(option => option.text())).toEqual(['Aster', 'Bram', 'Cora']);
      expect(groups[1]!.findAll('option').map(option => option.text())).toEqual(['Mara', 'Dax']);
      await wrapper.get(field('correction-target-0')).setValue('character:cora');
      expect(optionLabels(wrapper, 'correction-condition-0')).toEqual(['Bring back', 'Down']);
      expect(wrapper.get(field('correction-change-preview-0')).text()).toBe('Dead becomes Up'); wrapper.unmount();
    });

    it('sets Dead on a non-player character and brings a dead one back', async () => {
      const wrapper = mount(CorrectionControls, { props: { snapshot: withConditions(), busy: false } }); await begin(wrapper); await common(wrapper);
      await wrapper.get(field('add-correction-condition')).trigger('click');
      await wrapper.get(field('correction-target-0')).setValue('npc:mara');
      expect(optionLabels(wrapper, 'correction-condition-0')).toEqual(['Dead']);
      expect(wrapper.get(field('correction-change-preview-0')).text()).toBe('Alive becomes Dead');
      await wrapper.get(field('add-correction-condition')).trigger('click');
      await wrapper.get(field('correction-target-1')).setValue('npc:dax');
      expect(optionLabels(wrapper, 'correction-condition-1')).toEqual(['Bring back']);
      expect(wrapper.get(field('correction-change-preview-1')).text()).toBe('Dead becomes Alive');
      await wrapper.get(field('save-correction')).trigger('click');
      expect(command(wrapper)).toMatchObject({ changes: [{ kind: 'npc_condition_set', npcId: 'mara', condition: 'dead' }, { kind: 'npc_condition_set', npcId: 'dax', condition: 'alive' }] });
      expect(CommandSchema.safeParse(command(wrapper)).success).toBe(true); wrapper.unmount();
    });

    it('allows one change per target and disables a target already chosen', async () => {
      const wrapper = mount(CorrectionControls, { props: { snapshot: withConditions(), busy: false } }); await begin(wrapper);
      await wrapper.get(field('add-correction-condition')).trigger('click');
      await wrapper.get(field('add-correction-condition')).trigger('click');
      expect((wrapper.get(field('correction-target-1')).element as HTMLSelectElement).value).toBe('character:bram');
      expect(wrapper.get(`${field('correction-target-1')} option[value="character:aster"]`).attributes('disabled')).toBeDefined();
      expect(wrapper.get(`${field('correction-target-0')} option[value="character:bram"]`).attributes('disabled')).toBeDefined();
      expect(wrapper.get(`${field('correction-target-0')} option[value="npc:mara"]`).attributes('disabled')).toBeUndefined();
      const only = snapshot(); only.characters = [only.characters[0]!]; only.npcDetails = [npc];
      const small = mount(CorrectionControls, { props: { snapshot: only, busy: false } }); await begin(small);
      await small.get(field('add-correction-condition')).trigger('click');
      await small.get(field('add-correction-condition')).trigger('click');
      expect((small.get(field('correction-target-1')).element as HTMLSelectElement).value).toBe('npc:mara');
      expect(small.get(field('add-correction-condition')).attributes('disabled')).toBeDefined();
      await small.get(field('add-correction-condition')).trigger('click');
      expect(small.findAll('[data-testid^="correction-target-"]')).toHaveLength(2);
      expect(small.get(field('add-correction-condition')).attributes('disabled')).toBeDefined();
      wrapper.unmount(); small.unmount();
    });

    it('gives each new select its own help line for players and for non-player characters', async () => {
      const wrapper = mount(CorrectionControls, { props: { snapshot: withConditions(), busy: false } }); await begin(wrapper);
      await wrapper.get(field('add-correction-condition')).trigger('click');
      await wrapper.get(field('add-correction-condition')).trigger('click');
      await wrapper.get(field('correction-target-1')).setValue('npc:mara');
      const help = (testid: string) => wrapper.findAll(`#${CSS.escape(wrapper.get(field(testid)).attributes('aria-describedby')!)}`);
      const player = help('correction-condition-0'); expect(player).toHaveLength(1);
      expect(player[0]!.classes()).toContain('field-help');
      expect(player[0]!.text()).toBe('Bring back sets Aster up again with their strain as it is now. Down starts a rescue window that closes when the next dice are rolled. Dead takes Aster out of the story until a correction brings them back.');
      const other = help('correction-condition-1'); expect(other).toHaveLength(1);
      expect(other[0]!.text()).toBe('Dead takes Mara off stage, and nobody can speak with them until a correction brings them back. Bring back leaves them offstage; tick them in Who is here to bring them on.');
      const ids = wrapper.findAll('input, select, textarea').map(control => control.attributes('aria-describedby')!);
      expect(new Set(ids).size).toBe(ids.length);
      for (const control of wrapper.findAll('input, select, textarea')) {
        const match = wrapper.findAll('[id]').filter(item => item.attributes('id') === control.attributes('aria-describedby'));
        expect(match).toHaveLength(1); expect(match[0]!.text().length).toBeGreaterThan(20);
        expect(match[0]!.classes()).toContain('field-help'); expect(control.element.closest('label')).not.toBeNull();
      }
      wrapper.unmount();
    });

    it('mentions conditions in the panel intro', () => {
      const wrapper = mount(CorrectionControls, { props: { snapshot: snapshot(), busy: false } });
      expect(wrapper.find('details > p').text()).toContain('who is down or dead'); wrapper.unmount();
    });
  });
});
