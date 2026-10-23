// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { MAX_NATIVE_BYTES, NpcDefinitionSchema, ScenarioDefinitionSchema } from '@rpg/contracts';
import Library from './Library.vue';
import CharacterForm from './CharacterForm.vue';
import { characterFieldContext, npcFieldContext } from './field-context';

const transport = vi.hoisted(() => ({ library: vi.fn(), starter: vi.fn(), saveScenario: vi.fn(), saveCharacterTemplate: vi.fn(), createCustom: vi.fn(), generateField: vi.fn() }));
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
  window.history.replaceState({}, '', `/library?identity=${'a'.repeat(32)}`);
  transport.library.mockResolvedValue({ scenarios: [{ id: 'scenario-one', version: 2, definition: scenario }], characters: [{ id: 'card-one', version: 1, definition: card }] });
  transport.starter.mockResolvedValue({ scenario, characters: [card] });
  transport.saveScenario.mockResolvedValue({ id: 'scenario-one', version: 3, definition: scenario });
  transport.saveCharacterTemplate.mockResolvedValue({ id: 'card-new', version: 1, definition: card });
  transport.generateField.mockReset().mockResolvedValue({ text: 'A suggested detail.' });
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
      'scenario.title', 'scenario.premise', 'scenario.genre', 'scenario.tone', 'scenario.directorNotes',
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
});
