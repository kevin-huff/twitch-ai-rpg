// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, reactive } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CharacterCardDefinitionSchema, FieldGenerationRequestSchema } from '@rpg/contracts';
import type { CharacterCardDefinition } from '@rpg/contracts';
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
