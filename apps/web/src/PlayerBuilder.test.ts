// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlayerBuilder from './PlayerBuilder.vue';
import CharacterForm from './CharacterForm.vue';
import FieldGenerator from './FieldGenerator.vue';
import CardGenerator from './CardGenerator.vue';

const transport = vi.hoisted(() => ({ accessCharacterBuilder: vi.fn(), characterBuilder: vi.fn(), saveCharacterBuilder: vi.fn(), submitCharacterBuilder: vi.fn(), logoutCharacterBuilder: vi.fn(), generateCharacterBuilderField: vi.fn(), generateBuilderCard: vi.fn(), createBuilderPortrait: vi.fn(), generateField: vi.fn(), library: vi.fn(), sessions: vi.fn() }));
vi.mock('./api', () => ({ api: transport }));
const card = { schemaVersion: 1, displayName: 'Aster', pronouns: 'they/them', appearance: '', personality: '', backstory: '', traits: { force: 0, finesse: 2, wits: 1, presence: 1 }, specialty: '', flaw: '', possessions: [], connection: '', secret: 'Own private words', extensions: {} };
const snapshot = () => ({ id: 'builder-one', label: 'Alex', instructions: 'Bring an explorer.', revision: 3, draft: structuredClone(card), expiresAt: '2026-11-21T12:00:00.000Z', submittedTemplate: null });
beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState({}, '', `/build-character?identity=${'a'.repeat(32)}`);
  transport.characterBuilder.mockResolvedValue(snapshot());
  transport.accessCharacterBuilder.mockResolvedValue({ identityId: 'b'.repeat(32), builder: snapshot() });
  transport.saveCharacterBuilder.mockImplementation(async input => ({ ...snapshot(), revision: 4, draft: input.draft }));
  transport.submitCharacterBuilder.mockImplementation(async input => ({ ...snapshot(), revision: 4, draft: input.draft, submittedTemplate: { templateId: 'own-card', version: 1 } }));
  transport.generateCharacterBuilderField.mockResolvedValue({ text: 'A proposed courier history.' });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('private character builder', () => {
  const backstoryGenerator = (wrapper: ReturnType<typeof mount>) => wrapper.findAllComponents(FieldGenerator).find(generator => generator.props('field') === 'character.backstory')!;
  it('generates with current unsaved card fields and instructions, applying only to the local draft', async () => {
    const wrapper = mount(PlayerBuilder); await flushPromises();
    await wrapper.get('[data-testid="card-name"]').setValue('Unsaved Aster');
    await wrapper.get('[data-testid="card-secret"]').setValue('Unsaved private secret');
    const generator = backstoryGenerator(wrapper);
    expect(generator).toBeDefined();
    expect(generator.props('instructions')).toBe('Bring an explorer.');
    await generator.get('[data-testid="field-generator-open"]').trigger('click');
    await generator.get('[data-testid="field-generator-generate"]').trigger('click'); await flushPromises();
    expect(transport.generateCharacterBuilderField).toHaveBeenCalledWith({ expectedRevision: 3, field: 'character.backstory', seed: '', characterContext: {
      kind: 'character', displayName: 'Unsaved Aster', pronouns: card.pronouns, appearance: '', personality: '', backstory: '', traits: card.traits, specialty: '', flaw: '', possessions: [], connection: '', secret: 'Unsaved private secret',
    } });
    expect((wrapper.get('[data-testid="card-backstory"]').element as HTMLTextAreaElement).value).toBe('');
    await generator.get('[data-testid="field-generator-apply"]').trigger('click');
    expect((wrapper.get('[data-testid="card-backstory"]').element as HTMLTextAreaElement).value).toBe('A proposed courier history.');
    expect(transport.generateField).not.toHaveBeenCalled();
    expect(transport.saveCharacterBuilder).not.toHaveBeenCalled();
    expect(transport.submitCharacterBuilder).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="save-builder-draft"]').trigger('click'); await flushPromises();
    expect(transport.saveCharacterBuilder).toHaveBeenCalledWith(expect.objectContaining({ draft: expect.objectContaining({ backstory: 'A proposed courier history.' }) }));
    wrapper.unmount();
  });

  it.each(['success', 'conflict'])('discards a pending AI %s after save and uses the new revision for another generation', async result => {
    let finish!: (value: { text: string }) => void;
    let fail!: (reason: unknown) => void;
    transport.generateCharacterBuilderField.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    const wrapper = mount(PlayerBuilder); await flushPromises();
    const generator = backstoryGenerator(wrapper);
    expect(generator).toBeDefined();
    await generator.get('[data-testid="field-generator-open"]').trigger('click');
    await generator.get('[data-testid="field-generator-generate"]').trigger('click'); await flushPromises();
    await wrapper.get('[data-testid="save-builder-draft"]').trigger('click'); await flushPromises();
    if (result === 'success') finish({ text: 'Stale output' });
    else fail(Object.assign(new Error('This draft changed. Reload it before generating.'), { status: 409 }));
    await flushPromises();
    expect(wrapper.find('[data-testid="field-generator-preview"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="reload-builder-draft"]').exists()).toBe(false);
    await generator.get('[data-testid="field-generator-open"]').trigger('click');
    await generator.get('[data-testid="field-generator-generate"]').trigger('click'); await flushPromises();
    expect(transport.generateCharacterBuilderField.mock.calls[1]![0].expectedRevision).toBe(4);
    wrapper.unmount();
  });

  it('preserves edits and blocks generation after a stale-revision response until reload', async () => {
    transport.generateCharacterBuilderField.mockRejectedValue(Object.assign(new Error('This draft changed. Reload it before generating.'), { status: 409 }));
    const wrapper = mount(PlayerBuilder); await flushPromises();
    await wrapper.get('[data-testid="card-name"]').setValue('Keep my words');
    const generator = backstoryGenerator(wrapper);
    expect(generator).toBeDefined();
    await generator.get('[data-testid="field-generator-open"]').trigger('click');
    await generator.get('[data-testid="field-generator-generate"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('Reload');
    expect(wrapper.find('[data-testid="reload-builder-draft"]').exists()).toBe(true);
    expect(wrapper.findAllComponents(FieldGenerator)).toHaveLength(0);
    expect((wrapper.get('[data-testid="card-name"]').element as HTMLInputElement).value).toBe('Keep my words');
    wrapper.unmount();
  });
  it('scrubs the token before access and selects only the returned builder identity', async () => {
    window.history.replaceState({}, '', `/build-character?identity=${'a'.repeat(32)}#token=private%2Ftoken`);
    transport.accessCharacterBuilder.mockImplementation(async token => {
      expect(token).toBe('private/token');
      expect(window.location.hash).toBe('');
      expect(window.location.search).toBe('');
      return { identityId: 'b'.repeat(32), builder: snapshot() };
    });
    const wrapper = mount(PlayerBuilder); await flushPromises();
    expect(window.location.href).toContain(`/build-character?identity=${'b'.repeat(32)}`);
    expect(transport.characterBuilder).not.toHaveBeenCalled();
    expect(transport.library).not.toHaveBeenCalled(); expect(transport.sessions).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Bring an explorer.');
    expect(wrapper.findComponent(CharacterForm).props('generationEnabled')).toBe(true);
    wrapper.unmount();
  });

  it('saves incomplete progress with its revision and preserves blank and sparse possessions', async () => {
    const wrapper = mount(PlayerBuilder); await flushPromises();
    await wrapper.get('[data-testid="card-name"]').setValue('');
    await wrapper.get('[data-testid="card-trait-force"]').setValue(2);
    await wrapper.findAll('label').find(label => label.text() === 'Possession 3')!.get('input').setValue('Map');
    await wrapper.get('[data-testid="save-builder-draft"]').trigger('click'); await flushPromises();
    expect(transport.saveCharacterBuilder).toHaveBeenCalledWith({ commandId: expect.any(String), expectedRevision: 3, draft: { ...card, displayName: '', traits: { ...card.traits, force: 2 }, possessions: ['', '', 'Map'] } });
    expect(wrapper.get('[role="status"]').text()).toContain('Progress saved');
    wrapper.unmount();
  });

  it('submits the visible unsaved form atomically, filters empty possessions and freezes the result', async () => {
    const wrapper = mount(PlayerBuilder); await flushPromises();
    expect(wrapper.text()).toMatch(/cannot edit.*after submitting/i);
    await wrapper.get('[data-testid="card-name"]').setValue('Unsaved Aster');
    await wrapper.findAll('label').find(label => label.text() === 'Possession 3')!.get('input').setValue('Map');
    await wrapper.get('[data-testid="submit-builder-card"]').trigger('click'); await flushPromises();
    expect(transport.saveCharacterBuilder).not.toHaveBeenCalled();
    expect(transport.submitCharacterBuilder).toHaveBeenCalledWith({ commandId: expect.any(String), expectedRevision: 3, draft: { ...card, displayName: 'Unsaved Aster', possessions: ['Map'] } });
    expect(wrapper.text()).toContain('Submitted to the director');
    expect(wrapper.text()).toContain('Available in the director’s character library');
    expect(wrapper.text()).not.toContain('own-card'); expect(wrapper.text()).toContain('version 1');
    expect(wrapper.get('[data-testid="card-name"]').element.matches(':disabled')).toBe(true);
    expect(wrapper.find('[data-testid="submit-builder-card"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it.each(['name', 'traits'])('rejects an invalid %s on submission without losing edits', async field => {
    const wrapper = mount(PlayerBuilder); await flushPromises();
    await wrapper.get('[data-testid="card-backstory"]').setValue('Unfinished words');
    await wrapper.get(field === 'name' ? '[data-testid="card-name"]' : '[data-testid="card-trait-force"]').setValue(field === 'name' ? '' : 2);
    await wrapper.get('[data-testid="submit-builder-card"]').trigger('click'); await flushPromises();
    expect(transport.submitCharacterBuilder).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain('+2, +1, +1, and +0');
    expect(wrapper.get('[role="alert"]').text()).toContain(field === 'name' ? 'displayName' : 'traits');
    expect((wrapper.get('[data-testid="card-backstory"]').element as HTMLTextAreaElement).value).toBe('Unfinished words');
    wrapper.unmount();
  });

  it.each(['save', 'submit'])('identifies an overlong appearance locally on %s and preserves the draft', async action => {
    const wrapper = mount(PlayerBuilder); await flushPromises();
    const words = 'a'.repeat(1001);
    await wrapper.get('[data-testid="card-appearance"]').setValue(words);
    await wrapper.get(action === 'save' ? '[data-testid="save-builder-draft"]' : '[data-testid="submit-builder-card"]').trigger('click'); await flushPromises();
    expect(transport.saveCharacterBuilder).not.toHaveBeenCalled();
    expect(transport.submitCharacterBuilder).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain('appearance');
    expect(wrapper.get('[role="alert"]').text()).toContain('1000');
    expect(wrapper.get('[role="alert"]').text()).not.toContain('+2, +1, +1, and +0');
    expect((wrapper.get('[data-testid="card-appearance"]').element as HTMLTextAreaElement).value).toBe(words);
    wrapper.unmount();
  });

  it('preserves unsaved words on conflicts until the explicit saved-draft reload', async () => {
    transport.saveCharacterBuilder.mockRejectedValue(Object.assign(new Error('A newer draft exists.'), { status: 409 }));
    const wrapper = mount(PlayerBuilder); await flushPromises();
    await wrapper.get('[data-testid="card-name"]').setValue('Keep my words');
    await wrapper.get('[data-testid="save-builder-draft"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('A newer draft exists.');
    expect((wrapper.get('[data-testid="card-name"]').element as HTMLInputElement).value).toBe('Keep my words');
    expect(transport.characterBuilder).toHaveBeenCalledTimes(1);
    await wrapper.get('[aria-label="Dismiss error"]').trigger('click');
    expect(wrapper.get('[data-testid="reload-builder-draft"]').text()).toBe('Reload saved draft');
    transport.characterBuilder.mockResolvedValue({ ...snapshot(), revision: 9, draft: { ...card, displayName: 'New saved words' } });
    await wrapper.get('[data-testid="reload-builder-draft"]').trigger('click'); await flushPromises();
    expect((wrapper.get('[data-testid="card-name"]').element as HTMLInputElement).value).toBe('New saved words');
    wrapper.unmount();
  });

  it('retains the draft and retry command after a failed submission', async () => {
    transport.submitCharacterBuilder.mockRejectedValueOnce(new Error('Connection lost'));
    const wrapper = mount(PlayerBuilder); await flushPromises();
    await wrapper.get('[data-testid="card-name"]').setValue('My final words');
    await wrapper.get('[data-testid="submit-builder-card"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('Connection lost');
    expect((wrapper.get('[data-testid="card-name"]').element as HTMLInputElement).value).toBe('My final words');
    await wrapper.get('[aria-label="Dismiss error"]').trigger('click');
    await wrapper.get('[data-testid="submit-builder-card"]').trigger('click'); await flushPromises();
    expect(transport.submitCharacterBuilder.mock.calls[1]).toEqual(transport.submitCharacterBuilder.mock.calls[0]);
    wrapper.unmount();
  });

  it('shows an access failure without exposing another identity or fetching its data', async () => {
    window.history.replaceState({}, '', '/build-character#token=expired');
    transport.accessCharacterBuilder.mockRejectedValue(new Error('This link expired.'));
    const wrapper = mount(PlayerBuilder); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('This link expired.');
    expect(wrapper.findComponent(CharacterForm).exists()).toBe(false);
    expect(transport.characterBuilder).not.toHaveBeenCalled();
    expect(window.location.hash).toBe(''); wrapper.unmount();
  });

  it('uses the saved revision on later submission and locks fields while the request is pending', async () => {
    const wrapper = mount(PlayerBuilder); await flushPromises();
    await wrapper.get('[data-testid="save-builder-draft"]').trigger('click'); await flushPromises();
    let finish!: (value: unknown) => void;
    transport.submitCharacterBuilder.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await wrapper.get('[data-testid="card-name"]').setValue('After saving');
    await wrapper.get('[data-testid="submit-builder-card"]').trigger('click'); await flushPromises();
    expect(transport.submitCharacterBuilder).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 4, draft: expect.objectContaining({ displayName: 'After saving' }) }));
    expect(wrapper.get('[data-testid="card-name"]').element.matches(':disabled')).toBe(true);
    expect(wrapper.get('[data-testid="save-builder-draft"]').attributes('disabled')).toBeDefined();
    finish({ ...snapshot(), revision: 5, draft: { ...card, displayName: 'After saving' }, submittedTemplate: { templateId: 'own-card', version: 1 } });
    await flushPromises();
    expect(wrapper.text()).toContain('Submitted to the director'); wrapper.unmount();
  });

  it('returns directly to the submitted read-only card with the selected identity', async () => {
    transport.characterBuilder.mockResolvedValue({ ...snapshot(), submittedTemplate: { templateId: 'own-card', version: 1 } });
    const wrapper = mount(PlayerBuilder); await flushPromises();
    expect(transport.accessCharacterBuilder).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Submitted to the director');
    expect(wrapper.get('[data-testid="card-name"]').element.matches(':disabled')).toBe(true);
    expect(wrapper.find('[data-testid="save-builder-draft"]').exists()).toBe(false);
    expect(wrapper.findAllComponents(FieldGenerator)).toHaveLength(0);
    wrapper.unmount();
  });

  it('rejects ambiguous token fragments after scrubbing them without making an access request', async () => {
    window.history.replaceState({}, '', '/build-character#token=first&token=second');
    const wrapper = mount(PlayerBuilder); await flushPromises();
    expect(window.location.hash).toBe(''); expect(transport.accessCharacterBuilder).not.toHaveBeenCalled();
    expect(transport.characterBuilder).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain('incomplete'); wrapper.unmount();
  });

  describe('whole card generation', () => {
    const response = (pronounsSuggested = false) => ({ card: { ...card, displayName: 'Generated', pronouns: 'she/her' }, notes: [], pronounsSuggested });
    async function generateWhole(wrapper: ReturnType<typeof mount>) {
      await wrapper.get('[data-testid="card-generator-open"]').trigger('click');
      await wrapper.get('[data-testid="card-generator-prompt"]').setValue('A courier');
      await wrapper.get('[data-testid="card-generator-generate"]').trigger('click'); await flushPromises();
    }
    it('sends only the allowed fields and shows the instructions note', async () => {
      transport.generateBuilderCard.mockResolvedValue(response());
      const wrapper = mount(PlayerBuilder); await flushPromises();
      await generateWhole(wrapper);
      expect(wrapper.text()).toContain("The director's instructions are sent too.");
      expect(transport.generateBuilderCard).toHaveBeenCalledTimes(1);
      const body = transport.generateBuilderCard.mock.calls[0][0];
      expect(Object.keys(body).sort()).toEqual(['current', 'expectedRevision', 'keepFilled', 'prompt']);
      expect(body.expectedRevision).toBe(3);
      expect(body.prompt).toBe('A courier');
      wrapper.unmount();
    });
    it('shows the reload notice on a 409', async () => {
      transport.generateBuilderCard.mockRejectedValue(Object.assign(new Error('This draft changed. Reload it before generating.'), { status: 409 }));
      const wrapper = mount(PlayerBuilder); await flushPromises();
      await generateWhole(wrapper);
      expect(wrapper.find('[data-testid="reload-builder-draft"]').exists()).toBe(true);
      wrapper.unmount();
    });
    it('blocks submit while pronouns are pending but not save, and keeps the block after saving', async () => {
      transport.generateBuilderCard.mockResolvedValue(response(true));
      const wrapper = mount(PlayerBuilder); await flushPromises();
      await generateWhole(wrapper);
      await wrapper.get('[data-testid="card-generator-apply"]').trigger('click'); await flushPromises();
      const submit = () => wrapper.get('[data-testid="submit-builder-card"]');
      expect(submit().attributes('disabled')).toBeDefined();
      expect(wrapper.find('[data-testid="pronouns-pending-notice"]').exists()).toBe(true);
      const saveButton = wrapper.get('[data-testid="save-builder-draft"]');
      expect(saveButton.attributes('disabled')).toBeUndefined();
      await saveButton.trigger('click'); await flushPromises();
      expect(transport.saveCharacterBuilder).toHaveBeenCalledTimes(1);
      expect(submit().attributes('disabled')).toBeDefined();
      expect(wrapper.find('[data-testid="pronouns-pending-notice"]').exists()).toBe(true);
      await wrapper.get('[data-testid="keep-suggested-pronouns"]').trigger('click'); await flushPromises();
      expect(submit().attributes('disabled')).toBeUndefined();
      wrapper.unmount();
    });
    it('renders no card generator after submit', async () => {
      const wrapper = mount(PlayerBuilder); await flushPromises();
      await wrapper.get('[data-testid="submit-builder-card"]').trigger('click'); await flushPromises();
      expect(wrapper.findComponent(CardGenerator).exists()).toBe(false);
      expect(wrapper.find('[data-testid="card-generator-open"]').exists()).toBe(false);
      wrapper.unmount();
    });
  });

  describe('portraits', () => {
    const withPictures = () => transport.characterBuilder.mockResolvedValue({ ...snapshot(), picturesEnabled: true });
    it('shows the portrait block only when pictures are on', async () => {
      const off = mount(PlayerBuilder); await flushPromises();
      expect(off.find('[data-testid="portrait-create"]').exists()).toBe(false);
      expect(off.findComponent(CharacterForm).props('picturesEnabled')).toBe(false);
      off.unmount();
      withPictures();
      const on = mount(PlayerBuilder); await flushPromises();
      expect(on.findComponent(CharacterForm).props('picturesEnabled')).toBe(true);
      expect(on.findComponent(CharacterForm).props('portraitUrl')!('abc')).toContain('/api/character-builder/images/abc');
      expect(on.find('[data-testid="portrait-create"]').exists()).toBe(true);
      on.unmount();
    });
    it('marks the saved draft as changed when making a portrait gets a 409', async () => {
      withPictures();
      transport.createBuilderPortrait.mockRejectedValue(Object.assign(new Error('This draft changed. Reload it before generating.'), { status: 409 }));
      const wrapper = mount(PlayerBuilder); await flushPromises();
      await wrapper.get('[data-testid="card-appearance"]').setValue('Tall, with a red scarf');
      await wrapper.get('[data-testid="portrait-create"]').trigger('click'); await flushPromises();
      expect(transport.createBuilderPortrait).toHaveBeenCalledWith({ expectedRevision: 3, details: expect.objectContaining({ appearance: 'Tall, with a red scarf' }) });
      expect(wrapper.find('[data-testid="reload-builder-draft"]').exists()).toBe(true);
      wrapper.unmount();
    });
    it('sends the portrait when submitting to the director', async () => {
      withPictures();
      transport.createBuilderPortrait.mockResolvedValue({ imageId: '11111111-1111-4111-8111-111111111111' });
      const wrapper = mount(PlayerBuilder); await flushPromises();
      await wrapper.get('[data-testid="card-name"]').setValue('Aster');
      await wrapper.get('[data-testid="card-appearance"]').setValue('Tall, with a red scarf');
      await wrapper.get('[data-testid="portrait-create"]').trigger('click'); await flushPromises();
      await wrapper.get('[data-testid="portrait-use"]').trigger('click'); await flushPromises();
      await wrapper.get('[data-testid="submit-builder-card"]').trigger('click'); await flushPromises();
      expect(transport.submitCharacterBuilder).toHaveBeenCalledWith(expect.objectContaining({ draft: expect.objectContaining({ portraitId: '11111111-1111-4111-8111-111111111111' }) }));
      wrapper.unmount();
    });
  });
});
