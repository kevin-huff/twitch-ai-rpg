// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardGenerationResponse, CharacterCardDefinition, ScenarioDefinition, TemplateVersion } from '@rpg/contracts';

const api = vi.hoisted(() => ({ generateCard: vi.fn(), saveCharacterTemplate: vi.fn(), createCustom: vi.fn() }));
vi.mock('./api', () => ({ api }));

import ShowForm from './ShowForm.vue';

const scenario = (title = 'The Ledger Job', premise = 'A vault, a ledger and a bad night.') => ({
  ref: { templateId: 'scn-1', version: 1 },
  definition: { schemaVersion: 1, title, premise, genre: '', tone: '', boundaries: [] } as unknown as ScenarioDefinition,
});
const card = (displayName: string): CharacterCardDefinition => ({ schemaVersion: 1, displayName, pronouns: 'they/them', appearance: '', personality: '', backstory: '', traits: { force: 1, finesse: 1, wits: 2, presence: 0 }, specialty: '', flaw: '', possessions: [], connection: '', secret: '', extensions: {} });
const saved: TemplateVersion<CharacterCardDefinition>[] = [{ id: 'card-9', version: 3, definition: card('Rook') }];
const generated = (name: string): CardGenerationResponse => ({ card: card(name), notes: [], pronounsSuggested: true });
const t = (name: string) => `[data-testid="${name}"]`;
const wrappers: ReturnType<typeof mount>[] = [];
function setup(props: Record<string, unknown> = {}) {
  const wrapper = mount(ShowForm, { props: { scenario: scenario(), cards: saved, ...props } });
  wrappers.push(wrapper);
  return wrapper;
}
async function choose(wrapper: ReturnType<typeof mount>, index: number, kind: string, sentence?: string) {
  await wrapper.get(t(`make-seat-kind-${index}`)).setValue(kind);
  if (sentence !== undefined) await wrapper.get(t(`make-seat-describe-${index}`)).setValue(sentence);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  api.generateCard.mockReset(); api.saveCharacterTemplate.mockReset(); api.createCustom.mockReset();
  api.createCustom.mockResolvedValue({ sessionId: 'show-1' });
  let counter = 0;
  api.saveCharacterTemplate.mockImplementation(async ({ definition }: { definition: CharacterCardDefinition }) => ({ id: `new-${++counter}`, version: 1, definition }));
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });

describe('show form', () => {
  it('starts with the story title and four player-written seats', () => {
    const wrapper = setup();
    expect((wrapper.get(t('show-title')).element as HTMLInputElement).value).toBe('The Ledger Job');
    expect(wrapper.get(t('show-title')).attributes('maxlength')).toBe('160');
    for (let index = 0; index < 4; index += 1) expect((wrapper.get(t(`make-seat-kind-${index}`)).element as HTMLSelectElement).value).toBe('player');
    expect(wrapper.find(t('make-seat-kind-4')).exists()).toBe(false);
    const options = wrapper.get(t('make-seat-kind-0')).findAll('option');
    expect(options.map(option => [option.attributes('value'), option.text()])).toEqual([['player', 'Player writes their own'], ['describe', 'Describe a character'], ['card', 'Use a saved card']]);
  });

  it('refills the title when the story changes', async () => {
    const wrapper = setup();
    await wrapper.get(t('show-title')).setValue('My own title');
    await wrapper.setProps({ scenario: { ...scenario('Another Story'), ref: { templateId: 'scn-2', version: 1 } } });
    expect((wrapper.get(t('show-title')).element as HTMLInputElement).value).toBe('Another Story');
  });

  it('allows between two and six seats', async () => {
    const wrapper = setup();
    expect(wrapper.text()).toContain('Add a seat');
    await wrapper.get(t('make-add-seat')).trigger('click');
    await wrapper.get(t('make-add-seat')).trigger('click');
    expect(wrapper.findAll('[data-testid^="make-seat-kind-"]')).toHaveLength(6);
    expect(wrapper.find(t('make-add-seat')).exists()).toBe(false);
    for (let count = 6; count > 2; count -= 1) await wrapper.get(t('make-seat-remove-0')).trigger('click');
    expect(wrapper.findAll('[data-testid^="make-seat-kind-"]')).toHaveLength(2);
    expect(wrapper.find(t('make-seat-remove-0')).exists()).toBe(false);
    expect(wrapper.find(t('make-add-seat')).exists()).toBe(true);
  });

  it('shows the sentence box or the saved card list for the chosen kind', async () => {
    const wrapper = setup();
    expect(wrapper.find(t('make-seat-describe-0')).exists()).toBe(false);
    await choose(wrapper, 0, 'describe');
    expect(wrapper.get(t('make-seat-describe-0')).attributes('maxlength')).toBe('4000');
    expect(wrapper.text()).toContain('One sentence about this character');
    await choose(wrapper, 1, 'card');
    expect(wrapper.get(t('make-seat-card-1')).findAll('option').map(option => option.text())).toEqual(['Choose a saved card', 'Rook · version 3']);
  });

  it('creates the show with every seat kind and emits the new show id', async () => {
    api.generateCard.mockResolvedValue(generated('Mara'));
    const wrapper = setup();
    await choose(wrapper, 1, 'describe', '  A nervous clerk  ');
    await choose(wrapper, 2, 'card');
    await wrapper.get(t('make-seat-card-2')).setValue('card-9:3');
    await wrapper.get(t('show-title')).setValue('  Night Shift  ');
    await wrapper.get(t('create-show')).trigger('click');
    await flushPromises();
    expect(api.generateCard).toHaveBeenCalledTimes(1);
    expect(api.generateCard).toHaveBeenCalledWith({ prompt: 'A nervous clerk', keepFilled: true, premise: 'A vault, a ledger and a bad night.' });
    expect(api.saveCharacterTemplate).toHaveBeenCalledWith({ expectedVersion: 0, definition: card('Mara') });
    expect(api.createCustom).toHaveBeenCalledWith('Night Shift', { templateId: 'scn-1', version: 1 }, [
      { playerWritten: true }, { templateId: 'new-1', version: 1 }, { templateId: 'card-9', version: 3 }, { playerWritten: true },
    ]);
    expect(wrapper.emitted('created')).toEqual([['show-1']]);
  });

  it('leaves the premise out when the story has none or it is too long', async () => {
    api.generateCard.mockResolvedValue(generated('Mara'));
    for (const premise of ['   ', 'x'.repeat(4001)]) {
      api.generateCard.mockClear();
      const wrapper = setup({ scenario: scenario('S', premise) });
      await choose(wrapper, 0, 'describe', 'A clerk');
      await wrapper.get(t('create-show')).trigger('click');
      await flushPromises();
      expect(api.generateCard).toHaveBeenCalledWith({ prompt: 'A clerk', keepFilled: true });
    }
  });

  it('writes every described seat at once and shows Writing this card on each', async () => {
    const first = deferred<CardGenerationResponse>();
    const second = deferred<CardGenerationResponse>();
    api.generateCard.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const wrapper = setup();
    await choose(wrapper, 0, 'describe', 'A clerk');
    await choose(wrapper, 1, 'describe', 'A guard');
    await wrapper.get(t('create-show')).trigger('click');
    await flushPromises();
    expect(api.generateCard).toHaveBeenCalledTimes(2);
    expect(wrapper.get(t('make-seat-status-0')).text()).toBe('Writing this card…');
    expect(wrapper.get(t('make-seat-status-1')).text()).toBe('Writing this card…');
    expect(wrapper.get(t('create-show')).attributes('disabled')).toBeDefined();
    second.resolve(generated('Bram'));
    await flushPromises();
    expect(wrapper.get(t('make-seat-status-0')).text()).toBe('Writing this card…');
    expect(wrapper.find(t('make-seat-status-1')).exists()).toBe(false);
    expect(api.createCustom).not.toHaveBeenCalled();
    first.resolve(generated('Mara'));
    await flushPromises();
    expect(api.createCustom).toHaveBeenCalledTimes(1);
    expect(api.createCustom.mock.calls[0][2].slice(0, 2)).toEqual([{ templateId: 'new-2', version: 1 }, { templateId: 'new-1', version: 1 }]);
  });

  it('stops on a missing title, sentence or card before calling the AI', async () => {
    const wrapper = setup();
    await wrapper.get(t('show-title')).setValue('   ');
    await wrapper.get(t('create-show')).trigger('click');
    expect(wrapper.get(t('make-form-error')).text()).toBe('Give the show a title.');
    await wrapper.get(t('show-title')).setValue('Title');
    await choose(wrapper, 0, 'describe', '  ');
    await wrapper.get(t('create-show')).trigger('click');
    expect(wrapper.get(t('make-form-error')).text()).toContain('Seat 1');
    await choose(wrapper, 0, 'player');
    await choose(wrapper, 1, 'card');
    await wrapper.get(t('create-show')).trigger('click');
    expect(wrapper.get(t('make-form-error')).text()).toContain('Seat 2');
    expect(api.generateCard).not.toHaveBeenCalled();
    expect(api.createCustom).not.toHaveBeenCalled();
  });

  it('shows a failed seat with Try again, keeps the finished seat, and creates after the retry', async () => {
    api.generateCard.mockResolvedValueOnce(generated('Mara')).mockRejectedValueOnce(new Error('AI is down'));
    const wrapper = setup();
    await choose(wrapper, 0, 'describe', 'A clerk');
    await choose(wrapper, 1, 'describe', 'A guard');
    await wrapper.get(t('create-show')).trigger('click');
    await flushPromises();
    expect(wrapper.get(t('make-seat-status-1')).text()).toBe("Couldn't write this card.");
    expect(wrapper.get(t('make-seat-retry-1')).text()).toBe('Try again');
    expect(wrapper.get(t('make-seat-let-player-1')).text()).toBe('Let the player write it');
    expect(api.createCustom).not.toHaveBeenCalled();
    expect(api.saveCharacterTemplate).toHaveBeenCalledTimes(1);

    api.generateCard.mockResolvedValueOnce(generated('Bram'));
    await wrapper.get(t('make-seat-retry-1')).trigger('click');
    await flushPromises();
    expect(api.generateCard).toHaveBeenCalledTimes(3);
    expect(api.generateCard).toHaveBeenLastCalledWith({ prompt: 'A guard', keepFilled: true, premise: 'A vault, a ledger and a bad night.' });
    expect(api.createCustom.mock.calls[0][2].slice(0, 2)).toEqual([{ templateId: 'new-1', version: 1 }, { templateId: 'new-2', version: 1 }]);
    expect(wrapper.emitted('created')).toEqual([['show-1']]);
  });

  it('checks the title and sentences again when Try again is pressed', async () => {
    api.generateCard.mockResolvedValueOnce(generated('Mara')).mockRejectedValueOnce(new Error('AI is down'));
    const wrapper = setup();
    await choose(wrapper, 0, 'describe', 'A clerk');
    await choose(wrapper, 1, 'describe', 'A guard');
    await wrapper.get(t('create-show')).trigger('click');
    await flushPromises();
    expect(wrapper.find(t('make-seat-retry-1')).exists()).toBe(true);
    const writes = api.generateCard.mock.calls.length;
    const saves = api.saveCharacterTemplate.mock.calls.length;

    await wrapper.get(t('show-title')).setValue('');
    await wrapper.get(t('make-seat-retry-1')).trigger('click');
    await flushPromises();
    expect(wrapper.get(t('make-form-error')).text()).toBe('Give the show a title.');

    await wrapper.get(t('show-title')).setValue('Title');
    await wrapper.get(t('make-seat-describe-0')).setValue('   ');
    await wrapper.get(t('make-seat-retry-1')).trigger('click');
    await flushPromises();
    expect(wrapper.get(t('make-form-error')).text()).toBe('Seat 1: write one sentence about this character, or let the player write it.');
    expect(api.generateCard).toHaveBeenCalledTimes(writes);
    expect(api.saveCharacterTemplate).toHaveBeenCalledTimes(saves);
    expect(api.createCustom).not.toHaveBeenCalled();
  });

  it('lets the player write a failed seat, then creates without rewriting finished seats', async () => {
    api.generateCard.mockResolvedValueOnce(generated('Mara')).mockRejectedValueOnce(new Error('AI is down'));
    const wrapper = setup();
    await choose(wrapper, 0, 'describe', 'A clerk');
    await choose(wrapper, 1, 'describe', 'A guard');
    await wrapper.get(t('create-show')).trigger('click');
    await flushPromises();
    await wrapper.get(t('make-seat-let-player-1')).trigger('click');
    expect((wrapper.get(t('make-seat-kind-1')).element as HTMLSelectElement).value).toBe('player');
    expect(wrapper.find(t('make-seat-status-1')).exists()).toBe(false);
    await wrapper.get(t('create-show')).trigger('click');
    await flushPromises();
    expect(api.generateCard).toHaveBeenCalledTimes(2);
    expect(api.createCustom.mock.calls[0][2].slice(0, 2)).toEqual([{ templateId: 'new-1', version: 1 }, { playerWritten: true }]);
    expect(wrapper.emitted('created')).toEqual([['show-1']]);
  });

  it('does not rewrite finished seats when Create show is pressed again after a failed creation', async () => {
    api.generateCard.mockResolvedValue(generated('Mara'));
    api.createCustom.mockRejectedValueOnce(new Error('Could not create the show.'));
    const wrapper = setup();
    await choose(wrapper, 0, 'describe', 'A clerk');
    await wrapper.get(t('create-show')).trigger('click');
    await flushPromises();
    expect(wrapper.get(t('make-form-error')).text()).toBe('Could not create the show.');
    await wrapper.get(t('create-show')).trigger('click');
    await flushPromises();
    expect(api.generateCard).toHaveBeenCalledTimes(1);
    expect(api.saveCharacterTemplate).toHaveBeenCalledTimes(1);
    expect(api.createCustom).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted('created')).toEqual([['show-1']]);
  });

  it('writes a seat again after its sentence changes', async () => {
    api.generateCard.mockResolvedValue(generated('Mara'));
    api.createCustom.mockRejectedValueOnce(new Error('Could not create the show.'));
    const wrapper = setup();
    await choose(wrapper, 0, 'describe', 'A clerk');
    await wrapper.get(t('create-show')).trigger('click');
    await flushPromises();
    await wrapper.get(t('make-seat-describe-0')).setValue('A different clerk');
    await wrapper.get(t('create-show')).trigger('click');
    await flushPromises();
    expect(api.generateCard).toHaveBeenCalledTimes(2);
  });

  it('writes both cards on Try again when another seat was edited after a failure', async () => {
    api.generateCard.mockRejectedValueOnce(new Error('AI is down')).mockResolvedValueOnce(generated('Bram'));
    const wrapper = setup();
    await choose(wrapper, 0, 'describe', 'A clerk');
    await choose(wrapper, 1, 'describe', 'A guard');
    await wrapper.get(t('create-show')).trigger('click');
    await flushPromises();
    expect(wrapper.get(t('make-seat-status-0')).text()).toBe("Couldn't write this card.");
    await wrapper.get(t('make-seat-describe-1')).setValue('A different guard');
    api.generateCard.mockReset();
    api.generateCard.mockResolvedValueOnce(generated('Mara')).mockResolvedValueOnce(generated('Bram'));
    await wrapper.get(t('make-seat-retry-0')).trigger('click');
    await flushPromises();
    expect(api.generateCard).toHaveBeenCalledTimes(2);
    expect(api.createCustom).toHaveBeenCalledTimes(1);
    expect(api.createCustom.mock.calls[0][2].slice(0, 2)).toEqual([{ templateId: 'new-2', version: 1 }, { templateId: 'new-3', version: 1 }]);
    expect(wrapper.emitted('created')).toEqual([['show-1']]);
  });

  it('names the seat that still needs its card when a retry fails again', async () => {
    api.generateCard.mockRejectedValue(new Error('AI is down'));
    const wrapper = setup();
    await choose(wrapper, 0, 'describe', 'A clerk');
    await choose(wrapper, 1, 'describe', 'A guard');
    await wrapper.get(t('create-show')).trigger('click');
    await flushPromises();
    await wrapper.get(t('make-seat-describe-1')).setValue('A different guard');
    await wrapper.get(t('make-seat-retry-0')).trigger('click');
    await flushPromises();
    expect(wrapper.get(t('make-seat-status-0')).text()).toBe("Couldn't write this card.");
    expect(wrapper.get(t('make-form-error')).text()).toBe('Seat 1 still needs its card written.');
    expect(api.createCustom).not.toHaveBeenCalled();
  });
});
