// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, reactive, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CharacterCardDefinitionSchema, FieldGenerationRequestSchema } from '@rpg/contracts';
import type { CardGenerationResponse, CharacterCardDefinition } from '@rpg/contracts';
import CardGenerator from './CardGenerator.vue';
import CharacterForm from './CharacterForm.vue';
import PortraitGenerator from './PortraitGenerator.vue';
import { characterFieldContext } from './field-context';
import { withDescription } from './card-description';
import { api } from './api';

const card: CharacterCardDefinition = { schemaVersion: 1, displayName: 'Aster', pronouns: 'they/them', appearance: 'A silver coat.', personality: 'Patient.', backstory: 'A former courier.', traits: { force: 0, finesse: 2, wits: 1, presence: 1 }, specialty: 'Navigation', flaw: 'Distrustful', possessions: ['Map', 'Compass', 'Coat'], connection: 'Owes the crew a favor.', secret: 'The map is a forgery.', extensions: {} };

afterEach(() => { vi.restoreAllMocks(); });

describe('character field guidance', () => {
  it('forwards the drafting callback and instructions to all twelve generators with the current unsaved context', async () => {
    const request = vi.fn().mockResolvedValue({ text: 'Private draft' });
    const replacement = vi.fn().mockResolvedValue({ text: 'Replacement draft' });
    const draft = reactive(structuredClone(card));
    const generator = defineComponent({ name: 'FieldGenerator', props: ['field', 'characterContext', 'instructions', 'generate'], template: '<span />' });
    const wrapper = mount(CharacterForm, { props: { modelValue: draft, generationEnabled: true, generate: request, instructions: 'Public explorer guidance' }, global: { stubs: { FieldGenerator: generator } } });
    const controls = () => wrapper.findAllComponents(generator);
    expect(controls()).toHaveLength(12);
    for (const control of controls()) {
      expect(control.props('generate')).toBe(request);
      expect(control.props('instructions')).toBe('Public explorer guidance');
      expect(control.props('characterContext')).toEqual(characterFieldContext(draft));
    }
    await wrapper.get('[data-testid="card-secret"]').setValue('My unsaved secret');
    await wrapper.setProps({ generate: replacement, instructions: 'Updated explorer guidance' });
    for (const control of controls()) {
      expect(control.props('generate')).toBe(replacement);
      expect(control.props('instructions')).toBe('Updated explorer guidance');
      expect(control.props('characterContext')).toEqual(characterFieldContext(draft));
    }
    wrapper.unmount();
  });

  it('drafts through the supplied callback using unsaved fields and keeps the card unchanged until Apply', async () => {
    const defaultRequest = vi.spyOn(api, 'generateField').mockResolvedValue({ text: 'Wrong transport' });
    const request = vi.fn().mockResolvedValue({ text: 'An explorer from a lost moon.' });
    const draft = reactive({ ...structuredClone(card), backstory: '' });
    const wrapper = mount(CharacterForm, { props: { modelValue: draft, generationEnabled: true, generate: request, instructions: 'Build an explorer' } });
    await wrapper.get('[data-testid="card-secret"]').setValue('My unfinished private words');
    await wrapper.get('[aria-label="AI Generate Backstory"]').trigger('click');
    await wrapper.get('[data-testid="field-generator-generate"]').trigger('click'); await flushPromises();
    expect(defaultRequest).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith({ field: 'character.backstory', seed: '', instructions: 'Build an explorer', characterContext: characterFieldContext(draft) });
    expect(draft.backstory).toBe('');
    await wrapper.get('[data-testid="field-generator-apply"]').trigger('click');
    expect(draft.backstory).toBe('An explorer from a lost moon.');
    wrapper.unmount();
  });

  it('generates a blank backstory after editing only the third possession of an empty list', async () => {
    const request = vi.spyOn(api, 'generateField').mockResolvedValue({ text: 'A mapmaker in exile.' });
    const draft = reactive(CharacterCardDefinitionSchema.parse({ ...card, possessions: [], backstory: '' }));
    const wrapper = mount(CharacterForm, { props: { modelValue: draft, generationEnabled: true } });
    try {
      await wrapper.findAll('label').find(label => label.text() === 'Possession 3')!.get('input').setValue('Map');
      await wrapper.get('[aria-label="AI Generate Backstory"]').trigger('click');
      expect((wrapper.get('[data-testid="field-generator-seed"]').element as HTMLTextAreaElement).value).toBe('');
      expect(wrapper.get('[data-testid="field-generator-generate"]').attributes('disabled')).toBeUndefined();
      await wrapper.get('[data-testid="field-generator-generate"]').trigger('click');
      await flushPromises();
      expect(request).toHaveBeenCalledOnce();
      const input = request.mock.calls[0]![0];
      expect(input).toMatchObject({ field: 'character.backstory', seed: '', characterContext: { kind: 'character', displayName: 'Aster', possessions: ['', '', 'Map'] } });
      expect(FieldGenerationRequestSchema.safeParse(input).success).toBe(true);
      expect(wrapper.find('[role="alert"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="field-generator-preview"]').text()).toBe('A mapmaker in exile.');
      expect(draft.backstory).toBe('');
    } finally {
      wrapper.unmount();
    }
  });

  it('gives every generator the current unsaved character without sharing mutable context', async () => {
    const draft = structuredClone(card);
    const generator = defineComponent({ name: 'FieldGenerator', props: ['field', 'characterContext'], template: '<span />' });
    const wrapper = mount(CharacterForm, { props: { modelValue: draft, generationEnabled: true }, global: { stubs: { FieldGenerator: generator } } });
    const controls = () => wrapper.findAllComponents(generator);
    expect(controls()).toHaveLength(12);
    for (const control of controls()) expect(control.props('characterContext')).toEqual(characterFieldContext(draft));
    const previous = controls()[0]!.props('characterContext');
    await wrapper.get('[data-testid="card-name"]').setValue('Unsaved Aster');
    await wrapper.findAll('input')[1]!.setValue('she/they');
    for (const key of ['appearance', 'personality', 'backstory', 'specialty', 'flaw', 'connection', 'secret']) {
      await wrapper.get(`[data-testid="card-${key}"]`).setValue(`Unsaved ${key}`);
    }
    await wrapper.get('[data-testid="card-trait-force"]').setValue(2);
    await wrapper.findAll('label').find(label => label.text() === 'Possession 2')!.get('input').setValue('');
    for (const control of controls()) expect(control.props('characterContext')).toEqual(characterFieldContext(draft));
    expect(previous).toEqual(characterFieldContext(card));
    expect(card.secret).toBe('The map is a forgery.');
    const replacement = { ...structuredClone(card), displayName: 'Other character', secret: 'Other secret' };
    await wrapper.setProps({ modelValue: replacement });
    for (const control of controls()) {
      expect(control.props('characterContext')).toEqual(characterFieldContext(replacement));
      expect(JSON.stringify(control.props('characterContext'))).not.toContain('Unsaved');
    }
    expect(replacement).toEqual({ ...card, displayName: 'Other character', secret: 'Other secret' });
    wrapper.unmount();
  });

  it.each([false, true])('describes the boxes that need guidance outside their label with generation enabled=%s', generationEnabled => {
    const wrapper = mount(CharacterForm, { props: { modelValue: structuredClone(card), generationEnabled } });
    (wrapper.get('[data-testid="card-more"]').element as HTMLDetailsElement).open = true;
    const mustHaveHelp = ['card-appearance', 'card-specialty', 'card-secret', 'card-trait-force', 'card-trait-finesse', 'card-trait-wits', 'card-trait-presence'];
    for (const testId of mustHaveHelp) expect(wrapper.get(`[data-testid="${testId}"]`).attributes('aria-describedby'), testId).toBeTruthy();
    for (const control of wrapper.findAll('input, textarea, select')) {
      const ids = control.attributes('aria-describedby')?.split(/\s+/) ?? [];
      if (control.element.tagName === 'SELECT') {
        expect(ids).toHaveLength(2);
        expect(wrapper.findAll('[id]').find(node => node.attributes('id') === ids[1])!.text()).toContain('+2, +1, +1, and +0');
      }
      for (const id of ids) {
        const matches = wrapper.findAll('[id]').filter(node => node.attributes('id') === id);
        expect(matches, id).toHaveLength(1);
        expect(matches[0]!.isVisible()).toBe(true);
        expect(matches[0]!.text().length).toBeGreaterThan(15);
        expect(matches[0]!.element.closest('label')).toBeNull();
      }
    }
    expect(wrapper.get('[data-testid="card-name"]').element.closest('label')!.textContent).toBe('Character name');
    const description = (testId: string) => wrapper.findAll('[id]').find(node => node.attributes('id') === wrapper.get(`[data-testid="${testId}"]`).attributes('aria-describedby'))!.text();
    expect(description('card-secret')).toMatch(/owner.*director/i);
    expect(description('card-specialty')).toMatch(/Edge/);
    expect(description('card-appearance')).not.toMatch(/approv/i);
    for (const testId of ['card-personality', 'card-backstory', 'card-flaw', 'card-connection']) expect(wrapper.get(`[data-testid="${testId}"]`).attributes('aria-describedby')).toBeUndefined();
    wrapper.unmount();
  });

  it('gives separate character forms their own description IDs', () => {
    const wrapper = mount(defineComponent({ components: { CharacterForm }, setup: () => ({ first: structuredClone(card), second: structuredClone(card) }), template: '<div><CharacterForm :model-value="first" /><CharacterForm :model-value="second" /></div>' }));
    const descriptions = wrapper.findAll('input, textarea, select').map(control => control.attributes('aria-describedby')).filter(Boolean);
    expect(descriptions.length).toBeGreaterThan(0);
    expect(new Set(descriptions).size).toBe(descriptions.length);
    wrapper.unmount();
  });
});

describe('the short card form', () => {
  const blank = (): CharacterCardDefinition => ({ ...structuredClone(card), displayName: '', appearance: '', pronouns: '' });
  const setDescription = (wrapper: ReturnType<typeof mount>, value: string) => wrapper.get('[data-testid="card-description"]').setValue(value);
  const appearanceOf = (wrapper: ReturnType<typeof mount>) => (wrapper.get('[data-testid="card-appearance"]').element as HTMLTextAreaElement).value;

  it('shows the name, the description and the name-only line, and keeps everything else in a closed fold', () => {
    const wrapper = mount(CharacterForm, { props: { modelValue: blank(), generationEnabled: true, generateCard: vi.fn() }, attachTo: document.body });
    const name = wrapper.get('[data-testid="card-name"]');
    const description = wrapper.get('[data-testid="card-description"]');
    const nameOnly = wrapper.get('[data-testid="card-name-only"]');
    const more = wrapper.get('[data-testid="card-more"]');
    expect(name.element.closest('label')!.textContent).toBe('Character name');
    expect(description.element.closest('label')!.textContent).toContain('Describe your character');
    expect(description.attributes('maxlength')).toBe('1000');
    expect(wrapper.get('[data-testid="write-card"]').text()).toBe('Write my card');
    expect(nameOnly.text()).toBe('Only a name is needed.');
    expect(more.element.tagName).toBe('DETAILS');
    expect((more.element as HTMLDetailsElement).open).toBe(false);
    expect(more.get('summary').text()).toBe('More about your character');
    for (const testId of ['card-appearance', 'card-personality', 'card-backstory', 'card-specialty', 'card-flaw', 'card-connection', 'card-secret', 'card-trait-force']) {
      expect(more.find(`[data-testid="${testId}"]`).exists(), testId).toBe(true);
    }
    expect(more.findAll('input').length).toBe(4);
    expect(more.findAllComponents({ name: 'FieldGenerator' })).toHaveLength(11);
    for (const outside of [name, description, nameOnly]) expect(more.element.contains(outside.element)).toBe(false);
    wrapper.unmount();
  });

  it('never changes the card while the description is typed', async () => {
    const draft = reactive(blank());
    const wrapper = mount(CharacterForm, { props: { modelValue: draft } });
    const before = JSON.stringify(draft);
    await setDescription(wrapper, 'A tall courier');
    await setDescription(wrapper, 'A tall courier with a red scarf');
    expect(draft.appearance).toBe('');
    expect(appearanceOf(wrapper)).toBe('');
    expect(JSON.stringify(draft)).toBe(before);
    wrapper.unmount();
  });

  it('exposes the description as a v-model the parent can read', async () => {
    const wrapper = mount(CharacterForm, { props: { modelValue: reactive(blank()), description: '', 'onUpdate:description': (value: string) => wrapper.setProps({ description: value }) } });
    await setDescription(wrapper, 'A tall courier');
    expect(wrapper.props('description')).toBe('A tall courier');
    wrapper.unmount();
  });

  it('withDescription fills only a blank Appearance', () => {
    const empty = blank();
    const filled = withDescription(empty, '  A tall courier  ');
    expect(filled.appearance).toBe('A tall courier');
    expect(filled).not.toBe(empty);
    expect(empty.appearance).toBe('');
    expect(withDescription({ ...empty, appearance: '   ' }, 'A tall courier').appearance).toBe('A tall courier');
    const written = { ...empty, appearance: 'Short, with a limp' };
    expect(withDescription(written, 'A tall courier')).toBe(written);
    expect(withDescription(empty, '   ')).toBe(empty);
    expect(withDescription(empty, '')).toBe(empty);
  });

  it('clears the description when the generation context changes', async () => {
    const draft = reactive(blank());
    const wrapper = mount(CharacterForm, { props: { modelValue: draft, generationContext: 'one' } });
    await setDescription(wrapper, 'A tall courier');
    await wrapper.setProps({ generationContext: 'two' });
    expect((wrapper.get('[data-testid="card-description"]').element as HTMLTextAreaElement).value).toBe('');
    expect(draft.appearance).toBe('');
    wrapper.unmount();
  });

  it('shows Create portrait only once there is Appearance text or a portrait, after the description', async () => {
    const generatePortrait = vi.fn();
    const props = { picturesEnabled: true, generatePortrait, portraitUrl: (id: string) => `/pictures/${id}` };
    const draft = reactive(blank());
    const wrapper = mount(CharacterForm, { props: { modelValue: draft, generationEnabled: true, generateCard: vi.fn(), ...props } });
    expect(wrapper.findComponent(PortraitGenerator).exists()).toBe(false);
    await setDescription(wrapper, 'A tall courier');
    const block = wrapper.findComponent(PortraitGenerator);
    expect(block.exists()).toBe(true);
    expect(wrapper.get('[data-testid="card-name-only"]').element.nextElementSibling).toBe(block.element);
    expect(wrapper.get('[data-testid="card-description"]').element.compareDocumentPosition(block.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    wrapper.unmount();
    const withPortrait = mount(CharacterForm, { props: { modelValue: { ...blank(), portraitId: '11111111-1111-4111-8111-111111111111' }, ...props } });
    expect(withPortrait.findComponent(PortraitGenerator).exists()).toBe(true);
    withPortrait.unmount();
  });
});

describe('whole-card generation in the form', () => {
  const generated: CharacterCardDefinition = { ...card, displayName: 'Rook', pronouns: 'she/her', appearance: 'Tall and scarred.', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, possessions: ['Knife'], extensions: { fromAi: true } };
  const response = (pronounsSuggested: boolean): CardGenerationResponse => ({ card: generated, notes: [], pronounsSuggested });
  const harness = (generateCard: ReturnType<typeof vi.fn> | undefined, extra: Record<string, unknown> = {}) => defineComponent({
    components: { CharacterForm },
    setup: () => ({ draft: ref<CharacterCardDefinition>({ ...structuredClone(card), extensions: { mine: 1 } }), generateCard, extra }),
    template: '<CharacterForm v-model="draft" :generation-enabled="true" :generate-card="generateCard" card-generation-note="Note here." v-bind="extra" />',
  });
  async function generate(wrapper: ReturnType<typeof mount>) {
    await wrapper.get('[data-testid="card-description"]').setValue('A tough soldier');
    await wrapper.get('[data-testid="write-card"]').trigger('click');
    await flushPromises();
  }

  it('renders the generator only with generation enabled and a generateCard function', () => {
    const on = mount(harness(vi.fn()));
    expect(on.findComponent(CardGenerator).exists()).toBe(true);
    expect(on.findComponent(CardGenerator).props('contextNote')).toBe('Note here.');
    expect(on.findComponent(CardGenerator).props('contextKey')).toBe('character-form');
    on.unmount();
    const none = mount(harness(undefined));
    expect(none.findComponent(CardGenerator).exists()).toBe(false);
    none.unmount();
    const disabledGeneration = mount(harness(vi.fn(), { generationEnabled: false }));
    expect(disabledGeneration.findComponent(CardGenerator).exists()).toBe(false);
    disabledGeneration.unmount();
    const plain = mount(CharacterForm, { props: { modelValue: structuredClone(card), generateCard: vi.fn() } });
    expect(plain.findComponent(CardGenerator).exists()).toBe(false);
    plain.unmount();
  });

  it('keeps exactly twelve field generators and no new button named AI Generate', () => {
    const wrapper = mount(harness(vi.fn()));
    expect(wrapper.findAllComponents({ name: 'FieldGenerator' })).toHaveLength(12);
    expect(wrapper.findAll('button').filter(button => /AI Generate/.test(button.attributes('aria-label') ?? button.text()))).toHaveLength(12);
    wrapper.unmount();
  });

  it('feeds the description to the generator as the prompt', async () => {
    const wrapper = mount(harness(vi.fn()));
    expect(wrapper.findComponent(CardGenerator).props('prompt')).toBe('');
    await wrapper.get('[data-testid="card-description"]').setValue('A tough soldier');
    expect(wrapper.findComponent(CardGenerator).props('prompt')).toBe('A tough soldier');
    wrapper.unmount();
  });

  it('applies a result that finishes after the description was typed, with no stale message', async () => {
    let resolve!: (value: CardGenerationResponse) => void;
    const generateCard = vi.fn().mockReturnValue(new Promise<CardGenerationResponse>(done => { resolve = done; }));
    const wrapper = mount(defineComponent({
      components: { CharacterForm },
      setup: () => ({ draft: ref<CharacterCardDefinition>({ ...structuredClone(card), appearance: '' }), generateCard }),
      template: '<CharacterForm v-model="draft" :generation-enabled="true" :generate-card="generateCard" />',
    }));
    await wrapper.get('[data-testid="card-description"]').setValue('A tough soldier');
    await wrapper.get('[data-testid="write-card"]').trigger('click');
    await wrapper.get('[data-testid="card-description"]').setValue('A tough soldier with a scar');
    expect((wrapper.get('[data-testid="card-appearance"]').element as HTMLTextAreaElement).value).toBe('');
    resolve(response(false));
    await flushPromises();
    expect((wrapper.get('[data-testid="card-name"]').element as HTMLInputElement).value).toBe('Rook');
    expect(wrapper.text()).not.toContain('Your card changed while the AI was writing.');
    wrapper.unmount();
  });

  it('shows the description note only when Appearance has text and the description differs from the one the AI used', async () => {
    const note = (wrapper: ReturnType<typeof mount>) => wrapper.find('[data-testid="card-description-note"]');
    const wrapper = mount(harness(vi.fn().mockResolvedValue(response(false))));
    expect(note(wrapper).exists()).toBe(false);
    await wrapper.get('[data-testid="card-description"]').setValue('A tough soldier');
    expect(note(wrapper).exists()).toBe(true);
    expect(note(wrapper).text()).toBe('This box is only used by Write my card.');
    await wrapper.get('[data-testid="write-card"]').trigger('click');
    await flushPromises();
    expect(note(wrapper).exists()).toBe(false);
    await wrapper.get('[data-testid="card-description"]').setValue('A tough soldier, older');
    expect(note(wrapper).exists()).toBe(true);
    await wrapper.get('[data-testid="card-description"]').setValue('  A tough soldier  ');
    expect(note(wrapper).exists()).toBe(false);
    await wrapper.get('[data-testid="card-description"]').setValue('');
    expect(note(wrapper).exists()).toBe(false);
    wrapper.unmount();
    const empty = mount(CharacterForm, { props: { modelValue: reactive({ ...structuredClone(card), appearance: '' }) } });
    await empty.get('[data-testid="card-description"]').setValue('Only a description');
    expect(empty.find('[data-testid="card-description-note"]').exists()).toBe(false);
    empty.unmount();
  });

  it('sends a blank card that carries only the typed name, so the AI keeps the name and writes the rest', async () => {
    const generateCard = vi.fn().mockResolvedValue(response(false));
    const wrapper = mount(harness(generateCard));
    const generator = wrapper.findComponent(CardGenerator);
    const stable = generator.props('generate');
    await wrapper.get('[data-testid="card-secret"]').setValue('Unsaved secret');
    await wrapper.get('[data-testid="card-name"]').setValue('Unsaved name');
    await generator.props('generate')({ prompt: 'A soldier', keepFilled: true });
    expect(generateCard).toHaveBeenCalledOnce();
    const input = generateCard.mock.calls[0]![0];
    expect(input).toMatchObject({ prompt: 'A soldier', keepFilled: true });
    expect(input.current).toMatchObject({ kind: 'character', displayName: 'Unsaved name', pronouns: '', appearance: '', personality: '', backstory: '', specialty: '', flaw: '', connection: '', secret: '', possessions: [] });
    await wrapper.get('[data-testid="card-name"]').setValue('Another name');
    expect(wrapper.findComponent(CardGenerator).props('generate')).toBe(stable);
    wrapper.unmount();
  });

  it('applies the generated card at once, pads possessions to three and keeps the extensions', async () => {
    const wrapper = mount(harness(vi.fn().mockResolvedValue(response(false))));
    await generate(wrapper);
    expect((wrapper.get('[data-testid="card-name"]').element as HTMLInputElement).value).toBe('Rook');
    expect((wrapper.get('[data-testid="card-appearance"]').element as HTMLTextAreaElement).value).toBe('Tall and scarred.');
    const draft = (wrapper.vm as unknown as { draft: CharacterCardDefinition }).draft;
    expect(draft.possessions).toEqual(['Knife', '', '']);
    expect(draft.extensions).toEqual({ mine: 1 });
    expect(draft.traits).toEqual(generated.traits);
    expect(wrapper.get('[data-testid="card-summary"]').text()).toContain('Rook');
    expect(wrapper.find('[data-testid="card-pronouns-note"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows one line about AI-picked pronouns and never blocks anything', async () => {
    const wrapper = mount(harness(vi.fn().mockResolvedValue(response(true))));
    await generate(wrapper);
    expect(wrapper.get('[data-testid="card-pronouns-note"]').text()).toBe('The AI picked these pronouns. Change them if you like.');
    expect(wrapper.find('[data-testid="keep-suggested-pronouns"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="suggested-pronouns-notice"]').exists()).toBe(false);
    expect(wrapper.get('fieldset').attributes('disabled')).toBeUndefined();
    const draft = (wrapper.vm as unknown as { draft: CharacterCardDefinition }).draft;
    expect(draft.pronouns).toBe('she/her');
    wrapper.unmount();
  });

  it('does not take a pronouns-pending model any more', () => {
    const wrapper = mount(CharacterForm, { props: { modelValue: structuredClone(card) } });
    expect(Object.keys((CharacterForm as unknown as { props: Record<string, unknown> }).props ?? {})).not.toContain('pronounsPending');
    expect(wrapper.html()).not.toContain('Keep these pronouns');
    wrapper.unmount();
  });

  it('restores the previous card on Undo', async () => {
    const wrapper = mount(harness(vi.fn().mockResolvedValue(response(true))));
    await generate(wrapper);
    await wrapper.get('[data-testid="card-generator-undo"]').trigger('click');
    await flushPromises();
    const vm = wrapper.vm as unknown as { draft: CharacterCardDefinition };
    expect(vm.draft).toEqual({ ...card, extensions: { mine: 1 } });
    expect((wrapper.get('[data-testid="card-name"]').element as HTMLInputElement).value).toBe('Aster');
    expect(wrapper.find('[data-testid="card-pronouns-note"]').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('portrait block in the form', () => {
  const portraitId = '11111111-1111-4111-8111-111111111111';
  const newId = '22222222-2222-4222-8222-222222222222';
  const generatePortrait = vi.fn().mockResolvedValue({ imageId: newId });
  const portraitUrl = (id: string) => `/pictures/${id}`;
  const portraitProps = { picturesEnabled: true, generatePortrait, portraitUrl };
  const generated: CharacterCardDefinition = { ...card, displayName: 'Rook', appearance: 'Tall and scarred.', possessions: ['Knife'], extensions: {} };
  let release: ((value: CardGenerationResponse) => void) | undefined;
  const harness = (extra: Record<string, unknown> = {}, start: Partial<CharacterCardDefinition> = {}, deferred = false) => defineComponent({
    components: { CharacterForm },
    setup: () => ({ draft: ref<CharacterCardDefinition>({ ...structuredClone(card), ...start }), generateCard: vi.fn().mockImplementation(() => deferred ? new Promise<CardGenerationResponse>(resolve => { release = resolve; }) : Promise.resolve({ card: generated, notes: [], pronounsSuggested: false })), extra }),
    template: '<CharacterForm v-model="draft" :generation-enabled="true" :generate-card="generateCard" v-bind="extra" />',
  });
  const draftOf = (wrapper: ReturnType<typeof mount>) => (wrapper.vm as unknown as { draft: CharacterCardDefinition }).draft;
  async function makePortrait(wrapper: ReturnType<typeof mount>) {
    await wrapper.get('[data-testid="portrait-create"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="portrait-use"]').trigger('click');
    await flushPromises();
  }
  async function write(wrapper: ReturnType<typeof mount>) {
    await wrapper.get('[data-testid="card-description"]').setValue('A tough soldier');
    await wrapper.get('[data-testid="write-card"]').trigger('click');
    await flushPromises();
  }

  it('shows no portrait block without all three props or when pictures are off', () => {
    for (const extra of [{}, { picturesEnabled: true }, { picturesEnabled: true, generatePortrait }, { picturesEnabled: true, portraitUrl }, { generatePortrait, portraitUrl }, { ...portraitProps, picturesEnabled: false }]) {
      const wrapper = mount(harness(extra));
      expect(wrapper.findComponent(PortraitGenerator).exists()).toBe(false);
      wrapper.unmount();
    }
  });

  it('shows the portrait block below the description when there is Appearance text, with or without AI drafting', () => {
    const wrapper = mount(harness(portraitProps, { portraitId }));
    const block = wrapper.findComponent(PortraitGenerator);
    expect(block.exists()).toBe(true);
    expect(wrapper.get('[data-testid="card-name-only"]').element.nextElementSibling).toBe(block.element);
    expect(block.props('name')).toBe('Aster');
    expect(block.props('portraitId')).toBe(portraitId);
    expect(block.props('details')).toEqual({ appearance: 'A silver coat.', role: 'Navigation', pronouns: 'they/them', name: 'Aster' });
    expect(block.props('imageUrl')).toBe(portraitUrl);
    expect(block.props('generate')).toBe(generatePortrait);
    wrapper.unmount();
    const plain = mount(CharacterForm, { props: { modelValue: structuredClone(card), ...portraitProps } });
    expect(plain.findComponent(PortraitGenerator).exists()).toBe(true);
    plain.unmount();
    const noLook = mount(CharacterForm, { props: { modelValue: { ...structuredClone(card), appearance: '' }, ...portraitProps } });
    expect(noLook.findComponent(PortraitGenerator).exists()).toBe(false);
    noLook.unmount();
  });

  it('puts the portrait on the card when Use this portrait is pressed and takes it off with Remove portrait', async () => {
    const wrapper = mount(harness(portraitProps));
    expect(draftOf(wrapper).portraitId).toBeUndefined();
    await makePortrait(wrapper);
    expect(generatePortrait).toHaveBeenCalledWith({ appearance: 'A silver coat.', role: 'Navigation', pronouns: 'they/them', name: 'Aster' });
    expect(draftOf(wrapper).portraitId).toBe(newId);
    expect(draftOf(wrapper).displayName).toBe('Aster');
    await wrapper.get('[data-testid="portrait-remove"]').trigger('click');
    expect(draftOf(wrapper).portraitId).toBeUndefined();
    expect('portraitId' in draftOf(wrapper)).toBe(false);
    wrapper.unmount();
  });

  it('keeps the portrait when Write my card applies, and Undo keeps it too', async () => {
    const wrapper = mount(harness(portraitProps, { portraitId }));
    await write(wrapper);
    expect(draftOf(wrapper).displayName).toBe('Rook');
    expect(draftOf(wrapper).portraitId).toBe(portraitId);
    await wrapper.get('[data-testid="card-generator-undo"]').trigger('click');
    await flushPromises();
    expect(draftOf(wrapper).displayName).toBe('Aster');
    expect(draftOf(wrapper).portraitId).toBe(portraitId);
    wrapper.unmount();
  });

  it('does not mark a card being written stale when a portrait is used meanwhile', async () => {
    const wrapper = mount(harness(portraitProps, {}, true));
    await write(wrapper);
    await makePortrait(wrapper);
    expect(draftOf(wrapper).portraitId).toBe(newId);
    release!({ card: generated, notes: [], pronounsSuggested: false });
    await flushPromises();
    expect(wrapper.text()).not.toContain('Your card changed while the AI was writing');
    expect(draftOf(wrapper).displayName).toBe('Rook');
    expect(draftOf(wrapper).portraitId).toBe(newId);
    wrapper.unmount();
  });

  it('still marks a card being written stale when another box changes', async () => {
    const wrapper = mount(harness(portraitProps, {}, true));
    await write(wrapper);
    await wrapper.get('[data-testid="card-flaw"]').setValue('Changed');
    release!({ card: generated, notes: [], pronounsSuggested: false });
    await flushPromises();
    expect(wrapper.text()).toContain('Your card changed while the AI was writing');
    expect(draftOf(wrapper).displayName).toBe('Aster');
    wrapper.unmount();
  });
});
