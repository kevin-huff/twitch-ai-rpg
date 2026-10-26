// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, reactive, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CharacterCardDefinitionSchema, FieldGenerationRequestSchema } from '@rpg/contracts';
import type { CardGenerationResponse, CharacterCardDefinition } from '@rpg/contracts';
import CardGenerator from './CardGenerator.vue';
import CharacterForm from './CharacterForm.vue';
import { characterFieldContext } from './field-context';
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

  it.each([false, true])('describes every field outside its label with generation enabled=%s', generationEnabled => {
    const wrapper = mount(CharacterForm, { props: { modelValue: structuredClone(card), generationEnabled } });
    for (const control of wrapper.findAll('input, textarea, select')) {
      const ids = control.attributes('aria-describedby')?.split(/\s+/) ?? [];
      expect(ids.length, control.element.outerHTML).toBeGreaterThan(0);
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
    expect(description('card-backstory')).toMatch(/reference/i);
    expect(description('card-specialty')).toMatch(/Edge/);
    wrapper.unmount();
  });

  it('gives separate character forms their own description IDs', () => {
    const wrapper = mount(defineComponent({ components: { CharacterForm }, setup: () => ({ first: structuredClone(card), second: structuredClone(card) }), template: '<div><CharacterForm :model-value="first" /><CharacterForm :model-value="second" /></div>' }));
    const descriptions = wrapper.findAll('input, textarea, select').map(control => control.attributes('aria-describedby'));
    expect(descriptions.every(Boolean)).toBe(true);
    expect(new Set(descriptions).size).toBe(descriptions.length);
    wrapper.unmount();
  });
});

describe('whole-card generation in the form', () => {
  const generated: CharacterCardDefinition = { ...card, displayName: 'Rook', pronouns: 'she/her', appearance: 'Tall and scarred.', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, possessions: ['Knife'], extensions: { fromAi: true } };
  const response = (pronounsSuggested: boolean): CardGenerationResponse => ({ card: generated, notes: [], pronounsSuggested });
  const harness = (generateCard: ReturnType<typeof vi.fn> | undefined, extra: Record<string, unknown> = {}) => defineComponent({
    components: { CharacterForm },
    setup: () => ({ draft: ref<CharacterCardDefinition>({ ...structuredClone(card), extensions: { mine: 1 } }), pending: ref(false), generateCard, extra }),
    template: '<CharacterForm v-model="draft" v-model:pronouns-pending="pending" :generation-enabled="true" :generate-card="generateCard" card-generation-note="Note here." v-bind="extra" />',
  });
  async function generate(wrapper: ReturnType<typeof mount>) {
    await wrapper.get('[data-testid="card-generator-open"]').trigger('click');
    await wrapper.get('[data-testid="card-generator-prompt"]').setValue('A tough soldier');
    await wrapper.get('[data-testid="card-generator-generate"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="card-generator-apply"]').trigger('click');
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

  it('passes the current unsaved card as context to a stable generate function', async () => {
    const generateCard = vi.fn().mockResolvedValue(response(false));
    const wrapper = mount(harness(generateCard));
    const generator = wrapper.findComponent(CardGenerator);
    const stable = generator.props('generate');
    await wrapper.get('[data-testid="card-secret"]').setValue('Unsaved secret');
    await wrapper.get('[data-testid="card-name"]').setValue('Unsaved name');
    await generator.props('generate')({ prompt: 'A soldier', keepFilled: true });
    expect(generateCard).toHaveBeenCalledOnce();
    const input = generateCard.mock.calls[0]![0];
    expect(input).toMatchObject({ prompt: 'A soldier', keepFilled: true, current: { kind: 'character', displayName: 'Unsaved name', secret: 'Unsaved secret' } });
    await wrapper.get('[data-testid="card-name"]').setValue('Another name');
    expect(wrapper.findComponent(CardGenerator).props('generate')).toBe(stable);
    wrapper.unmount();
  });

  it('applies the generated card, pads possessions to three and keeps the extensions', async () => {
    const wrapper = mount(harness(vi.fn().mockResolvedValue(response(false))));
    await generate(wrapper);
    expect((wrapper.get('[data-testid="card-name"]').element as HTMLInputElement).value).toBe('Rook');
    expect((wrapper.get('[data-testid="card-appearance"]').element as HTMLTextAreaElement).value).toBe('Tall and scarred.');
    const draft = (wrapper.vm as unknown as { draft: CharacterCardDefinition }).draft;
    expect(draft.possessions).toEqual(['Knife', '', '']);
    expect(draft.extensions).toEqual({ mine: 1 });
    expect(draft.traits).toEqual(generated.traits);
    expect(wrapper.find('[data-testid="suggested-pronouns-notice"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows the suggested-pronouns notice right after the Pronouns help and clears it with Keep these pronouns', async () => {
    const wrapper = mount(harness(vi.fn().mockResolvedValue(response(true))));
    await generate(wrapper);
    const vm = wrapper.vm as unknown as { pending: boolean };
    expect(vm.pending).toBe(true);
    const notice = wrapper.get('[data-testid="suggested-pronouns-notice"]');
    expect(notice.text()).toBe('The AI suggested these pronouns. Keep them or change them.');
    const help = wrapper.get('[data-testid="card-name"]').element.closest('.field-grid')!.querySelectorAll('.field-help')[1]!;
    expect(help.nextElementSibling).toBe(notice.element.parentElement);
    expect(wrapper.get('[data-testid="keep-suggested-pronouns"]').text()).toBe('Keep these pronouns');
    await wrapper.get('[data-testid="keep-suggested-pronouns"]').trigger('click');
    expect(vm.pending).toBe(false);
    expect(wrapper.find('[data-testid="suggested-pronouns-notice"]').exists()).toBe(false);
    expect((wrapper.findAll('input').find(input => input.attributes('maxlength') === '80' && (input.element as HTMLInputElement).value === 'she/her'))).toBeTruthy();
    wrapper.unmount();
  });

  it('clears the pending state when the pronouns are changed away from the suggestion', async () => {
    const wrapper = mount(harness(vi.fn().mockResolvedValue(response(true))));
    await generate(wrapper);
    const vm = wrapper.vm as unknown as { pending: boolean };
    expect(vm.pending).toBe(true);
    const pronouns = wrapper.get('[data-testid="card-name"]').element.closest('.field-grid')!.querySelectorAll('input')[1]! as HTMLInputElement;
    pronouns.value = 'xe/xem'; pronouns.dispatchEvent(new Event('input'));
    await flushPromises();
    expect(vm.pending).toBe(false);
    expect(wrapper.find('[data-testid="keep-suggested-pronouns"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('restores the previous card and clears pending on Undo', async () => {
    const wrapper = mount(harness(vi.fn().mockResolvedValue(response(true))));
    await generate(wrapper);
    await wrapper.get('[data-testid="card-generator-undo"]').trigger('click');
    await flushPromises();
    const vm = wrapper.vm as unknown as { pending: boolean; draft: CharacterCardDefinition };
    expect(vm.pending).toBe(false);
    expect(vm.draft).toEqual({ ...card, extensions: { mine: 1 } });
    expect((wrapper.get('[data-testid="card-name"]').element as HTMLInputElement).value).toBe('Aster');
    expect(wrapper.find('[data-testid="suggested-pronouns-notice"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
