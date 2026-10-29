// @vitest-environment jsdom
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandSchema, LiveNpcProfileSchema, NpcSchema, ScenarioBriefSchema, allowsPremise } from '@rpg/contracts';
import type { DirectorSnapshot, FieldGenerationField } from '@rpg/contracts';
import LiveControls from './LiveControls.vue';
import FieldGenerator from './FieldGenerator.vue';
import App from './App.vue';
import { npcFieldContext } from './field-context';
import { FAKE_VOICES } from '@rpg/contracts';

const transport = vi.hoisted(() => ({ snapshot: vi.fn(), command: vi.fn(), subscribe: vi.fn(), generateField: vi.fn() }));
const voiceApi = vi.hoisted(() => ({ loadVoices: vi.fn() }));
vi.mock('./voices', async (original) => ({ ...(await original<typeof import('./voices')>()), loadVoices: voiceApi.loadVoices }));
vi.mock('./api', () => ({ api: transport, subscribeToSession: transport.subscribe }));
const npc = NpcSchema.parse({ id: 'mara', displayName: 'Mara', role: 'Keeper', locationId: 'bar', status: 'present', voiceProfileId: 'voice_mara', hiddenIdentity: 'Private identity', secrets: ['Private secret\nOnly after midnight.'], knowledge: [{ id: 'memory', statement: 'Private memory', category: 'fact', acquisition: 'scenario', sourceEventId: 'event', sourceEntityId: null, learnedBeatNumber: 0 }], relationships: [{ targetCharacterId: null, stance: 'wary', reason: 'Private relationship', sourceEventId: 'event' }], version: 3 });
const { id: npcFixtureId, version: npcFixtureVersion, knowledge: npcFixtureKnowledge, relationships: npcFixtureRelationships, ...npcProfile } = npc;
function snapshot(): DirectorSnapshot {
  return { schemaVersion: 1, role: 'director', eventSeq: 0, session: { id: 'show', title: 'Test show', stateRevision: 7, status: 'live', mode: 'conversation', beatNumber: 1, actionRoundNumber: 0, inputEpoch: 0, scene: { id: 'scene', title: 'The bar', description: 'A quiet place.', locationId: 'bar' } }, locations: [{ id: 'bar', title: 'The bar', description: '' }, { id: 'tower', title: 'The tower', description: 'High above.' }], characters: [], npcs: [npc], npcDetails: [npc, { ...npc, id: 'dax', displayName: 'Dax', status: 'offstage', locationId: 'tower' }], characterDetails: [], tracks: [], facts: [{ id: 'reveal', text: 'Mara knows the way.\nFollow her.' }], history: [], corrections: [], activeBeat: null, submissions: [], jobs: [], picturesEnabled: false, scenePicture: null, scenePictureStatus: null, actionPicture: null, pictureSettings: null, lastSceneBeatId: null, portraitJobs: [], gallery: null, directorNotes: 'Private director note' } as DirectorSnapshot;
}
function snapshotWithPremise(): DirectorSnapshot {
  const current = snapshot();
  current.session.brief = ScenarioBriefSchema.parse({ premise: 'A beacon station vanishes each dawn.', genre: 'Mystery', tone: 'Quiet tension', objectives: [], playerHooks: [], pacing: {} });
  return current;
}
const field = (id: string) => `[data-testid="${id}"]`;
async function begin(wrapper: ReturnType<typeof mount>, kind: string) { await wrapper.get(field(`begin-${kind}`)).trigger('click'); }
async function acknowledge(wrapper: ReturnType<typeof mount>) { await wrapper.get(field('live-reason')).setValue('The cast agreed.'); await wrapper.get(field('discard-input')).setValue(true); }
beforeEach(() => { vi.clearAllMocks(); transport.subscribe.mockReturnValue(() => {}); transport.command.mockResolvedValue({}); voiceApi.loadVoices.mockResolvedValue({ voices: FAKE_VOICES.map(voice => ({ ...voice })) }); });

function generator(wrapper: ReturnType<typeof mount>, name: FieldGenerationField, index = 0) {
  const found = wrapper.findAllComponents(FieldGenerator).filter(item => item.props('field') === name)[index];
  expect(found, `Generator for ${name}`).toBeDefined();
  return found!;
}
async function generateField(wrapper: ReturnType<typeof mount>, name: FieldGenerationField, seed: string, index = 0) {
  const control = generator(wrapper, name, index);
  await control.get(field('field-generator-open')).trigger('click');
  await control.get(field('field-generator-seed')).setValue(seed);
  await control.get(field('field-generator-generate')).trigger('click');
  return control;
}

describe('live field guidance', () => {
  it('explains privacy, actual prompt use, reveal publication and cancellation without changing labels', async () => {
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } });
    const help = (name: string) => {
      const control = wrapper.get(field(name));
      return wrapper.findAll('p.field-help').find(item => item.attributes('id') === control.attributes('aria-describedby'))!.text();
    };
    await begin(wrapper, 'scene');
    await wrapper.get(field('scene-location-kind')).setValue('new');
    expect(help('location-description')).toMatch(/Private catalog.*do not become the public scene/);
    expect(help('live-reason')).toMatch(/Private audit/);
    expect(help('discard-input')).toMatch(/cancellation.*in-character.*Out-of-character questions stay/);
    await begin(wrapper, 'npc');
    await wrapper.get(field('npc-choice')).setValue('mara');
    for (const key of ['aliases', 'personality', 'limits', 'dialogueExamples']) await wrapper.get(field(`add-npc-${key}`)).trigger('click');
    for (const name of ['npc-name', 'npc-role', 'npc-appearance']) expect(help(name)).toMatch(/party and stage.*offstage/);
    for (const name of ['npc-identity', 'npc-motivation', 'npc-goal', 'npc-aliases-0']) expect(help(name)).toMatch(/not automatically included in AI dialogue prompts/);
    for (const name of ['npc-mood', 'npc-channel', 'npc-personality-0', 'npc-limits-0', 'npc-dialogueExamples-0']) expect(help(name)).toMatch(/included.*AI dialogue prompts/);
    expect(help('npc-secrets-0')).toMatch(/conditions do not trigger automatic reveals/);
    expect(help('npc-voice')).toBe("Who reads this character's lines. Narrator means the narrator's voice.");
    expect(wrapper.get(field('npc-name')).element.closest('label')!.textContent).toBe('Public name');
    await begin(wrapper, 'reveal');
    expect(help('reveal-source')).toMatch(/raw text stays private/);
    expect(help('reveal-text')).toMatch(/Only this wording.*party and stage when saved.*does not rename/);
    expect(help('witness-mara')).toMatch(/memory of the public wording/);
    expect(wrapper.emitted('command')).toBeUndefined();
    wrapper.unmount();
  });

  it('describes every scene, character, list and reveal control outside its label with unique safe identifiers', async () => {
    const current = snapshot();
    current.npcDetails = ['odd id', 'odd-id', 'odd:id/雪'].map((id, index) => ({ ...npc, id, displayName: `Witness ${index}` }));
    const host = mount(defineComponent({ render: () => h('div', [h(LiveControls, { snapshot: current, busy: false }), h(LiveControls, { snapshot: current, busy: false })]) }));
    const wrappers = host.findAllComponents(LiveControls);
    const check = () => {
      const ids: string[] = [];
      for (const wrapper of wrappers) {
        for (const control of wrapper.findAll('input, select, textarea')) {
          const id = control.attributes('aria-describedby');
          expect(id, control.attributes('data-testid')).toBeTruthy();
          expect(id).not.toMatch(/\s/);
          const matches = wrapper.findAll('[id]').filter(item => item.attributes('id') === id);
          expect(matches).toHaveLength(1);
          expect(matches[0].classes()).toContain('field-help');
          expect(matches[0].element.tagName).toBe('P');
          expect(matches[0].element.closest('label')).toBeNull();
          expect(matches[0].text().length).toBeGreaterThan(15);
          ids.push(id!);
        }
      }
      expect(new Set(ids).size).toBe(ids.length);
    };
    for (const wrapper of wrappers) await begin(wrapper, 'scene');
    check();
    for (const wrapper of wrappers) await wrapper.get(field('scene-location-kind')).setValue('new');
    check();
    for (const wrapper of wrappers) {
      await begin(wrapper, 'npc');
      for (const key of ['aliases', 'personality', 'limits', 'dialogueExamples', 'secrets']) {
        await wrapper.get(field(`add-npc-${key}`)).trigger('click');
        await wrapper.get(field(`add-npc-${key}`)).trigger('click');
      }
    }
    check();
    for (const wrapper of wrappers) await wrapper.get(field('npc-choice')).setValue('odd id');
    check();
    for (const wrapper of wrappers) {
      await begin(wrapper, 'reveal');
      await wrapper.get(field('reveal-npc')).setValue('odd id');
      await wrapper.get(field('reveal-source')).setValue('identity');
    }
    check();
    for (const wrapper of wrappers) await wrapper.get(field('reveal-source')).setValue('secret:0');
    check();
    host.unmount();
  });
});

describe('live field drafting', () => {
  it('uses unsaved own NPC fields and read-only own memory for every NPC generator', async () => {
    transport.generateField.mockResolvedValue({ text: 'A suggested role' });
    const current = snapshot();
    current.npcDetails[1] = { ...current.npcDetails[1]!, secrets: ['Other NPC secret'], knowledge: [{ ...npc.knowledge[0]!, statement: 'Other NPC memory' }] };
    const before = structuredClone(current);
    const wrapper = mount(LiveControls, { props: { snapshot: current, busy: false } });
    await begin(wrapper, 'npc'); await wrapper.get(field('npc-choice')).setValue('mara');
    for (const key of ['aliases', 'personality', 'limits', 'dialogueExamples']) await wrapper.get(field(`add-npc-${key}`)).trigger('click');
    await wrapper.get(field('npc-name')).setValue('Unsaved Mara');
    await wrapper.get(field('npc-identity')).setValue('Unsaved private identity');
    await wrapper.get(field('npc-secrets-0')).setValue('Unsaved private secret');
    const expected = npcFieldContext({ ...npcProfile, displayName: 'Unsaved Mara', hiddenIdentity: 'Unsaved private identity', secrets: ['Unsaved private secret'], aliases: [''], personality: [''], limits: [''], dialogueExamples: [''] }, npc);
    const controls = wrapper.findAllComponents(FieldGenerator);
    expect(controls).toHaveLength(13);
    for (const control of controls) expect(control.props('characterContext')).toEqual(expected);
    await generateField(wrapper, 'npc.role', 'A keeper'); await flushPromises();
    expect(transport.generateField).toHaveBeenLastCalledWith({ field: 'npc.role', seed: 'A keeper', characterContext: expected });
    expect(JSON.stringify(transport.generateField.mock.calls)).not.toMatch(/Other NPC|Private director note|A quiet place|Mara knows the way|sourceEventId|learnedBeatNumber/);
    expect(current).toEqual(before); expect(wrapper.emitted('command')).toBeUndefined();
    await begin(wrapper, 'scene'); await wrapper.get(field('scene-location-kind')).setValue('new');
    for (const control of wrapper.findAllComponents(FieldGenerator)) expect(control.props('characterContext')).toBeUndefined();
    await begin(wrapper, 'reveal');
    for (const control of wrapper.findAllComponents(FieldGenerator)) expect(control.props('characterContext')).toBeUndefined();
    wrapper.unmount();
  });

  it.each(['pending', 'preview'] as const)('invalidates an NPC %s after editing an unsaved private sibling field', async phase => {
    let finish!: (value: { text: string }) => void;
    transport.generateField.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } });
    await begin(wrapper, 'npc'); await wrapper.get(field('npc-choice')).setValue('mara');
    const control = await generateField(wrapper, 'npc.role', 'A keeper');
    if (phase === 'preview') { finish({ text: 'Outdated role' }); await flushPromises(); expect(control.find(field('field-generator-preview')).exists()).toBe(true); }
    await wrapper.get(field('npc-identity')).setValue('Changed private identity');
    if (phase === 'pending') { finish({ text: 'Outdated role' }); await flushPromises(); }
    expect(control.find(field('field-generator-preview')).exists()).toBe(false);
    expect(control.props('modelValue')).toBe('Keeper'); expect(wrapper.emitted('command')).toBeUndefined(); wrapper.unmount();
  });

  it.each(['knowledge', 'relationships'] as const)('invalidates suggestions when own read-only %s changes at the same revision', async property => {
    transport.generateField.mockResolvedValueOnce({ text: 'Outdated role' });
    const current = snapshot(); const wrapper = mount(LiveControls, { props: { snapshot: current, busy: false } });
    await begin(wrapper, 'npc'); await wrapper.get(field('npc-choice')).setValue('mara');
    const control = await generateField(wrapper, 'npc.role', 'A keeper'); await flushPromises();
    expect(control.find(field('field-generator-preview')).exists()).toBe(true);
    const changed = { ...npc, ...(property === 'knowledge' ? { knowledge: [{ ...npc.knowledge[0]!, statement: 'Changed own memory' }] } : { relationships: [{ ...npc.relationships[0]!, reason: 'Changed own relationship' }] }) };
    await wrapper.setProps({ snapshot: { ...current, npcDetails: [changed, current.npcDetails[1]!] } });
    expect(control.find(field('field-generator-preview')).exists()).toBe(false);
    expect(control.props('characterContext')).toEqual(npcFieldContext(npcProfile, changed));
    expect(control.props('modelValue')).toBe('Keeper'); expect(wrapper.emitted('command')).toBeUndefined(); wrapper.unmount();
  });

  it('offers the current public session premise for scene, location, and eligible character fields without making a request', async () => {
    const current = snapshotWithPremise();
    const wrapper = mount(LiveControls, { props: { snapshot: current, busy: false } });
    await begin(wrapper, 'scene'); await wrapper.get(field('scene-location-kind')).setValue('new');
    const checkSources = async () => {
      for (const control of wrapper.findAllComponents(FieldGenerator)) {
        await control.get(field('field-generator-open')).trigger('click');
        if (allowsPremise(control.props('field'))) {
          expect((control.get(field('field-generator-source')).element as HTMLSelectElement).value).toBe('description');
          await control.get(field('field-generator-source')).setValue('premise');
          expect((control.get(field('field-generator-premise')).element as HTMLTextAreaElement).value).toBe(current.session.brief!.premise);
          expect(control.get(field('field-generator-premise')).attributes('readonly')).toBeDefined();
          expect(control.text()).toContain('Show scenario: Test show');
        } else expect(control.find(field('field-generator-source')).exists()).toBe(false);
        await control.get(field('field-generator-cancel')).trigger('click');
      }
    };
    await checkSources();
    await begin(wrapper, 'npc'); await wrapper.get(field('npc-choice')).setValue('mara');
    for (const key of ['aliases', 'personality', 'limits', 'dialogueExamples']) await wrapper.get(field(`add-npc-${key}`)).trigger('click');
    await checkSources();
    await begin(wrapper, 'reveal'); await checkSources();
    expect(transport.generateField).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('keeps legacy sessions on explicit description-only requests', async () => {
    transport.generateField.mockResolvedValue({ text: 'Keeper of the beacon' });
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } });
    await begin(wrapper, 'npc');
    const control = await generateField(wrapper, 'npc.role', 'Beacon keeper'); await flushPromises();
    expect(control.find(field('field-generator-source')).exists()).toBe(false);
    expect(transport.generateField).toHaveBeenCalledExactlyOnceWith({ field: 'npc.role', seed: 'Beacon keeper', characterContext: npcFieldContext(LiveNpcProfileSchema.parse({ displayName: 'New character', role: '', locationId: 'bar', status: 'present', voiceProfileId: 'voice_narrator' })) });
    wrapper.unmount();
  });

  it('sends the selected premise, typed hint and own private context for a character proposal', async () => {
    transport.generateField.mockResolvedValue({ text: 'Keeper of the dawn beacon' });
    const current = snapshotWithPremise();
    const wrapper = mount(LiveControls, { props: { snapshot: current, busy: false } });
    await begin(wrapper, 'npc'); await wrapper.get(field('npc-choice')).setValue('mara');
    const control = generator(wrapper, 'npc.role');
    await control.get(field('field-generator-open')).trigger('click');
    expect(transport.generateField).not.toHaveBeenCalled();
    await control.get(field('field-generator-source')).setValue('premise');
    await control.get(field('field-generator-hint')).setValue('A reluctant keeper');
    expect(transport.generateField).not.toHaveBeenCalled();
    await control.get(field('field-generator-generate')).trigger('click'); await flushPromises();
    expect(transport.generateField).toHaveBeenCalledExactlyOnceWith({ field: 'npc.role', seed: 'A reluctant keeper', premise: current.session.brief!.premise, characterContext: npcFieldContext(npcProfile, npc) });
    expect(JSON.stringify(transport.generateField.mock.calls)).not.toMatch(/Private director note|Mara knows the way|A quiet place|Dax|sourceEventId/);
    expect((wrapper.get(field('npc-role')).element as HTMLInputElement).value).toBe('Keeper');
    expect(wrapper.emitted('command')).toBeUndefined();
    await control.get(field('field-generator-apply')).trigger('click');
    expect((wrapper.get(field('npc-role')).element as HTMLInputElement).value).toBe('Keeper of the dawn beacon');
    expect(wrapper.emitted('command')).toBeUndefined(); wrapper.unmount();
  });

  it.each(['pending', 'preview'] as const)('invalidates a %s when the public premise changes at the same session revision', async phase => {
    let finish!: (value: { text: string }) => void;
    transport.generateField.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const current = snapshotWithPremise();
    const wrapper = mount(LiveControls, { props: { snapshot: current, busy: false } });
    await begin(wrapper, 'npc'); await wrapper.get(field('npc-choice')).setValue('mara');
    const control = generator(wrapper, 'npc.role');
    await control.get(field('field-generator-open')).trigger('click');
    await control.get(field('field-generator-source')).setValue('premise');
    await control.get(field('field-generator-generate')).trigger('click');
    if (phase === 'preview') { finish({ text: 'Outdated beacon keeper' }); await flushPromises(); expect(control.find(field('field-generator-preview')).exists()).toBe(true); }
    await wrapper.setProps({ snapshot: { ...current, session: { ...current.session, brief: { ...current.session.brief!, premise: 'A distant forest awaits visitors.' } } } });
    if (phase === 'pending') { finish({ text: 'Outdated beacon keeper' }); await flushPromises(); }
    expect(control.find(field('field-generator-preview')).exists()).toBe(false);
    expect(control.find(field('field-generator-apply')).exists()).toBe(false);
    expect((wrapper.get(field('npc-role')).element as HTMLInputElement).value).toBe('Keeper');
    expect(wrapper.emitted('command')).toBeUndefined(); wrapper.unmount();
  });

  it('covers creative fields beside their labels while excluding audit reasons, selectors, and voice identifiers', async () => {
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } });
    await begin(wrapper, 'scene'); await wrapper.get(field('scene-location-kind')).setValue('new');
    expect(wrapper.findAllComponents(FieldGenerator).map(control => control.props('field'))).toEqual(['location.title', 'location.description', 'scene.title', 'scene.description']);
    await begin(wrapper, 'npc');
    for (const key of ['aliases', 'personality', 'limits', 'dialogueExamples', 'secrets']) await wrapper.get(field(`add-npc-${key}`)).trigger('click');
    expect(wrapper.findAllComponents(FieldGenerator).map(control => control.props('field'))).toEqual(['npc.displayName', 'npc.role', 'npc.appearance', 'npc.hiddenIdentity', 'npc.motivation', 'npc.goal', 'npc.mood', 'npc.communicationChannel', 'npc.alias', 'npc.personalityItem', 'npc.limit', 'npc.dialogueExample', 'npc.secret']);
    for (const control of wrapper.findAllComponents(FieldGenerator)) expect(control.element.closest('label')).toBeNull();
    await begin(wrapper, 'reveal');
    expect(wrapper.findAllComponents(FieldGenerator).map(control => control.props('field'))).toEqual(['live.publicReveal']);
    wrapper.unmount();
  });

  it('previews and applies scene wording locally, then waits for the existing explicit scene save', async () => {
    transport.generateField.mockResolvedValue({ text: 'Generated harbor\n\nwith lanterns' });
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } }); await begin(wrapper, 'scene'); await acknowledge(wrapper);
    const original = (wrapper.get(field('scene-description')).element as HTMLTextAreaElement).value;
    const control = await generateField(wrapper, 'scene.description', 'A harbor at dusk'); await flushPromises();
    expect((wrapper.get(field('scene-description')).element as HTMLTextAreaElement).value).toBe(original);
    expect(wrapper.emitted('command')).toBeUndefined();
    await control.get(field('field-generator-apply')).trigger('click');
    expect((wrapper.get(field('scene-description')).element as HTMLTextAreaElement).value).toBe('Generated harbor\n\nwith lanterns');
    expect(wrapper.emitted('command')).toBeUndefined();
    expect((wrapper.get(field('live-reason')).element as HTMLTextAreaElement).value).toBe('The cast agreed.');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('command')![0][0]).toEqual(expect.objectContaining({ type: 'change_scene', description: 'Generated harbor\n\nwith lanterns' }));
    wrapper.unmount();
  });

  it('discards a pending identical list entry after deletion instead of applying it to its neighbor', async () => {
    let finish!: (value: { text: string }) => void;
    transport.generateField.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const current = snapshot(); current.npcDetails[0] = { ...current.npcDetails[0], secrets: ['Same secret', 'Same secret'] };
    const wrapper = mount(LiveControls, { props: { snapshot: current, busy: false } }); await begin(wrapper, 'npc'); await wrapper.get(field('npc-choice')).setValue('mara');
    await generateField(wrapper, 'npc.secret', 'Expand the first secret');
    await wrapper.findAll('button').find(button => button.text() === 'Remove entry 1')!.trigger('click');
    finish({ text: 'Wrong neighbor result' }); await flushPromises();
    expect((wrapper.get(field('npc-secrets-0')).element as HTMLTextAreaElement).value).toBe('Same secret');
    expect(wrapper.find(field('field-generator-preview')).exists()).toBe(false);
    expect(wrapper.emitted('command')).toBeUndefined(); wrapper.unmount();
  });

  it('discards an already-visible preview when another character with identical field text is selected', async () => {
    transport.generateField.mockResolvedValue({ text: 'Generated keeper role' });
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } }); await begin(wrapper, 'npc'); await wrapper.get(field('npc-choice')).setValue('mara');
    const control = await generateField(wrapper, 'npc.role', 'Keeper of the gate'); await flushPromises();
    expect(control.get(field('field-generator-preview')).text()).toBe('Generated keeper role');
    await wrapper.get(field('npc-choice')).setValue('dax');
    expect(wrapper.find(field('field-generator-preview')).exists()).toBe(false);
    expect((wrapper.get(field('npc-role')).element as HTMLInputElement).value).toBe('Keeper');
    expect(wrapper.emitted('command')).toBeUndefined(); wrapper.unmount();
  });

  it.each(['state revision', 'character version', 'busy'] as const)('rejects a pending draft when %s changes', async change => {
    let finish!: (value: { text: string }) => void;
    transport.generateField.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const current = snapshot(); const wrapper = mount(LiveControls, { props: { snapshot: current, busy: false } }); await begin(wrapper, 'npc'); await wrapper.get(field('npc-choice')).setValue('mara');
    await generateField(wrapper, 'npc.role', 'A new role');
    if (change === 'state revision') await wrapper.setProps({ snapshot: { ...current, session: { ...current.session, stateRevision: 8 } } });
    else if (change === 'character version') await wrapper.setProps({ snapshot: { ...current, npcDetails: current.npcDetails.map(item => item.id === 'mara' ? { ...item, version: 4 } : item) } });
    else await wrapper.setProps({ busy: true });
    finish({ text: 'Stale role' }); await flushPromises();
    expect(wrapper.find(field('field-generator-preview')).exists()).toBe(false);
    expect((wrapper.get(field('npc-role')).element as HTMLInputElement).value).toBe('Keeper');
    expect(generator(wrapper, 'npc.role').get(field('field-generator-open')).attributes('disabled')).toBeDefined();
    expect(wrapper.emitted('command')).toBeUndefined(); wrapper.unmount();
  });

  it('sends only explicit public reveal wording and invalidates its preview when the private source changes', async () => {
    transport.generateField.mockResolvedValue({ text: 'Mara opens the gate for the party.' });
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } }); await begin(wrapper, 'reveal');
    await wrapper.get(field('reveal-npc')).setValue('mara'); await wrapper.get(field('reveal-source')).setValue('secret:0');
    expect(generator(wrapper, 'live.publicReveal').props('modelValue')).toBe('');
    const control = await generateField(wrapper, 'live.publicReveal', 'Mara opens the gate'); await flushPromises();
    expect(transport.generateField).toHaveBeenCalledWith({ field: 'live.publicReveal', seed: 'Mara opens the gate' });
    expect(JSON.stringify(transport.generateField.mock.calls)).not.toContain('Private');
    expect((wrapper.get(field('reveal-text')).element as HTMLTextAreaElement).value).toBe('');
    expect(wrapper.emitted('command')).toBeUndefined();
    await wrapper.get(field('reveal-source')).setValue('identity');
    expect(control.find(field('field-generator-preview')).exists()).toBe(false);
    expect((wrapper.get(field('reveal-text')).element as HTMLTextAreaElement).value).toBe(''); wrapper.unmount();
  });
});

describe('live director controls', () => {
  it('places validation beside save and keeps the local scene draft for correction', async () => {
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } });
    await begin(wrapper, 'scene'); await acknowledge(wrapper);
    await wrapper.get(field('scene-title')).setValue('');
    await wrapper.get(field('scene-description')).setValue('Keep these unfinished scene words.');
    await wrapper.get('form').trigger('submit');
    const alert = wrapper.get('[role="alert"]');
    expect(wrapper.get(field('save-live')).element.previousElementSibling).toBe(alert.element);
    expect((wrapper.get(field('scene-description')).element as HTMLTextAreaElement).value).toBe('Keep these unfinished scene words.');
    expect(wrapper.emitted('command')).toBeUndefined();
    await wrapper.get(field('scene-title')).setValue('Corrected scene title');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.emitted('command')![0][0]).toEqual(expect.objectContaining({ title: 'Corrected scene title', description: 'Keep these unfinished scene words.' }));
    wrapper.unmount();
  });

  it.each(['collecting', 'planning', 'stakes_review', 'locked', 'rendering', 'draft_review', 'published', 'aborted'])('blocks changes with an active beat in phase %s', phase => {
    const current = snapshot(); current.activeBeat = { phase } as DirectorSnapshot['activeBeat'];
    const wrapper = mount(LiveControls, { props: { snapshot: current, busy: false } });
    expect(wrapper.get(field('begin-scene')).attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('Finish or abandon the current beat');
    wrapper.unmount();
  });
  it('requires a live or paused started session, and works for legacy sessions', async () => {
    const current = snapshot(); const wrapper = mount(LiveControls, { props: { snapshot: current, busy: false } });
    expect(wrapper.get(field('begin-scene')).attributes('disabled')).toBeUndefined();
    await wrapper.setProps({ snapshot: { ...current, session: { ...current.session, status: 'paused' } } });
    expect(wrapper.get(field('begin-scene')).attributes('disabled')).toBeUndefined();
    await wrapper.setProps({ snapshot: { ...current, setup: { started: false, boundaries: [], boundariesRevision: 0, scenario: { templateId: 'scenario', version: 1 } } } });
    expect(wrapper.get(field('begin-scene')).attributes('disabled')).toBeDefined();
    await wrapper.setProps({ snapshot: { ...current, session: { ...current.session, status: 'ended' } } });
    expect(wrapper.get(field('begin-scene')).attributes('disabled')).toBeDefined(); wrapper.unmount();
  });
  it('explains the live-change gate for a practice show before its first beat, an ended show and an unstarted setup', async () => {
    const current = snapshot(); const wrapper = mount(LiveControls, { props: { snapshot: current, busy: false } });
    const firstBeat = "Live changes start after the show's first beat. Open a conversation or an action round first.";
    await wrapper.setProps({ snapshot: { ...current, session: { ...current.session, status: 'lobby' } } });
    expect(wrapper.get(field('begin-scene')).attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain(firstBeat);
    expect(wrapper.text()).not.toContain('while the session is live or paused');
    await wrapper.setProps({ snapshot: { ...current, session: { ...current.session, status: 'lobby' }, setup: { started: true, boundaries: [], boundariesRevision: 0, scenario: { templateId: 'scenario', version: 1 } } } });
    expect(wrapper.text()).toContain(firstBeat);
    await wrapper.setProps({ snapshot: { ...current, session: { ...current.session, status: 'ended' } } });
    expect(wrapper.text()).toContain('The show has ended.');
    expect(wrapper.text()).not.toContain(firstBeat);
    await wrapper.setProps({ snapshot: { ...current, setup: { started: false, boundaries: [], boundariesRevision: 0, scenario: { templateId: 'scenario', version: 1 } } } });
    expect(wrapper.text()).toContain('Start the show from Cast & lobby before making live changes.');
    expect(wrapper.text()).not.toMatch(/\bsession\b|\btable\b/i); wrapper.unmount();
  });
  it('requires explicit input cancellation acknowledgement and emits a complete new-location scene command', async () => {
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } });
    await begin(wrapper, 'scene');
    await wrapper.get(field('scene-title')).setValue('Arrival');
    await wrapper.get(field('scene-description')).setValue('First line\n\nSecond line');
    await wrapper.get(field('scene-location-kind')).setValue('new');
    await wrapper.get(field('location-title')).setValue('New dock');
    await wrapper.get(field('location-description')).setValue('Fog\n\nAnd waves');
    await wrapper.get(field('live-reason')).setValue('Move on.');
    await wrapper.get('form').trigger('submit'); expect(wrapper.emitted('command')).toBeUndefined();
    expect(wrapper.text()).toContain('Out-of-character questions stay');
    await wrapper.get(field('discard-input')).setValue(true); await wrapper.get('form').trigger('submit');
    const command = wrapper.emitted('command')![0][0];
    expect(command).toEqual(expect.objectContaining({ type: 'change_scene', expectedStateRevision: 7, reason: 'Move on.', discardQueuedInput: true, title: 'Arrival', description: 'First line\n\nSecond line', location: { kind: 'new', title: 'New dock', description: 'Fog\n\nAnd waves' }, presentNpcIds: ['mara'] }));
    expect(CommandSchema.safeParse(command).success).toBe(true); wrapper.unmount();
  });
  it('preserves unsaved words on pushes and requires an explicit reload after state changes', async () => {
    const current = snapshot(); const wrapper = mount(LiveControls, { props: { snapshot: current, busy: false } }); await begin(wrapper, 'scene'); await acknowledge(wrapper);
    await wrapper.get(field('scene-description')).setValue('My unfinished\n\nscene');
    await wrapper.setProps({ snapshot: { ...current, session: { ...current.session, stateRevision: 8, scene: { ...current.session.scene, description: 'Saved elsewhere' } } } });
    expect((wrapper.get(field('scene-description')).element as HTMLTextAreaElement).value).toBe('My unfinished\n\nscene');
    expect(wrapper.text()).toContain('The show changed'); expect(wrapper.get(field('save-live')).attributes('disabled')).toBeDefined();
    await wrapper.get('form').trigger('submit'); expect(wrapper.emitted('command')).toBeUndefined();
    await wrapper.get(field('reload-live')).trigger('click');
    expect((wrapper.get(field('scene-description')).element as HTMLTextAreaElement).value).toBe('Saved elsewhere');
    expect((wrapper.get(field('discard-input')).element as HTMLInputElement).checked).toBe(false); wrapper.unmount();
  });
  describe('character voice pick', () => {
    async function open(id: string) {
      const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } }); await flushPromises(); await begin(wrapper, 'npc');
      await wrapper.get(field('npc-choice')).setValue(id); await acknowledge(wrapper);
      return wrapper;
    }
    const saved = (wrapper: ReturnType<typeof mount>) => (wrapper.emitted('command')![0][0] as Record<string, any>).profile.voiceProfileId;
    const choose = async (wrapper: ReturnType<typeof mount>, label: string) => {
      await wrapper.get(field('npc-voice')).findAll('button').find(button => button.text().includes(label))!.trigger('click');
    };
    it('lists Narrator and every voice, and shows a logical value as Narrator', async () => {
      const wrapper = await open('mara');
      expect(wrapper.get(field('npc-voice')).get('summary').text()).toBe('Voice: Narrator');
      expect(wrapper.get(field('npc-voice')).findAll('[data-testid="voice-option"]')).toHaveLength(3);
      expect(wrapper.get(field('npc-voice')).get('[data-testid="voice-narrator"]').text()).toContain('Narrator');
      wrapper.unmount();
    });
    it('saves a picked voice and Narrator over an eleven: value', async () => {
      const wrapper = await open('mara');
      await choose(wrapper, 'Ada');
      expect(wrapper.get(field('npc-voice')).get('summary').text()).toBe('Voice: Ada');
      await wrapper.get('form').trigger('submit');
      expect(saved(wrapper)).toBe('eleven:fake-ada');
      wrapper.unmount();
      const again = await open('mara'); await choose(again, 'Ada'); await choose(again, 'Narrator');
      await again.get('form').trigger('submit');
      expect(saved(again)).toBe('narrator');
      again.unmount();
    });
    it('keeps an untouched logical value and does not submit the form on a pick', async () => {
      const wrapper = await open('mara');
      await wrapper.get('form').trigger('submit');
      expect(saved(wrapper)).toBe('voice_mara');
      wrapper.unmount();
      const picked = await open('mara'); await choose(picked, 'Bram');
      expect(picked.emitted('command')).toBeUndefined();
      picked.unmount();
    });
  });
  it('edits an NPC with the captured version, preserving multiline entries and excluding memory and relationships', async () => {
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } }); await begin(wrapper, 'npc');
    await wrapper.get(field('npc-choice')).setValue('mara'); await acknowledge(wrapper);
    expect(wrapper.text()).toContain('Private memory'); expect(wrapper.text()).toContain('Private relationship');
    await wrapper.get(field('npc-secrets-0')).setValue('First sentence\n\nSecond sentence');
    await wrapper.get(field('npc-appearance')).setValue('Coat\n\nBoots');
    await wrapper.get('form').trigger('submit');
    const command = wrapper.emitted('command')![0][0] as Record<string, any>;
    expect(command).toEqual(expect.objectContaining({ type: 'save_npc', npcId: 'mara', expectedNpcVersion: 3, expectedStateRevision: 7, profile: expect.objectContaining({ appearance: 'Coat\n\nBoots', secrets: ['First sentence\n\nSecond sentence'] }) }));
    expect(command.profile).not.toHaveProperty('knowledge'); expect(command.profile).not.toHaveProperty('relationships'); expect(command.profile).not.toHaveProperty('id'); expect(CommandSchema.safeParse(command).success).toBe(true); wrapper.unmount();
  });
  it('creates an NPC without exposing entity identifier inputs', async () => {
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } }); await begin(wrapper, 'npc'); await acknowledge(wrapper);
    await wrapper.get(field('npc-name')).setValue('New arrival'); await wrapper.get('form').trigger('submit');
    const command = wrapper.emitted('command')![0][0]; expect(command).toEqual(expect.objectContaining({ type: 'save_npc', expectedNpcVersion: 0 })); expect(command).not.toHaveProperty('npcId'); expect(CommandSchema.safeParse(command).success).toBe(true); wrapper.unmount();
  });
  it('keeps public reveal wording blank, requires an explicit source, and offers only present local witnesses', async () => {
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } }); await begin(wrapper, 'reveal');
    await wrapper.get(field('reveal-npc')).setValue('mara'); await acknowledge(wrapper);
    expect((wrapper.get(field('reveal-text')).element as HTMLTextAreaElement).value).toBe('');
    await wrapper.get(field('reveal-text')).setValue('Mara opens the gate.\nFollow her.'); await wrapper.get('form').trigger('submit'); expect(wrapper.emitted('command')).toBeUndefined();
    await wrapper.get(field('reveal-source')).setValue('secret:0');
    expect((wrapper.get(field('reveal-text')).element as HTMLTextAreaElement).value).toBe('Mara opens the gate.\nFollow her.');
    expect(wrapper.find(field('witness-dax')).exists()).toBe(false); await wrapper.get(field('witness-mara')).setValue(true);
    await wrapper.get('form').trigger('submit'); const command = wrapper.emitted('command')![0][0];
    expect(command).toEqual(expect.objectContaining({ type: 'reveal_npc', npcId: 'mara', expectedNpcVersion: 3, source: { kind: 'secret', index: 0 }, publicText: 'Mara opens the gate.\nFollow her.', witnessNpcIds: ['mara'] }));
    expect(JSON.stringify(command)).not.toContain('Private secret'); expect(CommandSchema.safeParse(command).success).toBe(true); wrapper.unmount();
  });
  it('closes only a confirmed save and retains the draft when no success is reported', async () => {
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } }); await begin(wrapper, 'scene'); await acknowledge(wrapper);
    await wrapper.get(field('scene-description')).setValue('Keep my words on failure.'); await wrapper.get('form').trigger('submit');
    expect((wrapper.get(field('scene-description')).element as HTMLTextAreaElement).value).toBe('Keep my words on failure.');
    const confirmSaved = wrapper.emitted('command')![0][1] as () => void;
    expect(confirmSaved).toBeTypeOf('function'); confirmSaved(); await flushPromises();
    expect(wrapper.find('form').exists()).toBe(false); expect(wrapper.text()).toContain('Scene changed.'); wrapper.unmount();
  });
  it('keeps the selected NPC version stale and words intact until explicit reload', async () => {
    const current = snapshot(); const wrapper = mount(LiveControls, { props: { snapshot: current, busy: false } });
    await begin(wrapper, 'npc'); await wrapper.get(field('npc-choice')).setValue('mara'); await acknowledge(wrapper);
    await wrapper.get(field('npc-name')).setValue('My unfinished name');
    await wrapper.setProps({ snapshot: { ...current, npcDetails: current.npcDetails.map(item => item.id === 'mara' ? { ...item, version: 4, displayName: 'Changed elsewhere' } : item) } });
    expect((wrapper.get(field('npc-name')).element as HTMLInputElement).value).toBe('My unfinished name');
    await wrapper.get('form').trigger('submit'); expect(wrapper.emitted('command')).toBeUndefined();
    await wrapper.get(field('reload-live')).trigger('click'); await acknowledge(wrapper); await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('command')![0][0]).toEqual(expect.objectContaining({ npcId: 'mara', expectedNpcVersion: 4, profile: expect.objectContaining({ displayName: 'Changed elsewhere' }) })); wrapper.unmount();
  });
  it('publishes identity wording without renaming or copying the private identity', async () => {
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } }); await begin(wrapper, 'reveal');
    await wrapper.get(field('reveal-npc')).setValue('mara'); await wrapper.get(field('reveal-source')).setValue('identity');
    expect((wrapper.get(field('reveal-text')).element as HTMLTextAreaElement).value).toBe('');
    expect(wrapper.text()).toContain('does not rename');
    await wrapper.get(field('reveal-text')).setValue('Mara once served the queen.'); await acknowledge(wrapper); await wrapper.get('form').trigger('submit');
    const command = wrapper.emitted('command')![0][0]; expect(command).toEqual(expect.objectContaining({ type: 'reveal_npc', source: { kind: 'identity' }, publicText: 'Mara once served the queen.', witnessNpcIds: [] }));
    expect(JSON.stringify(command)).not.toContain('Private identity'); wrapper.unmount();
  });
  it('uses selected destination and cast for an existing location and resets acknowledgement on switching forms', async () => {
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } }); await begin(wrapper, 'scene'); await acknowledge(wrapper);
    await wrapper.get(field('scene-location')).setValue('tower'); await wrapper.get(field('present-mara')).setValue(false); await wrapper.get(field('present-dax')).setValue(true); await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('command')![0][0]).toEqual(expect.objectContaining({ type: 'change_scene', location: { kind: 'existing', locationId: 'tower' }, presentNpcIds: ['dax'] }));
    await begin(wrapper, 'npc'); expect((wrapper.get(field('discard-input')).element as HTMLInputElement).checked).toBe(false); expect((wrapper.get(field('live-reason')).element as HTMLTextAreaElement).value).toBe(''); wrapper.unmount();
  });
  it('disables draft switches and all edits while saving', async () => {
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } }); await begin(wrapper, 'npc'); await wrapper.setProps({ busy: true });
    expect(wrapper.get(field('begin-scene')).attributes('disabled')).toBeDefined(); expect(wrapper.get(field('npc-choice')).attributes('disabled')).toBeDefined(); expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined();
    await wrapper.get(field('begin-scene')).trigger('click'); expect(wrapper.find(field('npc-name')).exists()).toBe(true); wrapper.unmount();
  });
});

describe('published reveals in every audience', () => {
  it.each([true, false])('clears an App live draft only after confirmed command success: %s', async accepted => {
    window.history.replaceState({}, '', '/sessions/show/director'); const current = snapshot(); transport.snapshot.mockResolvedValue(current);
    const wrapper = mount(App); await flushPromises(); const controls = wrapper.getComponent(LiveControls);
    await controls.get(field('begin-scene')).trigger('click'); await controls.get(field('scene-description')).setValue('Unsaved scene words');
    await controls.get(field('live-reason')).setValue('The cast agreed.'); await controls.get(field('discard-input')).setValue(true);
    if (accepted) transport.snapshot.mockResolvedValue({ ...current, session: { ...current.session, stateRevision: 8 } });
    else transport.command.mockRejectedValueOnce(new Error('The scene could not be saved.'));
    await controls.get('form').trigger('submit'); await flushPromises();
    if (accepted) { expect(controls.find('form').exists()).toBe(false); expect(controls.text()).toContain('Scene changed.'); expect(controls.text()).not.toContain('The show changed'); }
    else { expect((controls.get(field('scene-description')).element as HTMLTextAreaElement).value).toBe('Unsaved scene words'); expect(wrapper.get('[role="alert"]').text()).toContain('The scene could not be saved.'); }
    wrapper.unmount();
  });
  it.each(['director', 'player', 'stage'])('renders public facts for %s without leaking source material', async role => {
    window.history.replaceState({}, '', `/sessions/show/${role === 'player' ? 'play' : role}`);
    const current = snapshot(); transport.snapshot.mockResolvedValue({ ...current, role, ...(role === 'player' ? { ownCharacter: null } : {}) });
    const wrapper = mount(App); await flushPromises();
    if (role === 'player') expect(wrapper.find(field('public-facts')).exists()).toBe(false);
    else {
      expect(wrapper.get(field('public-facts')).text()).toContain('Mara knows the way.\nFollow her.');
      expect(wrapper.get(field('public-facts')).text()).not.toContain('Private');
    }
    expect(wrapper.find(field('live-controls')).exists()).toBe(role === 'director');
    if (role !== 'director') { expect(wrapper.text()).not.toContain('Private secret'); expect(wrapper.text()).not.toContain('Private identity'); }
    wrapper.unmount();
  });
});

describe('scene title follows the chosen place', () => {
  const title = (wrapper: ReturnType<typeof mount>) => (wrapper.get(field('scene-title')).element as HTMLInputElement).value;
  it('sets the title to the picked place and the typed new place name, never copying private notes', async () => {
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } });
    await begin(wrapper, 'scene');
    expect(title(wrapper)).toBe('The bar');
    await wrapper.get(field('scene-location')).setValue('tower');
    expect(title(wrapper)).toBe('The tower');
    expect((wrapper.get(field('scene-description')).element as HTMLTextAreaElement).value).toBe('A quiet place.');
    await wrapper.get(field('scene-location-kind')).setValue('new');
    await wrapper.get(field('location-title')).setValue('Harbor');
    await wrapper.get(field('location-description')).setValue('Private harbor notes');
    expect(title(wrapper)).toBe('Harbor');
    expect(wrapper.text()).toContain('The title becomes public when you save.');
    expect(title(wrapper)).not.toContain('Private'); expect(title(wrapper)).not.toContain('High above');
    wrapper.unmount();
  });
  it('keeps a typed title when a place is picked later, and a new scene form starts following again', async () => {
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } });
    await begin(wrapper, 'scene');
    await wrapper.get(field('scene-title')).setValue('My own title');
    await wrapper.get(field('scene-location')).setValue('tower');
    expect(title(wrapper)).toBe('My own title');
    await begin(wrapper, 'scene');
    await wrapper.get(field('scene-location')).setValue('tower');
    expect(title(wrapper)).toBe('The tower');
    wrapper.unmount();
  });
  it('warns while the description still describes the current place and hides once edited', async () => {
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } });
    await begin(wrapper, 'scene');
    expect(wrapper.find(field('scene-description-stale')).exists()).toBe(false);
    await wrapper.get(field('scene-location')).setValue('tower');
    expect(wrapper.get(field('scene-description-stale')).text()).toBe('The description still describes The bar. Update it so the stream, players and AI see the new place.');
    await wrapper.get(field('scene-description')).setValue('Wind and stone.');
    expect(wrapper.find(field('scene-description-stale')).exists()).toBe(false);
    wrapper.unmount();
  });
  it('names who moves with the party and emits the new title in the scene change', async () => {
    const wrapper = mount(LiveControls, { props: { snapshot: snapshot(), busy: false } });
    await begin(wrapper, 'scene'); await acknowledge(wrapper);
    expect(wrapper.get(field('scene-movers')).text()).toBe('Moving with the party: Mara');
    await wrapper.get(field('present-dax')).setValue(true);
    expect(wrapper.get(field('scene-movers')).text()).toBe('Moving with the party: Mara, Dax');
    await wrapper.get(field('scene-location')).setValue('tower');
    await wrapper.get(field('scene-description')).setValue('Wind and stone.');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('command')![0][0]).toEqual(expect.objectContaining({ type: 'change_scene', title: 'The tower', description: 'Wind and stone.', location: { kind: 'existing', locationId: 'tower' } }));
    wrapper.unmount();
  });
});
