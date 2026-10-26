// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { MAX_NATIVE_BYTES, NpcDefinitionSchema, PICTURE_MODELS, ScenarioDefinitionSchema } from '@rpg/contracts';
import Library from './Library.vue';
import CharacterForm from './CharacterForm.vue';
import ScenarioGenerator from './ScenarioGenerator.vue';
import { characterFieldContext, npcFieldContext } from './field-context';

const transport = vi.hoisted(() => ({ library: vi.fn(), starter: vi.fn(), saveScenario: vi.fn(), saveCharacterTemplate: vi.fn(), createCustom: vi.fn(), generateField: vi.fn(), generateCard: vi.fn(), startScenarioDraft: vi.fn(), scenarioDraft: vi.fn(), createLibraryPortrait: vi.fn() }));
vi.mock('./api', () => ({ api: transport }));

const card = { schemaVersion: 1, displayName: 'Aster', pronouns: 'they/them', appearance: 'A silver coat.', personality: 'Patient.', backstory: 'A former courier.', traits: { force: 0, finesse: 2, wits: 1, presence: 1 }, specialty: 'Navigation', flaw: 'Distrustful', possessions: ['Map', 'Compass', 'Coat'], connection: 'Owes the crew a favor.', secret: 'The map is a forgery.', extensions: {} };
const scenario = { schemaVersion: 1, title: 'The Glass Moon', premise: 'Recover a lost observatory.', genre: 'Science fantasy', tone: 'Hopeful mystery', boundaries: ['No harm to children.'], locations: [{ id: 'tower', title: 'Observatory', description: 'A cold dome.' }], openingScene: { id: 'arrival', title: 'A locked door', description: 'The crew reaches the tower.', locationId: 'tower' }, npcs: [], tracks: [], facts: [], playerHooks: ['An old debt.'], objectives: ['Enter the observatory.'], discoveries: [], opportunities: [], directorNotes: 'The telescope is alive.', rulesVersion: '0.1', pacing: { conversationWords: 90, actionWords: 120 }, extensions: {} };
const libraryNpc = NpcDefinitionSchema.parse({ id: 'mara', displayName: 'Mara', role: 'Keeper', locationId: 'tower', status: 'present', voiceProfileId: 'voice_mara', hiddenIdentity: 'Own private identity', secrets: ['Own private secret'], knowledge: [{ statement: 'Own memory', category: 'belief' }], partyRelationship: { stance: 'wary', reason: 'Own relationship' } });
const fieldControl = (wrapper: ReturnType<typeof mount>, field: string, index = 0) => wrapper.findAllComponents({ name: 'FieldGenerator' }).filter(control => control.props('field') === field)[index]!;
async function generate(wrapper: ReturnType<typeof mount>, field: string, seed: string, index = 0) {
  const control = fieldControl(wrapper, field, index);
  await control.get('[data-testid="field-generator-open"]').trigger('click');
  await control.get('[data-testid="field-generator-seed"]').setValue(seed);
  await control.get('[data-testid="field-generator-generate"]').trigger('click');
  await flushPromises();
  return control;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', `/library?identity=${'a'.repeat(32)}`);
  transport.library.mockResolvedValue({ scenarios: [{ id: 'scenario-one', version: 2, definition: scenario }], characters: [{ id: 'card-one', version: 1, definition: card }] });
  transport.starter.mockResolvedValue({ scenario, characters: [card] });
  transport.saveScenario.mockResolvedValue({ id: 'scenario-one', version: 3, definition: scenario });
  transport.saveCharacterTemplate.mockResolvedValue({ id: 'card-new', version: 1, definition: card });
  transport.generateField.mockReset().mockResolvedValue({ text: 'A suggested detail.' });
  transport.generateCard.mockReset();
  transport.startScenarioDraft.mockReset();
  transport.scenarioDraft.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('native scenario and character library', () => {
  it('refreshes submitted player cards from the invitation manager without replacing unsaved scenario edits', async () => {
    const wrapper = mount(Library, { global: { stubs: { BuilderInvites: true } } });
    await flushPromises();
    const manager = wrapper.findComponent({ name: 'BuilderInvites' });
    expect(manager.exists()).toBe(true);
    await wrapper.get('[data-testid="scenario-title"]').setValue('Keep my unsaved scenario');
    transport.library.mockResolvedValue({ scenarios: [], characters: [{ id: 'submitted-player', version: 1, definition: { ...card, displayName: 'Player-built Aster' } }] });
    manager.vm.$emit('refresh-library');
    await flushPromises();
    expect(wrapper.get('[data-testid="edit-character-submitted-player"]').text()).toContain('Player-built Aster');
    expect((wrapper.get('[data-testid="scenario-title"]').element as HTMLInputElement).value).toBe('Keep my unsaved scenario');
    wrapper.unmount();
  });

  it.each(['schema', 'request'])('keeps the scenario draft when a %s save error is dismissed and retried', async failure => {
    const wrapper = mount(Library); await flushPromises();
    await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
    const title = wrapper.get('[data-testid="scenario-title"]');
    await title.setValue(failure === 'schema' ? '' : 'My unsaved title.');
    if (failure === 'request') transport.saveScenario.mockRejectedValueOnce(new Error('Save unavailable.'));
    await wrapper.get('[data-testid="save-scenario"]').trigger('click'); await flushPromises();
    const alert = wrapper.get('[role="alert"]');
    expect(alert.text().length).toBeGreaterThan(0);
    await alert.get('button[aria-label="Dismiss error"]').trigger('click');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect((title.element as HTMLInputElement).value).toBe(failure === 'schema' ? '' : 'My unsaved title.');
    if (failure === 'schema') await title.setValue('My corrected title.');
    await wrapper.get('[data-testid="save-scenario"]').trigger('click'); await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(transport.saveScenario).toHaveBeenLastCalledWith(expect.objectContaining({ definition: expect.objectContaining({ title: failure === 'schema' ? 'My corrected title.' : 'My unsaved title.' }) }));
    wrapper.unmount();
  });

  it('sends current own NPC context for every NPC generator and keeps other entities out', async () => {
    const saved = { ...scenario, npcs: [libraryNpc, { ...libraryNpc, id: 'other', displayName: 'Other NPC', secrets: ['Other private secret'] }] };
    const before = structuredClone(saved);
    transport.library.mockResolvedValue({ scenarios: [{ id: 'scenario-one', version: 2, definition: saved }], characters: [] });
    const wrapper = mount(Library); await flushPromises();
    await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
    const row = wrapper.findAll('article').find(article => article.findAll('label').some(label => label.text() === 'Name'))!;
    const input = (label: string) => row.findAll('label').find(item => item.text().startsWith(label))!.get('input, textarea, select');
    await input('Name').setValue('Unsaved Mara');
    await input('Hidden identity').setValue('Unsaved private identity');
    await input('What this character knows').setValue('Unsaved own memory');
    await input('Knowledge type').setValue('claim');
    await input('Relationship reason').setValue('Unsaved own relationship');
    const expected = npcFieldContext({ ...libraryNpc, displayName: 'Unsaved Mara', hiddenIdentity: 'Unsaved private identity', knowledge: [{ statement: 'Unsaved own memory', category: 'claim' }], partyRelationship: { stance: 'wary', reason: 'Unsaved own relationship' } });
    const firstNpcControls = wrapper.findAllComponents({ name: 'FieldGenerator' }).filter(control => control.props('field').startsWith('npc.')).slice(0, 15);
    expect(firstNpcControls).toHaveLength(15);
    for (const control of firstNpcControls) expect(control.props('characterContext')).toEqual(expected);
    for (const control of wrapper.findAllComponents({ name: 'FieldGenerator' }).filter(control => !control.props('field').startsWith('npc.'))) expect(control.props('characterContext')).toBeUndefined();
    await generate(wrapper, 'npc.role', 'A keeper');
    expect(transport.generateField).toHaveBeenLastCalledWith({ field: 'npc.role', seed: 'A keeper', characterContext: expected });
    expect(JSON.stringify(transport.generateField.mock.calls)).not.toMatch(/Other NPC|Other private secret|The telescope is alive|A cold dome|The crew reaches the tower/);
    expect(saved).toEqual(before); expect(transport.saveScenario).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it.each(['pending', 'preview'] as const)('invalidates an NPC %s after editing a sibling knowledge field', async phase => {
    transport.library.mockResolvedValue({ scenarios: [{ id: 'scenario-one', version: 2, definition: { ...scenario, npcs: [libraryNpc] } }], characters: [] });
    let finish!: (value: { text: string }) => void;
    transport.generateField.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const wrapper = mount(Library); await flushPromises(); await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
    const control = await generate(wrapper, 'npc.role', 'A keeper');
    if (phase === 'preview') { finish({ text: 'Outdated role' }); await flushPromises(); expect(control.find('[data-testid="field-generator-preview"]').exists()).toBe(true); }
    await wrapper.findAll('label').find(label => label.text() === 'What this character knows')!.get('textarea').setValue('Changed own memory');
    if (phase === 'pending') { finish({ text: 'Outdated role' }); await flushPromises(); }
    expect(control.find('[data-testid="field-generator-preview"]').exists()).toBe(false);
    expect(control.props('modelValue')).toBe('Keeper'); expect(transport.saveScenario).not.toHaveBeenCalled(); wrapper.unmount();
  });

  it.each(['pending', 'preview'] as const)('invalidates a character %s after editing its private secret', async phase => {
    let finish!: (value: { text: string }) => void;
    transport.generateField.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const wrapper = mount(Library); await flushPromises(); await wrapper.get('[data-testid="edit-character-card-one"]').trigger('click');
    const control = await generate(wrapper, 'character.backstory', 'A courier');
    if (phase === 'preview') { finish({ text: 'Outdated backstory' }); await flushPromises(); expect(control.find('[data-testid="field-generator-preview"]').exists()).toBe(true); }
    await wrapper.get('[data-testid="card-secret"]').setValue('Changed private secret');
    if (phase === 'pending') { finish({ text: 'Outdated backstory' }); await flushPromises(); }
    expect(control.find('[data-testid="field-generator-preview"]').exists()).toBe(false);
    expect(control.props('modelValue')).toBe(card.backstory); expect(transport.saveCharacterTemplate).not.toHaveBeenCalled(); wrapper.unmount();
  });

  it('describes every library field outside its unchanged label, including repeated imported entities', async () => {
    const wrapper = mount(Library, { global: { stubs: { FieldGenerator: true, CharacterForm: true } } });
    await flushPromises();
    for (const title of ['Add non-player character', 'Add non-player character', 'Add track', 'Add track', 'Add fact', 'Add fact', 'Add location']) {
      await wrapper.findAll('button').find(button => button.text() === title)!.trigger('click');
    }
    for (const button of wrapper.findAll('button').filter(button => button.text() === 'Add knowledge')) {
      await button.trigger('click');
      await button.trigger('click');
    }
    for (const label of wrapper.findAll('label').filter(label => label.text().startsWith('Relationship to the party'))) await label.get('select').setValue('friendly');
    await wrapper.findAll('button').find(button => button.text() === 'Copy current fields into editor')!.trigger('click');
    const imported = JSON.parse((wrapper.get('[data-testid="native-json"]').element as HTMLTextAreaElement).value);
    [imported.locations, imported.npcs, imported.tracks, imported.facts].forEach((collection, group) => collection.forEach((entity: { id: string }, index: number) => { entity.id = `id ${group} ${index} / # &`; }));
    imported.facts.forEach((fact: { text: string }) => { fact.text = 'A known fact.'; });
    imported.npcs.forEach((npc: { knowledge: { statement: string }[]; partyRelationship: { reason: string } }) => { npc.knowledge.forEach(knowledge => { knowledge.statement = 'A remembered fact.'; }); npc.partyRelationship.reason = 'An old friendship.'; });
    imported.openingScene.locationId = imported.locations[0].id;
    imported.npcs.forEach((npc: { locationId: string }) => { npc.locationId = imported.locations[0].id; });
    await wrapper.get('[data-testid="native-json"]').setValue(JSON.stringify(imported));
    await wrapper.get('[data-testid="import-json"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    const assertDescriptions = () => {
      const helpers = wrapper.findAll('p.field-help');
      const controls = wrapper.findAll('input, select, textarea');
      expect(controls.length).toBeGreaterThanOrEqual(5);
      const ids = controls.map(control => {
        const id = control.attributes('aria-describedby');
        expect(id, control.element.outerHTML).toBeTruthy();
        expect(id).not.toMatch(/\s/);
        const targets = helpers.filter(helper => helper.attributes('id') === id);
        expect(targets).toHaveLength(1);
        expect(targets[0]!.text().length).toBeGreaterThan(15);
        expect(targets[0]!.element.closest('label')).toBeNull();
        return id;
      });
      expect(new Set(ids).size).toBe(ids.length);
    };
    assertDescriptions();
    expect(wrapper.findAll('label').filter(label => label.text() === 'Name')).toHaveLength(2);
    const description = (name: string) => {
      const control = wrapper.findAll('label').find(label => label.text() === name)!.get('input, textarea, select');
      return wrapper.findAll('p.field-help').find(helper => helper.attributes('id') === control.attributes('aria-describedby'))!.text();
    };
    expect(description('Location name')).toMatch(/director.*location choices/i);
    expect(description('Location description')).toMatch(/private location notes.*director/i);
    expect(description('Location description')).toMatch(/party.*scene description/i);
    expect(description('Director notes')).toMatch(/private.*reference/i);
    expect(description('Motivation')).toMatch(/private.*reference/i);
    const tickLabel = wrapper.findAll('label').find(label => label.text().startsWith('Tick automatically'))!;
    const tickId = tickLabel.get('select').attributes('aria-describedby');
    const tickHelp = wrapper.findAll('p.field-help').find(helper => helper.attributes('id') === tickId)!.text();
    expect(tickHelp).toMatch(/advance by 1.*maximum.*published action round/);
    expect(tickHelp).toMatch(/after each action round.*selected/i);
    expect(description('Completion text')).toMatch(/track fills/i);
    expect(description('Completion text')).toMatch(/public.*immediately/i);
    expect(wrapper.text()).toMatch(/running sessions.*unchanged/i);
    await wrapper.get('[data-testid="edit-character-card-one"]').trigger('click');
    assertDescriptions();
    expect(wrapper.findAll('p.field-help').map(helper => helper.text()).join(' ')).toMatch(/draft.*does not.*link/i);
    transport.createCustom.mockResolvedValue({ sessionId: 'custom-show', invites: [{ token: 'player token', role: 'player', characterId: 'pc-1' }, { token: 'stage # token', role: 'stage', characterId: null }] });
    await wrapper.get('[data-testid="create-custom"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[aria-label="Stage invitation"]').exists()).toBe(true);
    assertDescriptions();
    wrapper.unmount();
  });

  it('uses the current unsaved premise only after selecting premise mode', async () => {
    const wrapper = mount(Library);
    await flushPromises();
    await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
    const premise = wrapper.findAll('label').find(label => label.text() === 'Premise')!.get('textarea');
    await premise.setValue('An unsaved city floats above a sleeping dragon.');
    const control = await generate(wrapper, 'scenario.genre', 'A strange mystery');
    expect(transport.generateField).toHaveBeenLastCalledWith({ field: 'scenario.genre', seed: 'A strange mystery' });
    await control.get('[data-testid="field-generator-source"]').setValue('premise');
    expect((control.get('[data-testid="field-generator-premise"]').element as HTMLTextAreaElement).value).toContain('An unsaved city floats above a sleeping dragon.');
    expect(control.text()).toContain('Current scenario draft: The Glass Moon');
    await control.get('[data-testid="field-generator-generate"]').trigger('click');
    await flushPromises();
    expect(transport.generateField).toHaveBeenLastCalledWith({ field: 'scenario.genre', seed: '', premise: 'An unsaved city floats above a sleeping dragon.' });
    expect(transport.saveScenario).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('requires an explicit character scenario selection and offers the current unsaved draft', async () => {
    const wrapper = mount(Library);
    await flushPromises();
    await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
    await wrapper.findAll('label').find(label => label.text() === 'Premise')!.get('textarea').setValue('An unsaved premise for a new cast.');
    await wrapper.get('[data-testid="edit-character-card-one"]').trigger('click');
    const selector = wrapper.get('[data-testid="character-premise-source"]');
    expect((selector.element as HTMLSelectElement).value).toBe('');
    expect(selector.text()).toContain('Current scenario draft: The Glass Moon');
    const control = fieldControl(wrapper, 'character.backstory');
    expect(control.props('premise')).toBeUndefined();
    await selector.setValue('draft');
    expect(control.props('premise')).toBe('An unsaved premise for a new cast.');
    await selector.setValue('scenario-one:2');
    expect(control.props('premise')).toBe(scenario.premise);
    expect(control.props('premiseLabel')).toContain('The Glass Moon');
    await generate(wrapper, 'character.backstory', 'A courier');
    expect(transport.generateField).toHaveBeenLastCalledWith({ field: 'character.backstory', seed: 'A courier', characterContext: characterFieldContext(card as never) });
    expect(transport.saveCharacterTemplate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it.each(['character', 'show'] as const)('invalidates pending %s drafts when changing between same-premise scenario versions', async target => {
    transport.library.mockResolvedValue({ scenarios: [{ id: 'scenario-one', version: 2, definition: scenario }, { id: 'scenario-two', version: 1, definition: scenario }], characters: [{ id: 'card-one', version: 1, definition: card }] });
    let finish!: (result: { text: string }) => void;
    transport.generateField.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const wrapper = mount(Library);
    await flushPromises();
    if (target === 'character') await wrapper.get('[data-testid="edit-character-card-one"]').trigger('click');
    const selector = wrapper.get(`[data-testid="${target === 'character' ? 'character-premise-source' : 'show-scenario'}"]`);
    await selector.setValue('scenario-one:2');
    const control = fieldControl(wrapper, target === 'character' ? 'character.backstory' : 'session.title');
    await control.get('[data-testid="field-generator-open"]').trigger('click');
    await control.get('[data-testid="field-generator-source"]').setValue('premise');
    await control.get('[data-testid="field-generator-generate"]').trigger('click');
    await selector.setValue('scenario-two:1');
    finish({ text: 'An old source suggestion' });
    await flushPromises();
    expect(control.find('[data-testid="field-generator-preview"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('uses the selected saved scenario for show titles even while another scenario is being edited', async () => {
    transport.library.mockResolvedValue({ scenarios: [{ id: 'scenario-one', version: 2, definition: scenario }, { id: 'scenario-two', version: 1, definition: { ...scenario, title: 'Another world', premise: 'A different saved premise.' } }], characters: [] });
    const wrapper = mount(Library);
    await flushPromises();
    await wrapper.get('[data-testid="edit-scenario-scenario-two"]').trigger('click');
    await wrapper.findAll('label').find(label => label.text() === 'Premise')!.get('textarea').setValue('Do not send this unsaved premise.');
    const control = fieldControl(wrapper, 'session.title');
    await control.get('[data-testid="field-generator-open"]').trigger('click');
    await control.get('[data-testid="field-generator-source"]').setValue('premise');
    expect(control.text()).toContain('The Glass Moon');
    await control.get('[data-testid="field-generator-generate"]').trigger('click');
    await flushPromises();
    expect(transport.generateField).toHaveBeenLastCalledWith({ field: 'session.title', seed: '', premise: scenario.premise });
    wrapper.unmount();
  });

  it('disables scenario source selectors while saving', async () => {
    let finish!: (value: unknown) => void;
    transport.saveCharacterTemplate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const wrapper = mount(Library);
    await flushPromises();
    await wrapper.get('[data-testid="edit-character-card-one"]').trigger('click');
    await wrapper.get('[data-testid="save-character"]').trigger('click');
    expect(wrapper.get('[data-testid="character-premise-source"]').element.matches(':disabled')).toBe(true);
    expect(wrapper.get('[data-testid="show-scenario"]').element.matches(':disabled')).toBe(true);
    finish({ id: 'card-one', version: 2, definition: card });
    await flushPromises();
    wrapper.unmount();
  });

  it('offers generation for every creative scenario field, nested entity, and the new show title', async () => {
    const wrapper = mount(Library);
    await flushPromises();
    for (const title of ['Add non-player character', 'Add track', 'Add fact', 'Add knowledge']) {
      await wrapper.findAll('button').find(button => button.text() === title)!.trigger('click');
    }
    await wrapper.findAll('label').find(label => label.text().startsWith('Relationship to the party'))!.get('select').setValue('friendly');
    const fields = wrapper.findAllComponents({ name: 'FieldGenerator' }).map(control => control.props('field'));
    expect(fields.sort()).toEqual([
      'scenario.title', 'scenario.premise', 'scenario.genre', 'scenario.tone', 'scenario.pictureStyle', 'scenario.directorNotes',
      'scenario.boundaries', 'scenario.playerHooks', 'scenario.objectives', 'scenario.discoveries', 'scenario.opportunities',
      'scene.title', 'scene.description', 'location.title', 'location.description',
      'npc.displayName', 'npc.role', 'npc.appearance', 'npc.hiddenIdentity', 'npc.motivation', 'npc.goal', 'npc.mood',
      'npc.communicationChannel', 'npc.knowledge', 'npc.relationshipReason', 'npc.aliases', 'npc.personality',
      'npc.limits', 'npc.dialogueExamples', 'npc.secrets', 'track.label', 'track.completionText', 'fact.text', 'session.title',
    ].sort());
    expect(wrapper.findAllComponents({ name: 'FieldGenerator' }).every(control => control.props('contextKey') !== undefined)).toBe(true);
    await wrapper.findAll('label').find(label => label.text() === 'Premise')!.get('textarea').setValue('The current unsaved world premise.');
    const scenarioControls = wrapper.findAllComponents({ name: 'FieldGenerator' }).filter(control => control.props('field') !== 'session.title');
    expect(scenarioControls.every(control => control.props('premise') === 'The current unsaved world premise.')).toBe(true);
    expect(scenarioControls.every(control => control.props('premiseLabel') === 'Current scenario draft: New scenario')).toBe(true);
    wrapper.unmount();
  });

  it('enables character generation only in the library and leaves the player form disabled by default', async () => {
    const playerForm = mount(CharacterForm, { props: { modelValue: structuredClone(card) as never, premise: scenario.premise, premiseLabel: scenario.title } });
    expect(playerForm.findAllComponents({ name: 'FieldGenerator' })).toHaveLength(0);
    playerForm.unmount();
    const wrapper = mount(Library);
    await flushPromises();
    await wrapper.get('[data-testid="edit-character-card-one"]').trigger('click');
    const fields = wrapper.findComponent(CharacterForm).findAllComponents({ name: 'FieldGenerator' }).map(control => control.props('field'));
    expect(fields.sort()).toEqual([
      'character.displayName', 'character.pronouns', 'character.appearance', 'character.personality', 'character.backstory',
      'character.specialty', 'character.flaw', 'character.connection', 'character.secret',
      'character.possession', 'character.possession', 'character.possession',
    ].sort());
    wrapper.unmount();
  });

  it('sends only the edited seed and applies a preview only to the unsaved target field', async () => {
    transport.generateField.mockResolvedValue({ text: 'The Silent Observatory' });
    const wrapper = mount(Library);
    await flushPromises();
    await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
    const control = await generate(wrapper, 'scenario.title', 'A mysterious observatory');
    expect(transport.generateField).toHaveBeenCalledExactlyOnceWith({ field: 'scenario.title', seed: 'A mysterious observatory' });
    expect(control.get('[data-testid="field-generator-preview"]').text()).toContain('The Silent Observatory');
    expect((wrapper.get('[data-testid="scenario-title"]').element as HTMLInputElement).value).toBe(scenario.title);
    expect(transport.saveScenario).not.toHaveBeenCalled();
    await control.get('[data-testid="field-generator-apply"]').trigger('click');
    expect((wrapper.get('[data-testid="scenario-title"]').element as HTMLInputElement).value).toBe('The Silent Observatory');
    expect(fieldControl(wrapper, 'scenario.directorNotes').props('modelValue')).toBe(scenario.directorNotes);
    expect(transport.saveScenario).not.toHaveBeenCalled();
    expect(transport.createCustom).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('preserves unsaved words when a suggestion is cancelled or generation fails', async () => {
    const wrapper = mount(Library);
    await flushPromises();
    await wrapper.get('[data-testid="scenario-title"]').setValue('My unfinished title');
    let control = await generate(wrapper, 'scenario.title', 'An alternative title');
    await control.get('[data-testid="field-generator-cancel"]').trigger('click');
    expect((wrapper.get('[data-testid="scenario-title"]').element as HTMLInputElement).value).toBe('My unfinished title');
    transport.generateField.mockRejectedValueOnce(new Error('Generation is unavailable.'));
    control = await generate(wrapper, 'scenario.title', 'Another alternative');
    expect(control.get('[role="alert"]').text()).toContain('Generation is unavailable.');
    expect((wrapper.get('[data-testid="scenario-title"]').element as HTMLInputElement).value).toBe('My unfinished title');
    expect(transport.saveScenario).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('applies generated list lines without saving or trimming the draft', async () => {
    transport.generateField.mockResolvedValue({ text: 'Fade to black.\n\nNo spiders.\n' });
    const wrapper = mount(Library);
    await flushPromises();
    const control = await generate(wrapper, 'scenario.boundaries', 'Comfortable adventure');
    await control.get('[data-testid="field-generator-apply"]').trigger('click');
    const textarea = wrapper.findAll('label').find(label => label.text().startsWith('Content boundaries'))!.get('textarea');
    expect((textarea.element as HTMLTextAreaElement).value).toBe('Fade to black.\n\nNo spiders.\n');
    expect(transport.saveScenario).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('keeps generated character secrets and possessions in the library draft until save', async () => {
    const wrapper = mount(Library);
    await flushPromises();
    await wrapper.get('[data-testid="edit-character-card-one"]').trigger('click');
    transport.generateField.mockResolvedValueOnce({ text: 'Carries the lost royal seal.' });
    const secret = await generate(wrapper, 'character.secret', 'A hidden royal connection');
    expect((wrapper.get('[data-testid="card-secret"]').element as HTMLTextAreaElement).value).toBe(card.secret);
    await secret.get('[data-testid="field-generator-apply"]').trigger('click');
    expect((wrapper.get('[data-testid="card-secret"]').element as HTMLTextAreaElement).value).toBe('Carries the lost royal seal.');
    transport.generateField.mockResolvedValueOnce({ text: 'A battered astrolabe' });
    const possession = await generate(wrapper, 'character.possession', 'A navigation tool', 1);
    await possession.get('[data-testid="field-generator-apply"]').trigger('click');
    const possessions = wrapper.findAll('label').filter(label => label.text().startsWith('Possession')).map(label => (label.get('input').element as HTMLInputElement).value);
    expect(possessions).toEqual(['Map', 'A battered astrolabe', 'Coat']);
    expect(transport.generateField.mock.calls).toEqual([[{ field: 'character.secret', seed: 'A hidden royal connection', characterContext: characterFieldContext(card as never) }], [{ field: 'character.possession', seed: 'A navigation tool', characterContext: characterFieldContext({ ...card, secret: 'Carries the lost royal seal.' } as never) }]]);
    expect(transport.saveCharacterTemplate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it.each(['switch', 'reopen', 'import', 'refresh'] as const)('discards pending suggestions after %s even when the replacement title has the same value', async action => {
    let resolve!: (value: { text: string }) => void;
    transport.library.mockResolvedValue({ scenarios: [{ id: 'scenario-one', version: 2, definition: scenario }, { id: 'scenario-two', version: 1, definition: scenario }], characters: [] });
    transport.generateField.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const wrapper = mount(Library);
    await flushPromises();
    await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
    await generate(wrapper, 'scenario.title', 'A lost tower');
    if (action === 'switch') await wrapper.get('[data-testid="edit-scenario-scenario-two"]').trigger('click');
    if (action === 'reopen') await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
    if (action === 'import') {
      await wrapper.get('[data-testid="native-json"]').setValue(JSON.stringify(scenario));
      await wrapper.get('[data-testid="import-json"]').trigger('click');
    }
    if (action === 'refresh') await wrapper.findAll('button').find(button => button.text() === 'Refresh saved library')!.trigger('click');
    await flushPromises();
    resolve({ text: 'An obsolete response' });
    await flushPromises();
    expect(fieldControl(wrapper, 'scenario.title').find('[data-testid="field-generator-preview"]').exists()).toBe(false);
    expect((wrapper.get('[data-testid="scenario-title"]').element as HTMLInputElement).value).toBe(scenario.title);
    expect(transport.saveScenario).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('does not move a removed knowledge row response onto an identical neighboring row', async () => {
    let resolve!: (value: { text: string }) => void;
    transport.generateField.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const wrapper = mount(Library);
    await flushPromises();
    for (const title of ['Add non-player character', 'Add knowledge', 'Add knowledge']) {
      await wrapper.findAll('button').find(button => button.text() === title)!.trigger('click');
    }
    await generate(wrapper, 'npc.knowledge', 'A rumored secret');
    await wrapper.findAll('button').find(button => button.text() === 'Remove knowledge')!.trigger('click');
    resolve({ text: 'This belonged to the removed memory.' });
    await flushPromises();
    const remaining = fieldControl(wrapper, 'npc.knowledge');
    expect(remaining.props('modelValue')).toBe('');
    expect(remaining.find('[data-testid="field-generator-preview"]').exists()).toBe(false);
    expect(transport.saveScenario).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('previews and applies a session title without creating the show', async () => {
    transport.generateField.mockResolvedValueOnce({ text: 'Friday Beyond the Moon' });
    const wrapper = mount(Library);
    await flushPromises();
    const control = await generate(wrapper, 'session.title', 'A Friday moon adventure');
    expect((wrapper.get('[data-testid="show-title"]').element as HTMLInputElement).value).toBe('A new story');
    await control.get('[data-testid="field-generator-apply"]').trigger('click');
    expect((wrapper.get('[data-testid="show-title"]').element as HTMLInputElement).value).toBe('Friday Beyond the Moon');
    expect(transport.createCustom).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('exports a valid definition near the size limit as a file that can be imported again', async () => {
    const large = { ...scenario, locations: Array.from({ length: 30 }, (_, index) => ({ id: `location-${index}`, title: `Location ${index}`, description: 'x'.repeat(3800) })), openingScene: { ...scenario.openingScene, locationId: 'location-0' }, directorNotes: '' };
    large.directorNotes = 'x'.repeat(MAX_NATIVE_BYTES - 100 - new TextEncoder().encode(JSON.stringify(large)).byteLength);
    const definition = ScenarioDefinitionSchema.parse(large);
    expect(new TextEncoder().encode(JSON.stringify(definition, null, 2)).byteLength).toBeGreaterThan(MAX_NATIVE_BYTES);
    transport.library.mockResolvedValue({ scenarios: [{ id: 'large', version: 1, definition }], characters: [] });
    let downloaded: Blob | undefined;
    const OriginalURL = URL;
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('URL', class extends OriginalURL {
      static createObjectURL(blob: Blob) { downloaded = blob; return 'blob:export-test'; }
      static revokeObjectURL() {}
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const wrapper = mount(Library);
    await flushPromises();
    await wrapper.get('[data-testid="edit-scenario-large"]').trigger('click');
    await wrapper.findAll('button').find(button => button.text() === 'Export native JSON')!.trigger('click');
    await flushPromises();
    expect(downloaded?.size).toBeLessThanOrEqual(MAX_NATIVE_BYTES);
    expect(ScenarioDefinitionSchema.parse(JSON.parse(await downloaded!.text()))).toEqual(definition);
    const fileInput = wrapper.get('input[type="file"]');
    Object.defineProperty(fileInput.element, 'files', { value: [downloaded], configurable: true });
    await fileInput.trigger('change');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Imported as a new unsaved template.');
    wrapper.unmount();
  });
  it('locks scenario inputs, template switching, and file imports while a save is pending', async () => {
    let finishSave!: (value: unknown) => void;
    transport.saveScenario.mockImplementation(() => new Promise(resolve => { finishSave = resolve; }));
    const wrapper = mount(Library);
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === 'Use rehearsal scenario')!.trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="save-scenario"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="scenario-title"]').element.matches(':disabled')).toBe(true);
    expect(wrapper.get('input[type="file"]').element.matches(':disabled')).toBe(true);
    expect(wrapper.get('[data-testid="edit-character-card-one"]').attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('button').find(button => button.text() === 'Edit Aster starter')!.attributes('disabled')).toBeDefined();
    expect(wrapper.findAllComponents({ name: 'FieldGenerator' }).every(control => control.props('disabled'))).toBe(true);
    finishSave({ id: 'new-scenario', version: 1, definition: scenario });
    await flushPromises();
    expect(wrapper.get('[data-testid="scenario-title"]').element.matches(':disabled')).toBe(false);
    wrapper.unmount();
  });
  it('keeps a newly typed line break in list fields and normalizes empty lines only on save', async () => {
    const wrapper = mount(Library);
    await flushPromises();
    await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
    const boundaries = wrapper.findAll('label').find(label => label.text().startsWith('Content boundaries'))!.get('textarea');
    await boundaries.setValue('No harm to children.\n');
    expect((boundaries.element as HTMLTextAreaElement).value).toBe('No harm to children.\n');
    await boundaries.setValue('No harm to children.\n\nFade to black.\n');
    await wrapper.get('[data-testid="save-scenario"]').trigger('click');
    await flushPromises();
    expect(transport.saveScenario).toHaveBeenCalledWith(expect.objectContaining({ definition: expect.objectContaining({ boundaries: ['No harm to children.', 'Fade to black.'] }) }));
    wrapper.unmount();
  });
  it('edits native scenario fields and preserves unsaved words when a version conflict occurs', async () => {
    const wrapper = mount(Library);
    await flushPromises();
    await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
    await wrapper.get('[data-testid="scenario-title"]').setValue('The Unfinished Moon');
    transport.saveScenario.mockRejectedValue(new Error('A newer version exists. Reload the library before saving.'));
    await wrapper.get('[data-testid="save-scenario"]').trigger('click');
    await flushPromises();
    expect(transport.saveScenario).toHaveBeenCalledWith(expect.objectContaining({ templateId: 'scenario-one', expectedVersion: 2, definition: expect.objectContaining({ title: 'The Unfinished Moon' }) }));
    expect(wrapper.get('[role="alert"]').text()).toContain('A newer version exists');
    expect((wrapper.get('[data-testid="scenario-title"]').element as HTMLInputElement).value).toBe('The Unfinished Moon');
    wrapper.unmount();
  });

  it('rejects invalid native imports without replacing the current form or calling the server', async () => {
    const wrapper = mount(Library);
    await flushPromises();
    await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
    await wrapper.get('[data-testid="native-json"]').setValue(JSON.stringify({ ...scenario, executable: 'alert(1)' }));
    await wrapper.get('[data-testid="import-json"]').trigger('click');
    expect(wrapper.get('[role="alert"]').text()).toContain('valid');
    expect((wrapper.get('[data-testid="scenario-title"]').element as HTMLInputElement).value).toBe('The Glass Moon');
    expect(transport.saveScenario).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('validates the four trait values before saving a reusable character', async () => {
    const wrapper = mount(Library);
    await flushPromises();
    await wrapper.get('[data-testid="edit-character-card-one"]').trigger('click');
    await wrapper.get('[data-testid="card-trait-force"]').setValue('2');
    await wrapper.get('[data-testid="save-character"]').trigger('click');
    await flushPromises();
    expect(transport.saveCharacterTemplate).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain('+2');
    await wrapper.get('[data-testid="card-trait-force"]').setValue('0');
    await wrapper.get('[data-testid="card-name"]').setValue('Aster Vale');
    await wrapper.get('[data-testid="save-character"]').trigger('click');
    await flushPromises();
    expect(transport.saveCharacterTemplate).toHaveBeenCalledWith(expect.objectContaining({ templateId: 'card-one', expectedVersion: 1, definition: expect.objectContaining({ displayName: 'Aster Vale', secret: 'The map is a forgery.' }) }));
    wrapper.unmount();
  });

  it('moves selected seats to the newly saved visible card version', async () => {
    transport.saveCharacterTemplate.mockResolvedValue({ id: 'card-one', version: 2, definition: { ...card, displayName: 'Aster Vale' } });
    transport.createCustom.mockResolvedValue({ sessionId: 'custom-show', invites: [] });
    const wrapper = mount(Library);
    await flushPromises();
    await wrapper.get('[data-testid="show-seat-0"]').setValue('card-one:1');
    await wrapper.get('[data-testid="show-seat-1"]').setValue('card-one:1');
    await wrapper.get('[data-testid="edit-character-card-one"]').trigger('click');
    await wrapper.get('[data-testid="card-name"]').setValue('Aster Vale');
    await wrapper.get('[data-testid="save-character"]').trigger('click');
    await flushPromises();
    expect((wrapper.get('[data-testid="show-seat-0"]').element as HTMLSelectElement).value).toBe('card-one:2');
    expect((wrapper.get('[data-testid="show-seat-1"]').element as HTMLSelectElement).value).toBe('card-one:2');
    await wrapper.get('[data-testid="create-custom"]').trigger('click');
    await flushPromises();
    expect(transport.createCustom).toHaveBeenCalledWith(expect.any(String), expect.anything(), [{ templateId: 'card-one', version: 2 }, { templateId: 'card-one', version: 2 }]);
    wrapper.unmount();
  });

  it('defaults seats to player-written with that option first', async () => {
    const wrapper = mount(Library);
    await flushPromises();
    for (const index of [0, 1]) {
      const select = wrapper.get(`[data-testid="show-seat-${index}"]`);
      expect((select.element as HTMLSelectElement).value).toBe('player');
      const first = select.findAll('option')[0];
      expect(first.text()).toBe('Player writes their own character');
      expect(first.attributes('value')).toBe('player');
    }
    expect(wrapper.text()).toContain('Choose Player writes their own character to let the player write it in Cast & lobby, or pick a saved card. Each seat gets its own copy to change.');
    wrapper.unmount();
  });

  it('creates player-written seats even with no saved cards', async () => {
    transport.library.mockResolvedValueOnce({ scenarios: [{ id: 'scenario-one', version: 2, definition: { title: 'S', premise: 'P' } }], characters: [] });
    transport.createCustom.mockResolvedValue({ sessionId: 'custom-show', invites: [] });
    const wrapper = mount(Library);
    await flushPromises();
    await wrapper.get('[data-testid="show-title"]').setValue('Show');
    await wrapper.get('[data-testid="show-scenario"]').setValue('scenario-one:2');
    expect(wrapper.get('[data-testid="create-custom"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-testid="create-custom"]').trigger('click');
    await flushPromises();
    expect(transport.createCustom).toHaveBeenCalledWith('Show', { templateId: 'scenario-one', version: 2 }, [{ playerWritten: true }, { playerWritten: true }]);
    expect(wrapper.text()).toContain('In Cast & lobby, each player writes or checks their card and reads the boundaries. You approve every card before you start.');
    wrapper.unmount();
  });

  it('mixes a player seat with a saved card and leaves player seats alone when a card is saved', async () => {
    transport.saveCharacterTemplate.mockResolvedValue({ id: 'card-one', version: 2, definition: { ...card, displayName: 'Aster Vale' } });
    transport.createCustom.mockResolvedValue({ sessionId: 'custom-show', invites: [] });
    const wrapper = mount(Library);
    await flushPromises();
    await wrapper.get('[data-testid="show-title"]').setValue('Show');
    await wrapper.get('[data-testid="show-scenario"]').setValue('scenario-one:2');
    await wrapper.get('[data-testid="show-seat-1"]').setValue('card-one:1');
    await wrapper.get('[data-testid="edit-character-card-one"]').trigger('click');
    await wrapper.get('[data-testid="save-character"]').trigger('click');
    await flushPromises();
    expect((wrapper.get('[data-testid="show-seat-0"]').element as HTMLSelectElement).value).toBe('player');
    expect((wrapper.get('[data-testid="show-seat-1"]').element as HTMLSelectElement).value).toBe('card-one:2');
    await wrapper.get('[data-testid="create-custom"]').trigger('click');
    await flushPromises();
    expect(transport.createCustom).toHaveBeenCalledWith('Show', { templateId: 'scenario-one', version: 2 }, [{ playerWritten: true }, { templateId: 'card-one', version: 2 }]);
    wrapper.unmount();
  });

  it('starts a new character with an empty name and three empty possessions', async () => {
    transport.saveCharacterTemplate.mockResolvedValue({ id: 'new', version: 1, definition: card });
    const wrapper = mount(Library);
    await flushPromises();
    const button = wrapper.findAll('button').find(b => b.text() === 'New character');
    expect(button).toBeTruthy();
    await button!.trigger('click');
    expect((wrapper.get('[data-testid="card-name"]').element as HTMLInputElement).value).toBe('');
    const possessions = wrapper.findAll('input[maxlength="160"]').filter(input => input.element.closest('label')?.textContent?.startsWith('Possession'));
    expect(possessions).toHaveLength(3);
    expect(possessions.map(input => (input.element as HTMLInputElement).value)).toEqual(['', '', '']);
    wrapper.unmount();
  });

  it('creates independent seats from pinned versions, allowing a repeated card', async () => {
    transport.createCustom.mockResolvedValue({ sessionId: 'custom-show', invites: [{ token: 'player-token', role: 'player', characterId: 'pc-1' }, { token: 'stage-token', role: 'stage', characterId: null }] });
    const wrapper = mount(Library);
    await flushPromises();
    await wrapper.get('[data-testid="show-title"]').setValue('Friday at the Observatory');
    await wrapper.get('[data-testid="show-scenario"]').setValue('scenario-one:2');
    await wrapper.get('[data-testid="show-seat-0"]').setValue('card-one:1');
    await wrapper.get('[data-testid="show-seat-1"]').setValue('card-one:1');
    await wrapper.get('[data-testid="create-custom"]').trigger('click');
    await flushPromises();
    expect(transport.createCustom).toHaveBeenCalledWith('Friday at the Observatory', { templateId: 'scenario-one', version: 2 }, [{ templateId: 'card-one', version: 1 }, { templateId: 'card-one', version: 1 }]);
    expect(wrapper.get('[aria-label="Player 1 invitation"]').attributes('value')).toContain('/join/player-token');
    expect(wrapper.get('[data-testid="custom-lobby-link"]').attributes('href')).toBe(`/sessions/custom-show/lobby?identity=${'a'.repeat(32)}`);
    wrapper.unmount();
  });
  describe('whole-card generation', () => {
    const generated = (pronounsSuggested: boolean) => ({ card: { ...card, displayName: 'Generated Wren', pronouns: 'she/her', possessions: ['A lantern'] }, notes: [], pronounsSuggested });
    async function runCard(wrapper: ReturnType<typeof mount>) {
      await wrapper.get('[data-testid="card-generator-open"]').trigger('click');
      await wrapper.get('[data-testid="card-generator-prompt"]').setValue('A brave lighthouse keeper');
      await wrapper.get('[data-testid="card-generator-generate"]').trigger('click');
      await flushPromises();
    }
    const open = async () => { const wrapper = mount(Library); await flushPromises(); await wrapper.get('[data-testid="edit-character-card-one"]').trigger('click'); return wrapper; };

    it.each([false, true])('sends the whole-card request %s a chosen premise', async withPremise => {
      transport.generateCard.mockResolvedValue(generated(false));
      const wrapper = await open();
      if (withPremise) await wrapper.get('[data-testid="character-premise-source"]').setValue('scenario-one:2');
      await runCard(wrapper);
      const sent = transport.generateCard.mock.calls[0]![0];
      expect(sent).toEqual({ prompt: 'A brave lighthouse keeper', keepFilled: true, current: characterFieldContext(card as never), ...(withPremise ? { premise: scenario.premise } : {}) });
      expect('premise' in sent).toBe(withPremise);
      expect(wrapper.text().includes('The premise of the scenario you picked is sent too.')).toBe(withPremise);
      wrapper.unmount();
    });

    it('fills the form without saving and blocks saving while suggested pronouns are pending', async () => {
      transport.generateCard.mockResolvedValue(generated(true));
      const wrapper = await open();
      await runCard(wrapper);
      await wrapper.get('[data-testid="card-generator-apply"]').trigger('click');
      await flushPromises();
      expect((wrapper.get('[data-testid="card-name"]').element as HTMLInputElement).value).toBe('Generated Wren');
      expect(transport.saveCharacterTemplate).not.toHaveBeenCalled();
      const save = wrapper.get('[data-testid="save-character"]');
      expect(save.attributes('disabled')).toBeDefined();
      expect(wrapper.get('[data-testid="pronouns-pending-notice"]').text()).toBe('Check the pronouns the AI suggested first. Press Keep these pronouns, or change the Pronouns box.');
      await wrapper.get('[data-testid="keep-suggested-pronouns"]').trigger('click');
      await flushPromises();
      expect(wrapper.find('[data-testid="pronouns-pending-notice"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="save-character"]').attributes('disabled')).toBeUndefined();
      expect(transport.saveCharacterTemplate).not.toHaveBeenCalled();
      wrapper.unmount();
    });

    it('clears the pending state when another card is opened', async () => {
      transport.generateCard.mockResolvedValue(generated(true));
      const wrapper = await open();
      await runCard(wrapper);
      await wrapper.get('[data-testid="card-generator-apply"]').trigger('click');
      await flushPromises();
      expect(wrapper.find('[data-testid="pronouns-pending-notice"]').exists()).toBe(true);
      await wrapper.get('[data-testid="edit-character-card-one"]').trigger('click');
      await flushPromises();
      expect(wrapper.find('[data-testid="pronouns-pending-notice"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="save-character"]').attributes('disabled')).toBeUndefined();
      wrapper.unmount();
    });
  });
  describe('whole-scenario generation', () => {
    const T0 = new Date('2026-10-24T12:00:00.000Z').getTime();
    const iso = (ms: number) => new Date(ms).toISOString();
    const runningJob = { status: 'running', jobId: 'job-1', size: 'medium', startedAt: iso(T0), deadlineAt: iso(T0 + 240_000) };
    const draft = { ...scenario, title: 'The Drowned Bell', boundaries: [] };
    const doneJob = (suggestedBoundaries: string[]) => ({ status: 'succeeded', jobId: 'job-1', definition: draft, adjustments: [], warnings: [], suggestedBoundaries });
    const sel = (name: string) => `[data-testid="scenario-generator-${name}"]`;
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
    afterEach(() => { vi.useRealTimers(); });
    async function tick(ms: number) { await vi.advanceTimersByTimeAsync(ms); await flushPromises(); }
    async function run(wrapper: ReturnType<typeof mount>, suggested: string[]) {
      transport.startScenarioDraft.mockResolvedValue(runningJob);
      transport.scenarioDraft.mockResolvedValue(doneJob(suggested));
      await wrapper.get(sel('open')).trigger('click');
      await wrapper.get(sel('prompt')).setValue('A drowned bell tower');
      await wrapper.get(sel('size')).setValue('large');
      await wrapper.get(sel('generate')).trigger('click');
      await flushPromises();
      await tick(2000);
    }
    const mountLibrary = async () => { const wrapper = mount(Library); await flushPromises(); return wrapper; };

    it('sends the prompt, size and current boundaries to the start call', async () => {
      const wrapper = await mountLibrary();
      expect(wrapper.get(sel('open')).text()).toBe('Create the whole scenario with AI');
      await wrapper.get('[data-testid="native-json"]').setValue(JSON.stringify(scenario));
      await wrapper.get('[data-testid="import-json"]').trigger('click');
      await flushPromises();
      await run(wrapper, []);
      expect(transport.startScenarioDraft).toHaveBeenCalledTimes(1);
      expect(transport.startScenarioDraft).toHaveBeenCalledWith({ prompt: 'A drowned bell tower', size: 'large', boundaries: ['No harm to children.'] });
      wrapper.unmount();
    });

    it('loads the draft as a new unsaved template without saving', async () => {
      const wrapper = await mountLibrary();
      await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
      expect(wrapper.text()).toContain('Editing version 2');
      await wrapper.get('[data-testid="scenario-title"]').setValue('Edited saved scenario');
      await run(wrapper, []);
      expect(wrapper.get(sel('apply')).text()).toBe('Replace the editor with this draft');
      await wrapper.get(sel('apply')).trigger('click');
      await flushPromises();
      expect((wrapper.get('[data-testid="scenario-title"]').element as HTMLInputElement).value).toBe('The Drowned Bell');
      expect(wrapper.text()).toContain('New template');
      expect(wrapper.text()).not.toContain('Editing version');
      expect(wrapper.text()).toContain('Loaded the AI draft as a new unsaved scenario. Check every field, then press Save scenario version.');
      expect(transport.saveScenario).not.toHaveBeenCalled();
      expect(wrapper.find('[data-testid="suggested-boundaries-notice"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeUndefined();
      await wrapper.get('[data-testid="save-scenario"]').trigger('click');
      await flushPromises();
      const sent = transport.saveScenario.mock.calls[0]![0];
      expect(sent.expectedVersion).toBe(0);
      expect('templateId' in sent).toBe(false);
      expect(sent.definition.title).toBe('The Drowned Bell');
      wrapper.unmount();
    });

    it('offers a plain load in a fresh editor and a replace warning after edits', async () => {
      const fresh = await mountLibrary();
      await run(fresh, []);
      expect(fresh.get(sel('apply')).text()).toBe('Load into the editor');
      expect(fresh.text()).not.toContain('This replaces your unsaved changes in the editor.');
      fresh.unmount();
      const edited = await mountLibrary();
      await edited.get('[data-testid="scenario-title"]').setValue('My unsaved scenario');
      await run(edited, []);
      expect(edited.get(sel('apply')).text()).toBe('Replace the editor with this draft');
      expect(edited.text()).toContain('This replaces your unsaved changes in the editor.');
      edited.unmount();
    });

    it('treats a saved scenario as unchanged until it is edited, and again after saving', async () => {
      transport.saveScenario.mockResolvedValue({ id: 'scenario-one', version: 3, definition: { ...scenario, title: 'Renamed' } });
      const wrapper = await mountLibrary();
      await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
      await run(wrapper, []);
      expect(wrapper.get(sel('apply')).text()).toBe('Load into the editor');
      await wrapper.get('[data-testid="scenario-title"]').setValue('Renamed');
      await flushPromises();
      expect(wrapper.get(sel('apply')).text()).toBe('Replace the editor with this draft');
      await wrapper.get('[data-testid="save-scenario"]').trigger('click');
      await flushPromises();
      expect(wrapper.get(sel('apply')).text()).toBe('Load into the editor');
      wrapper.unmount();
    });

    it('blocks saving while suggested boundaries are unconfirmed and clears on keep', async () => {
      const wrapper = await mountLibrary();
      await run(wrapper, ['Keep serious injuries off screen.']);
      await wrapper.get(sel('apply')).trigger('click');
      await flushPromises();
      const notice = 'The AI suggested some content boundaries. Read them, change or remove any, then press Keep these boundaries.';
      expect(wrapper.get('[data-testid="suggested-boundaries-notice"]').text()).toBe(notice);
      expect(wrapper.get('[data-testid="suggested-boundaries-save-notice"]').text()).toBe(notice);
      expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeDefined();
      await wrapper.get('[data-testid="keep-suggested-boundaries"]').trigger('click');
      await flushPromises();
      expect(wrapper.find('[data-testid="suggested-boundaries-notice"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="suggested-boundaries-save-notice"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeUndefined();
      expect(transport.saveScenario).not.toHaveBeenCalled();
      wrapper.unmount();
    });

    it('also unblocks saving when the boundaries are edited or another scenario is opened', async () => {
      const wrapper = await mountLibrary();
      await run(wrapper, ['Keep serious injuries off screen.']);
      await wrapper.get(sel('apply')).trigger('click');
      await flushPromises();
      expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeDefined();
      const boundaries = wrapper.findAll('textarea').find(area => area.attributes('aria-describedby') && area.element.closest('.generated-field')?.textContent?.includes('Content boundaries'))!;
      await boundaries.setValue('Keep serious injuries off screen.\nNo spiders.');
      expect(wrapper.find('[data-testid="suggested-boundaries-notice"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeUndefined();
      wrapper.unmount();
    });

    it('clears the boundaries notice when scenario JSON is imported', async () => {
      const wrapper = await mountLibrary();
      await run(wrapper, ['Keep serious injuries off screen.']);
      await wrapper.get(sel('apply')).trigger('click');
      await flushPromises();
      expect(wrapper.find('[data-testid="suggested-boundaries-notice"]').exists()).toBe(true);
      await wrapper.get('[data-testid="native-json"]').setValue(JSON.stringify({ ...scenario, boundaries: [] }));
      await wrapper.get('[data-testid="import-json"]').trigger('click');
      await flushPromises();
      expect(wrapper.find('[data-testid="suggested-boundaries-notice"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="suggested-boundaries-save-notice"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeUndefined();
      wrapper.unmount();
    });

    it('clears the block when another scenario is opened', async () => {
      const wrapper = await mountLibrary();
      await run(wrapper, ['Keep serious injuries off screen.']);
      await wrapper.get(sel('apply')).trigger('click');
      await flushPromises();
      expect(wrapper.find('[data-testid="suggested-boundaries-notice"]').exists()).toBe(true);
      await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
      expect(wrapper.find('[data-testid="suggested-boundaries-notice"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeUndefined();
      wrapper.unmount();
    });

    it('keeps the panel and its polling when the character editor is shown and hidden again', async () => {
      const wrapper = await mountLibrary();
      transport.startScenarioDraft.mockResolvedValue(runningJob);
      transport.scenarioDraft.mockResolvedValue(runningJob);
      await wrapper.get(sel('open')).trigger('click');
      await wrapper.get(sel('prompt')).setValue('A drowned bell tower');
      await wrapper.get(sel('generate')).trigger('click');
      await flushPromises();
      await wrapper.get('[data-testid="edit-character-card-one"]').trigger('click');
      expect((wrapper.findComponent({ name: 'ScenarioGenerator' }).element as HTMLElement).style.display).toBe('none');
      await tick(2000);
      expect(transport.scenarioDraft).toHaveBeenCalledTimes(1);
      transport.scenarioDraft.mockResolvedValue(doneJob([]));
      await tick(2000);
      expect(transport.scenarioDraft).toHaveBeenCalledTimes(2);
      await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
      expect((wrapper.findComponent({ name: 'ScenarioGenerator' }).element as HTMLElement).style.display).not.toBe('none');
      expect((wrapper.get(sel('prompt')).element as HTMLTextAreaElement).value).toBe('A drowned bell tower');
      expect(wrapper.find(sel('apply')).exists()).toBe(true);
      wrapper.unmount();
    });
  });
  describe('pictures', () => {
    const styleInput = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('label').find(label => label.text().startsWith('Picture style'))!.get('input');

    it('shows the Picture style field with help and an AI button even when pictures are off', async () => {
      const wrapper = mount(Library); await flushPromises();
      await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
      const input = styleInput(wrapper);
      expect(input.attributes('maxlength')).toBe('300');
      const help = wrapper.findAll('p.field-help').find(item => item.attributes('id') === input.attributes('aria-describedby'))!;
      expect(help.text()).toContain('Leave it blank to use Painterly digital illustration, rich color, cinematic lighting.');
      expect(help.element.closest('label')).toBeNull();
      const control = fieldControl(wrapper, 'scenario.pictureStyle');
      expect(control.props('modelValue')).toBe('');
      const generated = await generate(wrapper, 'scenario.pictureStyle', 'inky noir');
      await generated.get('[data-testid="field-generator-apply"]').trigger('click');
      expect((input.element as HTMLInputElement).value).toBe('A suggested detail.');
      wrapper.unmount();
    });

    it('offers Server default plus every picture model and saves the choice only when made', async () => {
      const wrapper = mount(Library); await flushPromises();
      await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
      const select = wrapper.get('[data-testid="scenario-picture-model"]');
      const options = select.findAll('option');
      expect(options).toHaveLength(PICTURE_MODELS.length + 1);
      expect(options[0]!.text()).toBe('Server default');
      expect(options[0]!.attributes('value')).toBe('');
      expect(options.slice(1).map(option => option.text())).toEqual(PICTURE_MODELS.map(model => model.label));
      expect((select.element as HTMLSelectElement).value).toBe('');
      await wrapper.get('[data-testid="save-scenario"]').trigger('click'); await flushPromises();
      expect(transport.saveScenario.mock.lastCall![0].definition).not.toHaveProperty('pictureModel');
      await select.setValue(PICTURE_MODELS[1]!.id);
      await wrapper.get('[data-testid="save-scenario"]').trigger('click'); await flushPromises();
      expect(transport.saveScenario).toHaveBeenLastCalledWith(expect.objectContaining({ definition: expect.objectContaining({ pictureModel: PICTURE_MODELS[1]!.id }) }));
      await select.setValue('');
      await wrapper.get('[data-testid="save-scenario"]').trigger('click'); await flushPromises();
      expect(transport.saveScenario.mock.lastCall![0].definition).not.toHaveProperty('pictureModel');
      wrapper.unmount();
    });

    it('shows the stored picture model', async () => {
      transport.library.mockResolvedValue({ scenarios: [{ id: 'scenario-one', version: 2, definition: { ...scenario, pictureModel: PICTURE_MODELS[1]!.id } }], characters: [] });
      const wrapper = mount(Library); await flushPromises();
      await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
      expect((wrapper.get('[data-testid="scenario-picture-model"]').element as HTMLSelectElement).value).toBe(PICTURE_MODELS[1]!.id);
      wrapper.unmount();
    });

    it('saves the picture style with the scenario', async () => {
      const wrapper = mount(Library); await flushPromises();
      await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
      await styleInput(wrapper).setValue('Soft watercolor, pale light');
      await wrapper.get('[data-testid="save-scenario"]').trigger('click'); await flushPromises();
      expect(transport.saveScenario).toHaveBeenLastCalledWith(expect.objectContaining({ definition: expect.objectContaining({ pictureStyle: 'Soft watercolor, pale light' }) }));
      wrapper.unmount();
    });

    it('gives the character editor portrait props only when pictures are on, with a fresh key per new card', async () => {
      const off = mount(Library); await flushPromises();
      await off.get('[data-testid="edit-character-card-one"]').trigger('click');
      expect(off.findComponent(CharacterForm).props('picturesEnabled')).toBe(false);
      expect(off.find('[data-testid="portrait-generator"]').exists()).toBe(false);
      off.unmount();

      transport.library.mockResolvedValue({ scenarios: [], characters: [{ id: 'card-one', version: 1, definition: card }], picturesEnabled: true });
      transport.createLibraryPortrait.mockResolvedValue({ imageId: 'a'.repeat(8) + '-0000-4000-8000-' + 'b'.repeat(12) });
      const on = mount(Library); await flushPromises();
      await on.get('[data-testid="edit-character-card-one"]').trigger('click');
      const form = on.findComponent(CharacterForm);
      expect(form.props('picturesEnabled')).toBe(true);
      const details = { appearance: 'A silver coat.', role: 'Navigation', pronouns: 'they/them', name: 'Aster' };
      await form.props('generatePortrait')!(details);
      expect(transport.createLibraryPortrait).toHaveBeenLastCalledWith({ subject: 'card', subjectKey: 'card-one', details, pictureStyle: '' });
      expect(form.props('portraitUrl')!('abc')).toBe(`/api/library/images/abc?identity=${'a'.repeat(32)}`);

      const keys: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        await on.findAll('button').find(button => button.text() === 'New character')!.trigger('click');
        await on.findComponent(CharacterForm).props('generatePortrait')!(details);
        keys.push(transport.createLibraryPortrait.mock.calls.at(-1)![0].subjectKey);
      }
      expect(keys[0]).not.toBe(keys[1]);
      expect(keys[0]).not.toBe('card-one');
      on.unmount();
    });

    describe('non-player character portraits', () => {
      const imageId = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-${'b'.repeat(12)}`;
      const crew = (count: number, overrides: Record<number, Record<string, unknown>> = {}) => Array.from({ length: count }, (_, i) => NpcDefinitionSchema.parse({ id: `npc-${i}`, displayName: `Crew ${i}`, role: 'Deckhand', appearance: `Tall number ${i}.`, locationId: 'tower', status: 'present', voiceProfileId: 'narrator', ...overrides[i] }));
      async function open(npcs: ReturnType<typeof crew>, pictures = true) {
        transport.library.mockResolvedValue({ scenarios: [{ id: 'scenario-one', version: 2, definition: { ...scenario, npcs } }], characters: [], ...(pictures ? { picturesEnabled: true } : {}) });
        const wrapper = mount(Library); await flushPromises();
        await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
        return wrapper;
      }
      beforeEach(() => { transport.createLibraryPortrait.mockReset(); });
      const controls = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('[data-testid="npc-portrait-controls"]');
      const status = (wrapper: ReturnType<typeof mount>) => wrapper.find('[data-testid="create-all-portraits-status"]');
      const deferred = () => { let resolve!: (value: { imageId: string }) => void; let reject!: (cause: Error) => void; const promise = new Promise<{ imageId: string }>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

      it('shows Create portrait and Remove portrait on each character and sends the request body', async () => {
        const wrapper = await open(crew(2, { 1: { portraitId: imageId(9) } }));
        expect(controls(wrapper)).toHaveLength(2);
        expect(controls(wrapper)[0]!.find('[data-testid="npc-portrait-create"]').text()).toBe('Create portrait');
        expect(controls(wrapper)[0]!.find('[data-testid="npc-portrait-remove"]').exists()).toBe(false);
        expect(controls(wrapper)[1]!.get('[data-testid="npc-portrait-remove"]').text()).toBe('Remove portrait');
        await styleOf(wrapper).setValue('Inky noir');
        transport.createLibraryPortrait.mockResolvedValue({ imageId: imageId(1) });
        await controls(wrapper)[0]!.get('[data-testid="npc-portrait-create"]').trigger('click'); await flushPromises();
        expect(transport.createLibraryPortrait).toHaveBeenCalledWith({ subject: 'npc', subjectKey: 'npc-0', details: { appearance: 'Tall number 0.', role: 'Deckhand', pronouns: '', name: 'Crew 0' }, pictureStyle: 'Inky noir' });
        expect(transport.createLibraryPortrait.mock.lastCall![0]).not.toHaveProperty('pictureModel');
        await wrapper.get('[data-testid="scenario-picture-model"]').setValue(PICTURE_MODELS[1]!.id);
        await controls(wrapper)[0]!.get('[data-testid="npc-portrait-remove"]').trigger('click');
        await controls(wrapper)[0]!.get('[data-testid="npc-portrait-create"]').trigger('click'); await flushPromises();
        expect(transport.createLibraryPortrait).toHaveBeenLastCalledWith(expect.objectContaining({ subject: 'npc', pictureModel: PICTURE_MODELS[1]!.id }));
        expect(controls(wrapper)[0]!.find('[data-testid="npc-portrait-remove"]').exists()).toBe(true);
        await controls(wrapper)[0]!.get('[data-testid="npc-portrait-remove"]').trigger('click');
        expect(controls(wrapper)[0]!.find('[data-testid="npc-portrait-remove"]').exists()).toBe(false);
        await wrapper.get('[data-testid="save-scenario"]').trigger('click'); await flushPromises();
        expect(transport.saveScenario.mock.calls[0]![0].definition.npcs[0]).not.toHaveProperty('portraitId');
        wrapper.unmount();
      });
      const styleOf = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('label').find(label => label.text().startsWith('Picture style'))!.get('input');

      it('keeps Create portrait off for a character with no appearance or role, and shows why', async () => {
        const wrapper = await open(crew(1, { 0: { role: ' ', appearance: '' } }));
        expect(controls(wrapper)[0]!.get('[data-testid="npc-portrait-create"]').attributes('disabled')).toBeDefined();
        expect(controls(wrapper)[0]!.text()).toContain('Give this character an appearance or a role first.');
        expect(wrapper.get('[data-testid="create-all-portraits"]').attributes('disabled')).toBeDefined();
        wrapper.unmount();
      });

      it('creates portraits for everyone three at a time, only for the missing ones, with progress sentences', async () => {
        const wrapper = await open(crew(6, { 2: { portraitId: imageId(8) }, 5: { role: '', appearance: '' } }));
        const calls: Array<ReturnType<typeof deferred>> = [];
        transport.createLibraryPortrait.mockImplementation(() => { const d = deferred(); calls.push(d); return d.promise; });
        const all = wrapper.get('[data-testid="create-all-portraits"]');
        expect(all.text()).toBe('Create portraits for everyone');
        expect(all.classes()).toContain('secondary');
        await all.trigger('click'); await flushPromises();
        expect(calls).toHaveLength(3);
        expect(status(wrapper).text()).toBe('Making portraits: 0 of 4 done.');
        expect(status(wrapper).attributes('role')).toBe('status');
        expect(wrapper.get('[data-testid="create-all-portraits"]').attributes('disabled')).toBeDefined();
        calls[0]!.resolve({ imageId: imageId(1) }); await flushPromises();
        expect(calls).toHaveLength(4);
        expect(status(wrapper).text()).toBe('Making portraits: 1 of 4 done.');
        calls[1]!.resolve({ imageId: imageId(2) }); calls[2]!.resolve({ imageId: imageId(3) }); calls[3]!.resolve({ imageId: imageId(4) }); await flushPromises();
        expect(status(wrapper).text()).toBe('Made 4 portraits.');
        expect(transport.createLibraryPortrait.mock.calls.map(call => call[0].subjectKey)).toEqual(['npc-0', 'npc-1', 'npc-3', 'npc-4']);
        expect(wrapper.get('[data-testid="create-all-portraits"]').attributes('disabled')).toBeDefined();
        wrapper.unmount();
      });

      it('reports partial success and uses the singular for one portrait', async () => {
        const wrapper = await open(crew(2));
        transport.createLibraryPortrait.mockResolvedValueOnce({ imageId: imageId(1) }).mockRejectedValueOnce(new Error('Pictures are busy right now.'));
        await wrapper.get('[data-testid="create-all-portraits"]').trigger('click'); await flushPromises();
        expect(status(wrapper).text()).toBe('Made 1 of 2 portraits. Press Create portrait on a character to try again.');
        expect(controls(wrapper)[1]!.text()).toContain('Pictures are busy right now.');
        expect(wrapper.get('[data-testid="create-all-portraits"]').attributes('disabled')).toBeUndefined();
        wrapper.unmount();

        const one = await open(crew(1));
        transport.createLibraryPortrait.mockResolvedValueOnce({ imageId: imageId(1) });
        await one.get('[data-testid="create-all-portraits"]').trigger('click'); await flushPromises();
        expect(status(one).text()).toBe('Made 1 portrait.');
        one.unmount();

        const failed = await open(crew(1));
        transport.createLibraryPortrait.mockRejectedValueOnce(new Error('No.'));
        await failed.get('[data-testid="create-all-portraits"]').trigger('click'); await flushPromises();
        expect(status(failed).text()).toBe('Made 0 of 1 portrait. Press Create portrait on a character to try again.');
        failed.unmount();
      });

      it('shows Making the portrait... and a plain failure message for a single request', async () => {
        const wrapper = await open(crew(1));
        const d = deferred();
        transport.createLibraryPortrait.mockReturnValueOnce(d.promise);
        await controls(wrapper)[0]!.get('[data-testid="npc-portrait-create"]').trigger('click');
        expect(controls(wrapper)[0]!.text()).toContain('Making the portrait...');
        expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeDefined();
        expect(wrapper.get('[data-testid="portraits-pending-save-notice"]').text()).toBe('Portraits are still being made. Save when they finish.');
        expect(wrapper.get('[data-testid="portraits-pending-save-notice"]').attributes('role')).toBe('status');
        d.reject(new Error('The picture service refused this one.')); await flushPromises();
        expect(controls(wrapper)[0]!.text()).toContain('The picture service refused this one.');
        expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeUndefined();
        expect(wrapper.find('[data-testid="portraits-pending-save-notice"]').exists()).toBe(false);
        expect(wrapper.find('[role="alert"]').exists()).toBe(false);
        wrapper.unmount();
      });

      it('holds Save scenario version while a batch makes portraits, then saves both portrait ids', async () => {
        const wrapper = await open(crew(2));
        const first = deferred(); const second = deferred();
        transport.createLibraryPortrait.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        await wrapper.get('[data-testid="create-all-portraits"]').trigger('click'); await flushPromises();
        expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeDefined();
        expect(wrapper.find('[data-testid="portraits-pending-save-notice"]').exists()).toBe(true);
        await wrapper.get('[data-testid="save-scenario"]').trigger('click'); await flushPromises();
        expect(transport.saveScenario).not.toHaveBeenCalled();
        first.resolve({ imageId: imageId(1) }); second.resolve({ imageId: imageId(2) }); await flushPromises();
        expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeUndefined();
        expect(wrapper.find('[data-testid="portraits-pending-save-notice"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="scenario-unsaved"]').exists()).toBe(true);
        await wrapper.get('[data-testid="save-scenario"]').trigger('click'); await flushPromises();
        const saved = transport.saveScenario.mock.calls[0]![0].definition.npcs;
        expect([saved[0].portraitId, saved[1].portraitId]).toEqual([imageId(1), imageId(2)]);
        expect(wrapper.find('[data-testid="scenario-unsaved"]').exists()).toBe(false);
        wrapper.unmount();
      });

      it('shows Unsaved changes only after an edit to a freshly opened saved scenario', async () => {
        const wrapper = await open(crew(1));
        expect(wrapper.find('[data-testid="scenario-unsaved"]').exists()).toBe(false);
        await wrapper.get('input').setValue('Changed'); await flushPromises();
        expect(wrapper.get('[data-testid="scenario-unsaved"]').text()).toBe('Unsaved changes');
        wrapper.unmount();
      });

      it('drops an answer for a row that was removed, and in a batch one for a row that already has a portrait', async () => {
        const wrapper = await open(crew(2));
        const first = deferred(); const second = deferred();
        transport.createLibraryPortrait.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        await wrapper.get('[data-testid="create-all-portraits"]').trigger('click'); await flushPromises();
        await wrapper.findAll('button').filter(button => button.text() === 'Remove character')[0]!.trigger('click');
        expect(controls(wrapper)).toHaveLength(1);
        first.resolve({ imageId: imageId(1) }); await flushPromises();
        expect(controls(wrapper)).toHaveLength(1);
        expect(controls(wrapper)[0]!.find('[data-testid="npc-portrait-remove"]').exists()).toBe(false);
        // reloading the saved scenario while the batch runs brings in a row that already has a portrait
        transport.library.mockResolvedValue({ scenarios: [{ id: 'scenario-one', version: 2, definition: { ...scenario, npcs: crew(2, { 1: { portraitId: imageId(3) } }) } }], characters: [], picturesEnabled: true });
        await wrapper.findAll('button').find(button => button.text() === 'Refresh saved library')!.trigger('click'); await flushPromises();
        await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click');
        second.resolve({ imageId: imageId(4) }); await flushPromises();
        await wrapper.get('[data-testid="save-scenario"]').trigger('click'); await flushPromises();
        expect(transport.saveScenario.mock.calls[0]![0].definition.npcs[1].portraitId).toBe(imageId(3));
        wrapper.unmount();
      });

      it('keeps Save enabled on a newly opened scenario while the old portraits are still pending, and ignores their late answers', async () => {
        const wrapper = await open(crew(2));
        const calls: ReturnType<typeof deferred>[] = [];
        transport.createLibraryPortrait.mockImplementation(() => { const d = deferred(); calls.push(d); return d.promise; });
        await wrapper.get('[data-testid="create-all-portraits"]').trigger('click'); await flushPromises();
        expect(status(wrapper).text()).toBe('Making portraits: 0 of 2 done.');
        expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeDefined();
        await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click'); await flushPromises();
        expect(status(wrapper).exists()).toBe(false);
        expect(wrapper.find('[data-testid="portraits-pending-save-notice"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeUndefined();
        calls[0]!.resolve({ imageId: imageId(1) }); calls[1]!.reject(new Error('Too late.')); await flushPromises();
        expect(status(wrapper).exists()).toBe(false);
        expect(controls(wrapper).every(item => !item.find('[data-testid="npc-portrait-remove"]').exists() && !item.text().includes('Too late.'))).toBe(true);
        await wrapper.get('[data-testid="save-scenario"]').trigger('click'); await flushPromises();
        expect(transport.saveScenario.mock.calls[0]![0].definition.npcs.map((npc: { portraitId?: string }) => npc.portraitId)).toEqual([undefined, undefined]);
        wrapper.unmount();
      });

      it('stops an old batch from starting its queued portraits after the scenario is opened again', async () => {
        const wrapper = await open(crew(5));
        const calls: ReturnType<typeof deferred>[] = [];
        transport.createLibraryPortrait.mockImplementation(() => { const d = deferred(); calls.push(d); return d.promise; });
        await wrapper.get('[data-testid="create-all-portraits"]').trigger('click'); await flushPromises();
        expect(calls).toHaveLength(3);
        await wrapper.get('[data-testid="edit-scenario-scenario-one"]').trigger('click'); await flushPromises();
        calls[0]!.resolve({ imageId: imageId(1) }); await flushPromises();
        expect(calls).toHaveLength(3);
        expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeUndefined();
        expect(wrapper.find('[data-testid="portraits-pending-save-notice"]').exists()).toBe(false);
        calls[1]!.resolve({ imageId: imageId(2) }); calls[2]!.resolve({ imageId: imageId(3) }); await flushPromises();
        expect(calls).toHaveLength(3);
        expect(status(wrapper).exists()).toBe(false);
        wrapper.unmount();
      });

      it('starts its own batch when a second AI draft is loaded in the middle of the first', async () => {
        const wrapper = await open(crew(2));
        const calls: ReturnType<typeof deferred>[] = [];
        transport.createLibraryPortrait.mockImplementation(() => { const d = deferred(); calls.push(d); return d.promise; });
        await wrapper.get('[data-testid="create-all-portraits"]').trigger('click'); await flushPromises();
        expect(calls).toHaveLength(2);
        const draftNpcs = Array.from({ length: 2 }, (_, i) => NpcDefinitionSchema.parse({ id: `draft-${i}`, displayName: `Drafted ${i}`, role: 'Keeper', appearance: `Pale number ${i}.`, locationId: 'tower', status: 'present', voiceProfileId: 'narrator' }));
        wrapper.findComponent(ScenarioGenerator).vm.$emit('apply', { definition: { ...scenario, title: 'The Drowned Bell', npcs: draftNpcs }, suggestedBoundaries: [] }); await flushPromises();
        expect(calls).toHaveLength(4);
        expect(transport.createLibraryPortrait.mock.calls.slice(2).map(call => call[0].subjectKey)).toEqual(['draft-0', 'draft-1']);
        expect(status(wrapper).text()).toBe('Making portraits: 0 of 2 done.');
        calls[0]!.resolve({ imageId: imageId(1) }); calls[1]!.resolve({ imageId: imageId(2) }); await flushPromises();
        expect(status(wrapper).text()).toBe('Making portraits: 0 of 2 done.');
        expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeDefined();
        calls[2]!.resolve({ imageId: imageId(3) }); calls[3]!.resolve({ imageId: imageId(4) }); await flushPromises();
        expect(status(wrapper).text()).toBe('Made 2 portraits.');
        expect(wrapper.get('[data-testid="save-scenario"]').attributes('disabled')).toBeUndefined();
        wrapper.unmount();
      });

      it('does not count an answer for a removed character as made', async () => {
        const wrapper = await open(crew(2));
        const first = deferred(); const second = deferred();
        transport.createLibraryPortrait.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        await wrapper.get('[data-testid="create-all-portraits"]').trigger('click'); await flushPromises();
        await wrapper.findAll('button').filter(button => button.text() === 'Remove character')[0]!.trigger('click');
        first.resolve({ imageId: imageId(1) }); second.resolve({ imageId: imageId(2) }); await flushPromises();
        expect(status(wrapper).text()).toBe('Made 1 portrait.');
        wrapper.unmount();
      });

      it('takes a character removed during the batch out of the total instead of calling it a failure', async () => {
        const wrapper = await open(crew(2));
        const first = deferred(); const second = deferred();
        transport.createLibraryPortrait.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        await wrapper.get('[data-testid="create-all-portraits"]').trigger('click'); await flushPromises();
        expect(status(wrapper).text()).toBe('Making portraits: 0 of 2 done.');
        await wrapper.findAll('button').filter(button => button.text() === 'Remove character')[0]!.trigger('click');
        second.resolve({ imageId: imageId(2) }); await flushPromises();
        expect(status(wrapper).text()).toBe('Making portraits: 1 of 2 done.');
        first.resolve({ imageId: imageId(1) }); await flushPromises();
        expect(status(wrapper).text()).toBe('Made 1 portrait.');
        expect(status(wrapper).text()).not.toContain('try again');
        wrapper.unmount();
      });

      it('shows no batch line when every character is removed during the batch', async () => {
        const wrapper = await open(crew(2));
        const first = deferred(); const second = deferred();
        transport.createLibraryPortrait.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        await wrapper.get('[data-testid="create-all-portraits"]').trigger('click'); await flushPromises();
        await wrapper.findAll('button').filter(button => button.text() === 'Remove character')[0]!.trigger('click');
        await wrapper.findAll('button').filter(button => button.text() === 'Remove character')[0]!.trigger('click');
        first.resolve({ imageId: imageId(1) }); second.resolve({ imageId: imageId(2) }); await flushPromises();
        expect(status(wrapper).exists()).toBe(false);
        expect(wrapper.text()).not.toContain('Made 0');
        wrapper.unmount();
      });

      it('clears every character portrait state and the batch line when native JSON is imported', async () => {
        const wrapper = await open(crew(2));
        const second = deferred();
        transport.createLibraryPortrait.mockRejectedValueOnce(new Error('Pictures are busy right now.')).mockReturnValueOnce(second.promise);
        await wrapper.get('[data-testid="create-all-portraits"]').trigger('click'); await flushPromises();
        expect(status(wrapper).text()).toBe('Making portraits: 1 of 2 done.');
        expect(controls(wrapper)[0]!.text()).toContain('Pictures are busy right now.');
        expect(controls(wrapper)[1]!.text()).toContain('Making the portrait...');
        await wrapper.get('[data-testid="native-json"]').setValue(JSON.stringify({ ...scenario, npcs: crew(2) }));
        await wrapper.get('[data-testid="import-json"]').trigger('click'); await flushPromises();
        expect(status(wrapper).exists()).toBe(false);
        expect(controls(wrapper)).toHaveLength(2);
        expect(controls(wrapper)[0]!.text()).not.toContain('Pictures are busy right now.');
        expect(controls(wrapper)[1]!.text()).not.toContain('Making the portrait...');
        expect(wrapper.find('[data-testid="portraits-pending-save-notice"]').exists()).toBe(false);
        second.resolve({ imageId: imageId(2) }); await flushPromises();
        expect(status(wrapper).exists()).toBe(false);
        wrapper.unmount();
      });

      it('tells the director to start the Appearance of a non-player character with age and gender', async () => {
        const wrapper = await open(crew(1));
        const help = wrapper.findAll('.field-help').find(item => item.text().includes('Visible details shared with players'))!;
        expect(help.text()).toBe('Visible details shared with players, including while this character is offstage. Start with age and gender, for example "A woman in her forties", so the portrait matches.');
        wrapper.unmount();
      });

      it('lets a single request replace an existing portrait', async () => {
        const wrapper = await open(crew(1, { 0: { portraitId: imageId(7) } }));
        transport.createLibraryPortrait.mockResolvedValueOnce({ imageId: imageId(2) });
        await controls(wrapper)[0]!.get('[data-testid="npc-portrait-create"]').trigger('click'); await flushPromises();
        await wrapper.get('[data-testid="save-scenario"]').trigger('click'); await flushPromises();
        expect(transport.saveScenario.mock.calls[0]![0].definition.npcs[0].portraitId).toBe(imageId(2));
        wrapper.unmount();
      });

      it('starts portraits for an AI draft automatically and says so, only when pictures are on', async () => {
        vi.useFakeTimers();
        try {
          const draftNpcs = crew(2);
          const job = { status: 'succeeded', jobId: 'job-1', definition: { ...scenario, title: 'The Drowned Bell', boundaries: [], npcs: draftNpcs }, adjustments: [], warnings: [], suggestedBoundaries: [] };
          for (const pictures of [true, false]) {
            transport.createLibraryPortrait.mockReset().mockResolvedValue({ imageId: imageId(5) });
            transport.library.mockResolvedValue({ scenarios: [], characters: [], ...(pictures ? { picturesEnabled: true } : {}) });
            transport.startScenarioDraft.mockResolvedValue({ status: 'running', jobId: 'job-1', size: 'medium', startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 240_000).toISOString() });
            transport.scenarioDraft.mockResolvedValue(job);
            const wrapper = mount(Library); await flushPromises();
            await wrapper.get('[data-testid="scenario-generator-open"]').trigger('click');
            await wrapper.get('[data-testid="scenario-generator-prompt"]').setValue('A drowned bell tower');
            await wrapper.get('[data-testid="scenario-generator-generate"]').trigger('click'); await flushPromises();
            await vi.advanceTimersByTimeAsync(2000); await flushPromises();
            await wrapper.get('[data-testid="scenario-generator-apply"]').trigger('click'); await flushPromises();
            const loaded = 'Loaded the AI draft as a new unsaved scenario. Check every field, then press Save scenario version.';
            if (pictures) {
              expect(wrapper.get('p.notice').text()).toBe(`${loaded} Portraits for its characters are being made now.`);
              expect(transport.createLibraryPortrait).toHaveBeenCalledTimes(2);
              expect(status(wrapper).text()).toBe('Made 2 portraits.');
              expect(controls(wrapper).every(item => item.find('[data-testid="npc-portrait-remove"]').exists())).toBe(true);
            } else {
              expect(wrapper.get('p.notice').text()).toBe(loaded);
              expect(transport.createLibraryPortrait).not.toHaveBeenCalled();
            }
            wrapper.unmount();
          }
        } finally { vi.useRealTimers(); }
      });

      it('shows the off sentence and no portrait buttons when pictures are off', async () => {
        const wrapper = await open(crew(2), false);
        expect(wrapper.text()).toContain('Pictures are off on this server.');
        expect(wrapper.find('[data-testid="create-all-portraits"]').exists()).toBe(false);
        expect(controls(wrapper)).toHaveLength(0);
        expect(wrapper.findAll('button').some(button => button.text() === 'Create portrait')).toBe(false);
        wrapper.unmount();
      });
    });
  });
});
