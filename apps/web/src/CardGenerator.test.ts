// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardGenerationResponse, CharacterCardDefinition } from '@rpg/contracts';
import CardGenerator from './CardGenerator.vue';

const blank: CharacterCardDefinition = { schemaVersion: 1, displayName: '', pronouns: '', appearance: '', personality: '', backstory: '', traits: { force: 1, finesse: 1, wits: 1, presence: 1 }, specialty: '', flaw: '', possessions: ['', '', ''], connection: '', secret: '', extensions: {} };
const filled: CharacterCardDefinition = { ...blank, displayName: 'Aster', personality: 'Patient.' };
const generated: CharacterCardDefinition = { schemaVersion: 1, displayName: 'Mara Quill', pronouns: 'she/her', appearance: 'A tall woman in a grey coat.', personality: 'Careful and dry.', backstory: 'A former clerk.', traits: { force: 0, finesse: 1, wits: 2, presence: 1 }, specialty: 'Records', flaw: 'Trusts paper', possessions: ['Ledger', 'Lamp'], connection: 'Owes a favor.', secret: 'Forged a seal.', extensions: {} };
const response = (overrides: Partial<CardGenerationResponse> = {}): CardGenerationResponse => ({ card: generated, notes: [], pronounsSuggested: false, ...overrides });
const t = (name: string) => `[data-testid="card-generator-${name}"]`;
const wrappers: ReturnType<typeof mount>[] = [];
function setup(props: Record<string, unknown> = {}) {
  const generate = vi.fn().mockResolvedValue(response());
  const wrapper = mount(CardGenerator, { props: { card: blank, contextKey: 'a', generate, ...props } });
  wrappers.push(wrapper);
  return { wrapper, generate };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function run(wrapper: ReturnType<typeof mount>, text = 'A clerk who knows too much') {
  await wrapper.get(t('open')).trigger('click');
  await wrapper.get(t('prompt')).setValue(text);
  await wrapper.get(t('generate')).trigger('click');
  await flushPromises();
}
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });

describe('card generator panel', () => {
  it('shows only the open button until opened, then an empty prompt with a disabled Generate', async () => {
    const { wrapper } = setup();
    expect(wrapper.get(t('open')).text()).toBe('Create the whole card with AI');
    expect(wrapper.find(t('prompt')).exists()).toBe(false);
    await wrapper.get(t('open')).trigger('click');
    const prompt = wrapper.get(t('prompt'));
    expect((prompt.element as HTMLTextAreaElement).value).toBe('');
    expect(prompt.attributes('maxlength')).toBe('4000');
    expect(wrapper.get('label').text()).toContain('Describe your character');
    expect(wrapper.get(t('generate')).attributes('disabled')).toBeDefined();
    await prompt.setValue('   ');
    expect(wrapper.get(t('generate')).attributes('disabled')).toBeDefined();
    await prompt.setValue('A clerk');
    expect(wrapper.get(t('generate')).attributes('disabled')).toBeUndefined();
  });

  it('hides the Keep checkbox for an empty card and sends keepFilled false', async () => {
    const { wrapper, generate } = setup();
    await run(wrapper, '  A clerk  ');
    expect(wrapper.find(t('keep')).exists()).toBe(false);
    expect(generate).toHaveBeenCalledWith({ prompt: 'A clerk', keepFilled: false });
  });

  it('shows the Keep checkbox checked when the card has text and sends its value', async () => {
    const { wrapper, generate } = setup({ card: filled });
    await wrapper.get(t('open')).trigger('click');
    const keep = wrapper.get(t('keep'));
    expect((keep.element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.get('label.card-generator-keep').text()).toBe("Keep what I've already written");
    await wrapper.get(t('prompt')).setValue('A clerk');
    await wrapper.get(t('generate')).trigger('click'); await flushPromises();
    expect(generate).toHaveBeenLastCalledWith({ prompt: 'A clerk', keepFilled: true });
    await keep.setValue(false);
    await wrapper.get(t('generate')).trigger('click'); await flushPromises();
    expect(generate).toHaveBeenLastCalledWith({ prompt: 'A clerk', keepFilled: false });
  });

  it('shows Writing while waiting and the exact preview lines afterwards', async () => {
    const pendingResponse = deferred<CardGenerationResponse>();
    const generate = vi.fn().mockReturnValue(pendingResponse.promise);
    const { wrapper } = setup({ generate });
    await wrapper.get(t('open')).trigger('click');
    await wrapper.get(t('prompt')).setValue('A clerk');
    await wrapper.get(t('generate')).trigger('click');
    expect(wrapper.get(t('generate')).text()).toBe('Writing…');
    expect(wrapper.get(t('generate')).attributes('disabled')).toBeDefined();
    pendingResponse.resolve(response({ notes: ['Kept what you already wrote.'] }));
    await flushPromises();
    const lines = wrapper.findAll(`${t('preview')} li`).map(item => item.text());
    expect(lines).toEqual([
      'Name: Mara Quill', 'Pronouns: she/her', 'Look: A tall woman in a grey coat.', 'Personality: Careful and dry.',
      'Best at Wits +2, weakest at Force +0, the other two +1', 'Possessions: Ledger, Lamp', 'Kept what you already wrote.',
    ]);
    expect(wrapper.get(t('apply')).text()).toBe('Use this character');
    expect(wrapper.get(t('generate')).text()).toBe('Generate');
  });

  it('labels suggested and blank pronouns and empty possessions', async () => {
    const suggested = setup({ generate: vi.fn().mockResolvedValue(response({ pronounsSuggested: true })) });
    await run(suggested.wrapper);
    expect(suggested.wrapper.get(t('preview')).text()).toContain('Pronouns (suggested): she/her');
    const blankCard = setup({ generate: vi.fn().mockResolvedValue(response({ card: { ...generated, pronouns: '', possessions: [] } })) });
    await run(blankCard.wrapper);
    const text = blankCard.wrapper.get(t('preview')).text();
    expect(text).toContain('Pronouns: left blank');
    expect(text).toContain('Possessions: none');
  });

  it('shows the rejected message, switches to Try again and recovers', async () => {
    const generate = vi.fn().mockRejectedValueOnce(new Error('The AI took too long. Try again, or fill in the form yourself.')).mockResolvedValue(response());
    const { wrapper } = setup({ generate });
    await run(wrapper);
    expect(wrapper.get('[role="alert"]').text()).toBe('The AI took too long. Try again, or fill in the form yourself.');
    expect(wrapper.get(t('generate')).text()).toBe('Try again');
    expect(wrapper.find(t('apply')).exists()).toBe(false);
    await wrapper.get(t('generate')).trigger('click'); await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find(t('apply')).exists()).toBe(true);
  });

  it('emits apply, closes the panel and offers Undo with the previous card', async () => {
    const { wrapper } = setup({ card: filled });
    await run(wrapper);
    await wrapper.get(t('apply')).trigger('click'); await flushPromises();
    expect(wrapper.emitted('apply')).toEqual([[response()]]);
    expect(wrapper.find(t('prompt')).exists()).toBe(false);
    expect(wrapper.get(t('open')).attributes('disabled')).toBeUndefined();
    await wrapper.get(t('undo')).trigger('click');
    expect(wrapper.emitted('undo')).toEqual([[filled]]);
    expect(wrapper.find(t('undo')).exists()).toBe(false);
  });

  it('keeps Undo until the card changes again or the context changes', async () => {
    const holder: { wrapper?: ReturnType<typeof mount> } = {};
    const { wrapper } = setup({ card: filled, onApply: () => { void holder.wrapper!.setProps({ card: generated }); } });
    holder.wrapper = wrapper;
    await run(wrapper);
    await wrapper.get(t('apply')).trigger('click'); await flushPromises();
    expect(wrapper.props('card')).toEqual(generated);
    expect(wrapper.find(t('undo')).exists()).toBe(true);
    await wrapper.setProps({ card: { ...generated, flaw: 'Changed later' } });
    expect(wrapper.find(t('undo')).exists()).toBe(false);

    const second = setup({ card: filled });
    await run(second.wrapper);
    await second.wrapper.get(t('apply')).trigger('click'); await flushPromises();
    expect(second.wrapper.find(t('undo')).exists()).toBe(true);
    await second.wrapper.setProps({ contextKey: 'b' });
    expect(second.wrapper.find(t('undo')).exists()).toBe(false);
  });

  it('does not watch the generate prop for Undo', async () => {
    const { wrapper } = setup({ card: filled });
    await run(wrapper);
    await wrapper.get(t('apply')).trigger('click'); await flushPromises();
    await wrapper.setProps({ generate: vi.fn() });
    expect(wrapper.find(t('undo')).exists()).toBe(true);
  });

  it('shows the stale message instead of applying when the card changed while the AI wrote', async () => {
    const { wrapper } = setup({ card: filled });
    await run(wrapper);
    await wrapper.setProps({ card: { ...filled, flaw: 'Edited meanwhile' } });
    await wrapper.get(t('apply')).trigger('click'); await flushPromises();
    expect(wrapper.emitted('apply')).toBeUndefined();
    expect(wrapper.get('[role="alert"]').text()).toBe('Your card changed while the AI was writing. Generate again.');
    expect(wrapper.find(t('apply')).exists()).toBe(false);
    await wrapper.setProps({ card: filled });
    await wrapper.get(t('generate')).trigger('click'); await flushPromises();
    await wrapper.setProps({ card: { ...filled, flaw: 'Edited meanwhile' } });
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('ignores a response that arrives after Cancel', async () => {
    const late = deferred<CardGenerationResponse>();
    const { wrapper } = setup({ generate: vi.fn().mockReturnValue(late.promise) });
    await wrapper.get(t('open')).trigger('click');
    await wrapper.get(t('prompt')).setValue('A clerk');
    await wrapper.get(t('generate')).trigger('click');
    await wrapper.get(t('cancel')).trigger('click');
    late.resolve(response()); await flushPromises();
    expect(wrapper.find(t('preview')).exists()).toBe(false);
    await wrapper.get(t('open')).trigger('click');
    expect(wrapper.find(t('preview')).exists()).toBe(false);
    expect(wrapper.get(t('generate')).text()).toBe('Generate');
  });

  it('ignores a response and a rejection that arrive after the context changes', async () => {
    const late = deferred<CardGenerationResponse>();
    const { wrapper } = setup({ generate: vi.fn().mockReturnValue(late.promise) });
    await wrapper.get(t('open')).trigger('click');
    await wrapper.get(t('prompt')).setValue('A clerk');
    await wrapper.get(t('generate')).trigger('click');
    await wrapper.setProps({ contextKey: 'b' });
    late.resolve(response()); await flushPromises();
    expect(wrapper.find(t('prompt')).exists()).toBe(true);
    expect(wrapper.find(t('preview')).exists()).toBe(false);
    expect(wrapper.get(t('generate')).text()).toBe('Generate');

    const failing = deferred<CardGenerationResponse>();
    const second = setup({ generate: vi.fn().mockReturnValue(failing.promise) });
    await second.wrapper.get(t('open')).trigger('click');
    await second.wrapper.get(t('prompt')).setValue('A clerk');
    await second.wrapper.get(t('generate')).trigger('click');
    await second.wrapper.setProps({ contextKey: 'b' });
    failing.reject(new Error('Late failure')); await flushPromises();
    expect(second.wrapper.text()).not.toContain('Late failure');
  });

  it('keeps the typed description through Cancel, reopen and a context change, and clears it after Use this character', async () => {
    const { wrapper } = setup({ card: filled });
    await wrapper.get(t('open')).trigger('click');
    await wrapper.get(t('prompt')).setValue('A clerk who knows too much');
    await wrapper.get(t('cancel')).trigger('click');
    await wrapper.get(t('open')).trigger('click');
    expect((wrapper.get(t('prompt')).element as HTMLTextAreaElement).value).toBe('A clerk who knows too much');
    await wrapper.setProps({ contextKey: 'b' });
    expect(wrapper.find(t('prompt')).exists()).toBe(true);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect((wrapper.get(t('prompt')).element as HTMLTextAreaElement).value).toBe('A clerk who knows too much');
    await wrapper.get(t('cancel')).trigger('click');
    await wrapper.setProps({ contextKey: 'c' });
    expect(wrapper.find(t('prompt')).exists()).toBe(false);
    await wrapper.get(t('open')).trigger('click');
    expect((wrapper.get(t('prompt')).element as HTMLTextAreaElement).value).toBe('A clerk who knows too much');
    await wrapper.get(t('generate')).trigger('click'); await flushPromises();
    await wrapper.get(t('apply')).trigger('click'); await flushPromises();
    await wrapper.get(t('open')).trigger('click');
    expect((wrapper.get(t('prompt')).element as HTMLTextAreaElement).value).toBe('');
  });

  it('keeps the panel open, drops the preview and says so when the context changes with a preview or a pending request', async () => {
    const sentence = 'Something on this page changed, so that draft was set aside. Press Generate again.';
    const { wrapper, generate } = setup();
    await run(wrapper);
    expect(wrapper.find(t('preview')).exists()).toBe(true);
    await wrapper.setProps({ contextKey: 'b' });
    expect(wrapper.find(t('preview')).exists()).toBe(false);
    expect(wrapper.find(t('apply')).exists()).toBe(false);
    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toBe(sentence);
    expect(alert.element.tagName).toBe('P');
    expect(alert.classes()).toContain('notice');
    await wrapper.get(t('generate')).trigger('click'); await flushPromises();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).not.toContain(sentence);

    const late = deferred<CardGenerationResponse>();
    const second = setup({ generate: vi.fn().mockReturnValue(late.promise) });
    await second.wrapper.get(t('open')).trigger('click');
    await second.wrapper.get(t('prompt')).setValue('A clerk');
    await second.wrapper.get(t('generate')).trigger('click');
    await second.wrapper.setProps({ contextKey: 'b' });
    expect(second.wrapper.get('[role="alert"]').text()).toBe(sentence);
    late.resolve(response()); await flushPromises();
    expect(second.wrapper.find(t('preview')).exists()).toBe(false);
    await second.wrapper.get(t('cancel')).trigger('click');
    await second.wrapper.get(t('open')).trigger('click');
    expect(second.wrapper.text()).not.toContain(sentence);

    const closed = setup();
    await closed.wrapper.setProps({ contextKey: 'b' });
    expect(closed.wrapper.find(t('prompt')).exists()).toBe(false);
    expect(closed.wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('shows a plain sentence for a browser-side validation failure and keeps other messages', async () => {
    const zodLike = Object.assign(new Error('[{"code":"too_big","path":["prompt"]}]'), { issues: [{ code: 'too_big' }] });
    const { wrapper } = setup({ generate: vi.fn().mockRejectedValueOnce(zodLike).mockRejectedValueOnce({ issues: [] }).mockRejectedValueOnce(Object.assign(new Error('Server said no.'), { issues: 'x' })) });
    await run(wrapper);
    expect(wrapper.get('[role="alert"]').text()).toBe('One of the boxes is longer than the form allows. Shorten it, then try again.');
    await wrapper.get(t('generate')).trigger('click'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('One of the boxes is longer than the form allows. Shorten it, then try again.');
    await wrapper.get(t('generate')).trigger('click'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('Server said no.');
  });

  it('keeps Generate secondary and Use this character gold', async () => {
    const { wrapper } = setup();
    await wrapper.get(t('open')).trigger('click');
    expect(wrapper.get(t('generate')).classes()).toContain('secondary');
    await wrapper.get(t('prompt')).setValue('A clerk');
    await wrapper.get(t('generate')).trigger('click'); await flushPromises();
    expect(wrapper.get(t('generate')).classes()).toContain('secondary');
    expect(wrapper.get(t('apply')).classes()).not.toContain('secondary');
    expect(wrapper.get(t('apply')).classes()).not.toContain('quiet');
  });

  it('disables every button when disabled', async () => {
    const { wrapper } = setup({ card: filled });
    await run(wrapper);
    await wrapper.setProps({ disabled: true });
    for (const button of wrapper.findAll('button')) expect(button.attributes('disabled')).toBeDefined();
    await wrapper.get(t('apply')).trigger('click');
    expect(wrapper.emitted('apply')).toBeUndefined();
    expect(setup({ disabled: true }).wrapper.get(t('open')).attributes('disabled')).toBeDefined();
  });

  it('links one visible help paragraph to each input and uses the exact texts', async () => {
    const { wrapper } = setup({ card: filled, contextNote: "The director's instructions are sent too." });
    await wrapper.get(t('open')).trigger('click');
    const controls = wrapper.findAll('textarea, input, select');
    expect(controls).toHaveLength(2);
    const ids = new Set<string>();
    for (const control of controls) {
      const described = control.attributes('aria-describedby')!;
      expect(described.split(/\s+/)).toHaveLength(1);
      expect(ids.has(described)).toBe(false); ids.add(described);
      const help = wrapper.get(`[id="${described}"]`);
      expect(help.element.tagName).toBe('P');
      expect(help.classes()).toContain('field-help');
      expect(help.text().length).toBeGreaterThan(20);
      expect(control.element.closest('label')?.contains(help.element)).toBe(false);
    }
    expect(wrapper.get(`[id="${wrapper.get(t('prompt')).attributes('aria-describedby')}"]`).text()).toBe(
      "Say who this character is in a few words or a few sentences. The AI fills in every box and picks the traits. The card's current text, including the private secret, is sent to the AI. Other players' cards are not. The director's instructions are sent too.");
    expect(wrapper.get(`[id="${wrapper.get(t('keep')).attributes('aria-describedby')}"]`).text()).toBe('Leave this on to keep every box you already filled in. The AI writes only the empty ones. It always picks the four traits again.');
    expect(wrapper.text()).toContain('Use this character fills in the form. Nothing is saved or sent until you press your usual save or submit button.');
    expect(wrapper.get(t('cancel')).text()).toBe('Cancel');
  });

  it('never gives a control an accessible name containing AI Generate and avoids field generator hooks', async () => {
    const { wrapper } = setup({ card: filled });
    await run(wrapper);
    await wrapper.get(t('apply')).trigger('click'); await flushPromises();
    await wrapper.get(t('open')).trigger('click');
    for (const button of wrapper.findAll('button')) {
      const name = button.attributes('aria-label') ?? button.text();
      expect(name).not.toContain('AI Generate');
    }
    expect(wrapper.html()).not.toContain('field-generator');
    expect(wrapper.html()).not.toContain('generator-panel');
    expect(wrapper.html()).not.toContain('field-ai');
  });
});
