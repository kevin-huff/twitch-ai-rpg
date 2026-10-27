// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardGenerationResponse, CharacterCardDefinition } from '@rpg/contracts';
import CardGenerator from './CardGenerator.vue';

const blank: CharacterCardDefinition = { schemaVersion: 1, displayName: '', pronouns: '', appearance: '', personality: '', backstory: '', traits: { force: 1, finesse: 1, wits: 1, presence: 1 }, specialty: '', flaw: '', possessions: ['', '', ''], connection: '', secret: '', extensions: {} };
const filled: CharacterCardDefinition = { ...blank, displayName: 'Aster', personality: 'Patient.' };
const generated: CharacterCardDefinition = { schemaVersion: 1, displayName: 'Mara Quill', pronouns: 'she/her', appearance: 'A tall woman in a grey coat.', personality: 'Careful and dry.', backstory: 'A former clerk.', traits: { force: 0, finesse: 1, wits: 2, presence: 1 }, specialty: 'Records', flaw: 'Trusts paper', possessions: ['Ledger', 'Lamp'], connection: 'Owes a favor.', secret: 'Forged a seal.', extensions: {} };
const response = (overrides: Partial<CardGenerationResponse> = {}): CardGenerationResponse => ({ card: generated, notes: [], pronounsSuggested: false, ...overrides });
const t = (name: string) => `[data-testid="${name}"]`;
const wrappers: ReturnType<typeof mount>[] = [];
function setup(props: Record<string, unknown> = {}) {
  const generate = vi.fn().mockResolvedValue(response());
  const wrapper = mount(CardGenerator, { props: { card: blank, prompt: 'A clerk who knows too much', contextKey: 'a', generate, ...props } });
  wrappers.push(wrapper);
  return { wrapper, generate };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function write(wrapper: ReturnType<typeof mount>) {
  await wrapper.get(t('write-card')).trigger('click');
  await flushPromises();
}
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });

describe('Write my card', () => {
  it('shows one button and one help line, with no panel, preview or keep checkbox', () => {
    const { wrapper } = setup({ card: filled, contextNote: "The director's instructions are sent too." });
    expect(wrapper.get(t('write-card')).text()).toBe('Write my card');
    expect(wrapper.findAll('button')).toHaveLength(1);
    expect(wrapper.findAll('textarea, input, select')).toHaveLength(0);
    expect(wrapper.text()).toContain("The AI writes the rest of the card from your description and keeps a name you typed. Other players' cards are not sent. The director's instructions are sent too.");
    const described = wrapper.get(t('write-card')).attributes('aria-describedby')!;
    expect(wrapper.get(`[id="${described}"]`).classes()).toContain('field-help');
    for (const gone of ['Create the whole card with AI', "Keep what I've already written", 'Use this character', 'Cancel', 'Preview']) expect(wrapper.text()).not.toContain(gone);
    expect(wrapper.find(t('card-summary')).exists()).toBe(false);
  });

  it('is disabled while the description is blank or the generator is disabled', async () => {
    const { wrapper } = setup({ prompt: '   ' });
    expect(wrapper.get(t('write-card')).attributes('disabled')).toBeDefined();
    await wrapper.setProps({ prompt: 'A clerk' });
    expect(wrapper.get(t('write-card')).attributes('disabled')).toBeUndefined();
    await wrapper.setProps({ disabled: true });
    expect(wrapper.get(t('write-card')).attributes('disabled')).toBeDefined();
  });

  it('sends the trimmed description with keepFilled true, even for an empty card', async () => {
    const { wrapper, generate } = setup({ prompt: '  A clerk  ' });
    await write(wrapper);
    expect(generate).toHaveBeenCalledWith({ prompt: 'A clerk', keepFilled: true });
    const filledSetup = setup({ card: filled });
    await write(filledSetup.wrapper);
    expect(filledSetup.generate).toHaveBeenCalledWith({ prompt: 'A clerk who knows too much', keepFilled: true });
  });

  it('applies at once, then shows the summary with Undo', async () => {
    const pendingResponse = deferred<CardGenerationResponse>();
    const { wrapper } = setup({ generate: vi.fn().mockReturnValue(pendingResponse.promise) });
    await wrapper.get(t('write-card')).trigger('click');
    expect(wrapper.get(t('write-card')).text()).toBe('Writing…');
    expect(wrapper.get(t('write-card')).attributes('disabled')).toBeDefined();
    pendingResponse.resolve(response());
    await flushPromises();
    expect(wrapper.emitted('apply')).toEqual([[response()]]);
    const lines = wrapper.findAll(`${t('card-summary')} .card-generator-line`).map(line => line.text());
    expect(lines).toEqual(['Name: Mara Quill', 'Appearance: A tall woman in a grey coat.', 'Personality: Careful and dry.']);
    expect(wrapper.get(t('card-generator-undo')).text()).toBe('Undo');
    expect(wrapper.get(t('write-card')).text()).toBe('Write my card');
    expect(wrapper.find(t('card-pronouns-note')).exists()).toBe(false);
  });

  it('shows the pronouns note when the AI suggested pronouns, and nothing blocks the card', async () => {
    const { wrapper } = setup({ generate: vi.fn().mockResolvedValue(response({ pronounsSuggested: true })) });
    await write(wrapper);
    expect(wrapper.get(t('card-pronouns-note')).text()).toBe('The AI picked these pronouns. Change them if you like.');
    expect(wrapper.emitted('apply')).toHaveLength(1);
    expect(wrapper.get(t('write-card')).attributes('disabled')).toBeUndefined();
  });

  it('undo emits the previous card and clears the summary', async () => {
    const { wrapper } = setup({ card: filled });
    await write(wrapper);
    await wrapper.get(t('card-generator-undo')).trigger('click');
    expect(wrapper.emitted('undo')).toEqual([[filled]]);
    expect(wrapper.find(t('card-generator-undo')).exists()).toBe(false);
    expect(wrapper.find(t('card-summary')).exists()).toBe(false);
  });

  it('keeps Undo until the card is edited afterwards or the context changes', async () => {
    const holder: { wrapper?: ReturnType<typeof mount> } = {};
    const { wrapper } = setup({ card: filled, onApply: () => { void holder.wrapper!.setProps({ card: generated }); } });
    holder.wrapper = wrapper;
    await write(wrapper);
    expect(wrapper.props('card')).toEqual(generated);
    expect(wrapper.find(t('card-generator-undo')).exists()).toBe(true);
    await wrapper.setProps({ card: { ...generated, flaw: 'Changed later' } });
    expect(wrapper.find(t('card-generator-undo')).exists()).toBe(false);
    expect(wrapper.find(t('card-summary')).exists()).toBe(false);

    const second = setup({ card: filled });
    await write(second.wrapper);
    expect(second.wrapper.find(t('card-generator-undo')).exists()).toBe(true);
    await second.wrapper.setProps({ contextKey: 'b' });
    expect(second.wrapper.find(t('card-generator-undo')).exists()).toBe(false);
    expect(second.wrapper.find(t('card-summary')).exists()).toBe(false);
  });

  it('clears the old summary when a new write starts', async () => {
    const second = deferred<CardGenerationResponse>();
    const generate = vi.fn().mockResolvedValueOnce(response()).mockReturnValueOnce(second.promise);
    const { wrapper } = setup({ generate });
    await write(wrapper);
    expect(wrapper.find(t('card-summary')).exists()).toBe(true);
    await wrapper.get(t('write-card')).trigger('click');
    expect(wrapper.find(t('card-summary')).exists()).toBe(false);
    expect(wrapper.find(t('card-generator-undo')).exists()).toBe(false);
    second.resolve(response({ card: { ...generated, displayName: 'Second' } }));
    await flushPromises();
    expect(wrapper.get(t('card-summary')).text()).toContain('Name: Second');
  });

  it('does not watch the generate prop for Undo', async () => {
    const { wrapper } = setup({ card: filled });
    await write(wrapper);
    await wrapper.setProps({ generate: vi.fn() });
    expect(wrapper.find(t('card-generator-undo')).exists()).toBe(true);
  });

  it('drops a result and says so when the card changed while the AI wrote', async () => {
    const late = deferred<CardGenerationResponse>();
    const { wrapper } = setup({ card: filled, generate: vi.fn().mockReturnValue(late.promise) });
    await wrapper.get(t('write-card')).trigger('click');
    await wrapper.setProps({ card: { ...filled, flaw: 'Edited meanwhile' } });
    late.resolve(response()); await flushPromises();
    expect(wrapper.emitted('apply')).toBeUndefined();
    expect(wrapper.find(t('card-summary')).exists()).toBe(false);
    expect(wrapper.get('[role="alert"]').text()).toBe('Your card changed while the AI was writing. Press Write my card again.');
    expect(wrapper.get(t('write-card')).text()).toBe('Write my card');
  });

  it('ignores a response and a rejection that arrive after the context changes', async () => {
    const late = deferred<CardGenerationResponse>();
    const { wrapper } = setup({ generate: vi.fn().mockReturnValue(late.promise) });
    await wrapper.get(t('write-card')).trigger('click');
    await wrapper.setProps({ contextKey: 'b' });
    expect(wrapper.get('[role="alert"]').text()).toBe('Something on this page changed, so that draft was set aside. Press Write my card again.');
    late.resolve(response()); await flushPromises();
    expect(wrapper.emitted('apply')).toBeUndefined();
    expect(wrapper.find(t('card-summary')).exists()).toBe(false);
    expect(wrapper.get(t('write-card')).text()).toBe('Write my card');
    expect(wrapper.get(t('write-card')).attributes('disabled')).toBeUndefined();

    const failing = deferred<CardGenerationResponse>();
    const second = setup({ generate: vi.fn().mockReturnValue(failing.promise) });
    await second.wrapper.get(t('write-card')).trigger('click');
    await second.wrapper.setProps({ contextKey: 'b' });
    failing.reject(new Error('Late failure')); await flushPromises();
    expect(second.wrapper.text()).not.toContain('Late failure');
  });

  it('shows no context message when the context changes while idle, and the message goes on the next write', async () => {
    const { wrapper } = setup();
    await wrapper.setProps({ contextKey: 'b' });
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);

    const late = deferred<CardGenerationResponse>();
    const generate = vi.fn().mockReturnValueOnce(late.promise).mockResolvedValue(response());
    const second = setup({ generate });
    await second.wrapper.get(t('write-card')).trigger('click');
    await second.wrapper.setProps({ contextKey: 'b' });
    expect(second.wrapper.find('[role="alert"]').exists()).toBe(true);
    await write(second.wrapper);
    expect(second.wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(second.wrapper.emitted('apply')).toHaveLength(1);
  });

  it('shows the rejected message, switches to Try again and recovers', async () => {
    const generate = vi.fn().mockRejectedValueOnce(new Error('The AI took too long. Try again, or fill in the form yourself.')).mockResolvedValue(response());
    const { wrapper } = setup({ generate });
    await write(wrapper);
    expect(wrapper.get('[role="alert"]').text()).toBe('The AI took too long. Try again, or fill in the form yourself.');
    expect(wrapper.get(t('write-card')).text()).toBe('Try again');
    expect(wrapper.emitted('apply')).toBeUndefined();
    await write(wrapper);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get(t('write-card')).text()).toBe('Write my card');
    expect(wrapper.emitted('apply')).toHaveLength(1);
  });

  it('shows a plain sentence for a browser-side validation failure and keeps other messages', async () => {
    const zodLike = Object.assign(new Error('[{"code":"too_big","path":["prompt"]}]'), { issues: [{ code: 'too_big' }] });
    const { wrapper } = setup({ generate: vi.fn().mockRejectedValueOnce(zodLike).mockRejectedValueOnce({ issues: [] }).mockRejectedValueOnce(Object.assign(new Error('Server said no.'), { issues: 'x' })) });
    await write(wrapper);
    expect(wrapper.get('[role="alert"]').text()).toBe('One of the boxes is longer than the form allows. Shorten it, then try again.');
    await write(wrapper);
    expect(wrapper.get('[role="alert"]').text()).toBe('One of the boxes is longer than the form allows. Shorten it, then try again.');
    await write(wrapper);
    expect(wrapper.get('[role="alert"]').text()).toBe('Server said no.');
  });

  it('keeps the button secondary and disables Undo when disabled', async () => {
    const { wrapper } = setup({ card: filled });
    expect(wrapper.get(t('write-card')).classes()).toContain('secondary');
    await write(wrapper);
    await wrapper.setProps({ disabled: true });
    expect(wrapper.get(t('card-generator-undo')).attributes('disabled')).toBeDefined();
    await wrapper.get(t('card-generator-undo')).trigger('click');
    expect(wrapper.emitted('undo')).toBeUndefined();
  });

  it('never gives a control an accessible name containing AI Generate and avoids field generator hooks', async () => {
    const { wrapper } = setup({ card: filled });
    await write(wrapper);
    for (const button of wrapper.findAll('button')) {
      const name = button.attributes('aria-label') ?? button.text();
      expect(name).not.toContain('AI Generate');
    }
    expect(wrapper.html()).not.toContain('field-generator');
    expect(wrapper.html()).not.toContain('generator-panel');
    expect(wrapper.html()).not.toContain('field-ai');
  });
});
