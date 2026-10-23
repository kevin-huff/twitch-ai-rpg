// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, reactive } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIELD_GENERATION_FIELDS } from '@rpg/contracts';
import type { FieldGenerationField } from '@rpg/contracts';
import FieldGenerator from './FieldGenerator.vue';
import { api } from './api';

const field = Object.keys(FIELD_GENERATION_FIELDS)[0] as FieldGenerationField;
const label = FIELD_GENERATION_FIELDS[field].label;
const selector = (name: string) => `[data-testid="field-generator-${name}"]`;
const wrappers: ReturnType<typeof mount>[] = [];
function editor(props: Record<string, unknown> = {}) {
  const wrapper = mount(FieldGenerator, { props: { field, modelValue: 'Original words', contextKey: 'card:1', ...props } });
  wrappers.push(wrapper);
  return wrapper;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
async function generate(wrapper: ReturnType<typeof mount>, seed = 'A quiet harbor after a storm') {
  await wrapper.get(selector('open')).trigger('click');
  await wrapper.get(selector('seed')).setValue(seed);
  await wrapper.get(selector('generate')).trigger('click');
}
beforeEach(() => { window.history.replaceState({}, '', '/'); });
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('private character drafting options', () => {
  it('uses the supplied callback with trimmed instructions and current private character context', async () => {
    const defaultRequest = vi.spyOn(api, 'generateField').mockResolvedValue({ text: 'Wrong route' });
    const request = vi.fn().mockResolvedValue({ text: 'A private suggestion' });
    const characterContext = { kind: 'character', displayName: 'Unsaved Aster', secret: 'Own unfinished secret' };
    const wrapper = editor({ field: 'character.backstory', generate: request, instructions: '  Build an explorer.  ', characterContext });
    await generate(wrapper, 'Keep this direction'); await flushPromises();
    expect(defaultRequest).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith({ field: 'character.backstory', seed: 'Keep this direction', instructions: 'Build an explorer.', characterContext });
    expect(wrapper.text()).toContain('Director’s character instructions are also sent');
    expect(wrapper.text()).toContain('including private notes');
    expect(wrapper.find(selector('source')).exists()).toBe(false);
    expect(wrapper.get(selector('preview')).text()).toBe('A private suggestion');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    await wrapper.get(selector('apply')).trigger('click');
    expect(wrapper.emitted('update:modelValue')).toEqual([['A private suggestion']]);
  });

  it('allows an empty field to use instructions alone without claiming only the description is sent', async () => {
    const request = vi.fn().mockResolvedValue({ text: 'Aster' });
    const wrapper = editor({ field: 'character.displayName', modelValue: '', instructions: '  A space explorer  ', generate: request });
    await wrapper.get(selector('open')).trigger('click');
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeUndefined();
    expect(wrapper.text()).not.toContain('Only this description is sent');
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    expect(request).toHaveBeenCalledWith({ field: 'character.displayName', seed: '', instructions: 'A space explorer' });
  });

  it('omits blank instructions and keeps the default transport when no callback is supplied', async () => {
    const request = vi.spyOn(api, 'generateField').mockResolvedValue({ text: 'A draft' });
    const wrapper = editor({ field: 'character.appearance', instructions: ' \n ' });
    await generate(wrapper, 'A silver cloak'); await flushPromises();
    expect(request).toHaveBeenCalledWith({ field: 'character.appearance', seed: 'A silver cloak' });
    expect(wrapper.text()).not.toContain('Director’s character instructions are also sent');
  });

  it('rejects oversized instructions locally and accepts the trimmed 4000-character boundary', async () => {
    const request = vi.fn().mockResolvedValue({ text: 'A draft' });
    const wrapper = editor({ field: 'character.appearance', instructions: 'x'.repeat(4001), generate: request });
    await wrapper.get(selector('open')).trigger('click');
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeDefined();
    expect(wrapper.get('[role="alert"]').text()).toMatch(/instructions/i);
    await wrapper.get(selector('generate')).trigger('click'); expect(request).not.toHaveBeenCalled();
    await wrapper.setProps({ instructions: `  ${'x'.repeat(4000)}  ` });
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    expect(request).toHaveBeenCalledWith({ field: 'character.appearance', seed: 'Original words', instructions: 'x'.repeat(4000) });
  });

  it('still requires an explicit pronoun description when instructions are present', async () => {
    const request = vi.fn().mockResolvedValue({ text: 'they/them' });
    const wrapper = editor({ field: 'character.pronouns', modelValue: '', instructions: 'A space explorer', generate: request });
    await wrapper.get(selector('open')).trigger('click');
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeDefined();
    await wrapper.get(selector('generate')).trigger('click'); expect(request).not.toHaveBeenCalled();
    await wrapper.get(selector('seed')).setValue('they/them');
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    expect(request).toHaveBeenCalledWith({ field: 'character.pronouns', seed: 'they/them', instructions: 'A space explorer' });
  });

  it.each(['instructions', 'generate'] as const)('discards pending results and previews when %s changes, keeping the description', async key => {
    const pending = deferred<{ text: string }>();
    const request = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ text: 'New preview' });
    vi.spyOn(api, 'generateField').mockReturnValueOnce(pending.promise).mockResolvedValue({ text: 'Wrong route' });
    const replacement = vi.fn().mockResolvedValue({ text: 'Replacement preview' });
    const initial = key === 'instructions' ? 'Original guidance' : request;
    const changed = key === 'instructions' ? 'Changed guidance' : replacement;
    const wrapper = editor({ field: 'character.appearance', instructions: 'Original guidance', generate: request });
    await generate(wrapper, 'My preserved direction');
    await wrapper.setProps({ [key]: changed }); await wrapper.setProps({ [key]: initial });
    pending.resolve({ text: 'Late stale response' }); await flushPromises();
    expect(wrapper.find(selector('preview')).exists()).toBe(false);
    expect((wrapper.get(selector('seed')).element as HTMLTextAreaElement).value).toBe('My preserved direction');
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    const staleApply = wrapper.get(selector('apply')).element as HTMLButtonElement;
    await wrapper.setProps({ [key]: changed }); staleApply.click(); await flushPromises();
    expect(wrapper.find(selector('preview')).exists()).toBe(false);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });
});

describe('field drafting', () => {
  it('links visible guidance to each source field without changing its name', async () => {
    const wrapper = editor({ field: 'scenario.genre', premise: 'A harbor under a glass sky.' });
    await wrapper.get(selector('open')).trigger('click');
    const guidance = () => {
      for (const control of wrapper.findAll('textarea, select')) {
        const ids = control.attributes('aria-describedby')?.split(/\s+/) ?? [];
        expect(ids.length, control.element.outerHTML).toBeGreaterThan(0);
        for (const id of ids) {
          const matches = wrapper.findAll('[id]').filter(node => node.attributes('id') === id);
          expect(matches, id).toHaveLength(1);
          expect(matches[0]!.isVisible()).toBe(true);
          expect(matches[0]!.text().length).toBeGreaterThan(15);
          expect(matches[0]!.element.closest('label')).toBeNull();
        }
      }
    };
    guidance();
    expect(wrapper.get(selector('seed')).attributes('aria-label')).toBe('Description for Genre');
    expect(wrapper.text()).toContain('Only this description is sent');
    expect(wrapper.text()).toMatch(/unsaved field/);
    await wrapper.get(selector('source')).setValue('premise');
    guidance();
    expect(wrapper.get(selector('premise')).attributes('readonly')).toBeDefined();
    expect(wrapper.get(selector('hint')).attributes('aria-label')).toBe('Optional description for Genre');
    expect(wrapper.text()).toContain('This scenario premise and optional description are sent');
    await wrapper.setProps({ premise: '' });
    guidance();
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeDefined();
  });

  it('keeps descriptions unique with two generators open in one form', async () => {
    const wrapper = mount(defineComponent({ components: { FieldGenerator }, template: '<form><FieldGenerator field="scenario.genre" model-value="" context-key="a" premise="A harbor" /><FieldGenerator field="scenario.genre" model-value="" context-key="b" premise="A harbor" /></form>' }));
    wrappers.push(wrapper);
    for (const button of wrapper.findAll(selector('open'))) await button.trigger('click');
    const ids = wrapper.findAll('textarea, select').map(control => control.attributes('aria-describedby'));
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('starts from the current field, sends only the selected field and seed, and waits for explicit Apply', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'Generated\n\nparagraphs' }) });
    vi.stubGlobal('fetch', fetch);
    const wrapper = editor();
    await wrapper.get(selector('open')).trigger('click');
    expect((wrapper.get(selector('seed')).element as HTMLTextAreaElement).value).toBe('Original words');
    await wrapper.get(selector('seed')).setValue('Only my description');
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('/api/authoring/generate-field', expect.objectContaining({ method: 'POST', body: JSON.stringify({ field, seed: 'Only my description' }) }));
    expect(wrapper.get(selector('preview')).text()).toBe('Generated\n\nparagraphs');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    await wrapper.get(selector('apply')).trigger('click');
    expect(wrapper.emitted('update:modelValue')).toEqual([['Generated\n\nparagraphs']]);
    expect(wrapper.find(selector('seed')).exists()).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('labels every control with its target and never submits a surrounding form', async () => {
    vi.spyOn(api, 'generateField').mockResolvedValue({ text: 'A new draft' });
    const wrapper = editor();
    expect(wrapper.get(selector('open')).attributes('aria-label')).toContain(label);
    await generate(wrapper); await flushPromises();
    expect(wrapper.get(selector('seed')).attributes('aria-label')).toContain(label);
    expect(wrapper.get(selector('preview')).attributes('aria-label')).toContain(label);
    for (const button of wrapper.findAll('button')) {
      expect(button.attributes('type')).toBe('button');
      expect(button.attributes('aria-label')).toContain(label);
    }
    expect(wrapper.find('form').exists()).toBe(false);
  });

  it('allows a description longer than the result field and enforces the separate 12000-character limit', async () => {
    const request = vi.spyOn(api, 'generateField').mockResolvedValue({ text: 'A short result' });
    const wrapper = editor(); await wrapper.get(selector('open')).trigger('click');
    expect(wrapper.get(selector('seed')).attributes('maxlength')).toBe('12000');
    for (const seed of ['   ', 'x'.repeat(12001)]) {
      await wrapper.get(selector('seed')).setValue(seed);
      expect(wrapper.get(selector('generate')).attributes('disabled')).toBeDefined();
      await wrapper.get(selector('generate')).trigger('click');
    }
    expect(request).not.toHaveBeenCalled();
    const longSeed = 'x'.repeat(12000);
    await wrapper.get(selector('seed')).setValue(longSeed); await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    expect(request).toHaveBeenCalledWith({ field, seed: longSeed });
  });

  it('preserves existing words and the description on failure, then supports an explicit retry', async () => {
    const request = vi.spyOn(api, 'generateField').mockRejectedValueOnce(new Error('Drafting is temporarily unavailable.')).mockResolvedValueOnce({ text: 'Retried result' });
    const wrapper = editor(); await generate(wrapper, 'Keep this description'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('Drafting is temporarily unavailable.');
    expect((wrapper.get(selector('seed')).element as HTMLTextAreaElement).value).toBe('Keep this description');
    expect(wrapper.props('modelValue')).toBe('Original words');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(wrapper.get(selector('generate')).text()).toBe('Retry');
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    expect(request).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get(selector('preview')).text()).toBe('Retried result');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it.each(['resolve', 'reject'] as const)('allows Cancel while pending and ignores a late %s', async settle => {
    const pending = deferred<{ text: string }>();
    vi.spyOn(api, 'generateField').mockReturnValue(pending.promise);
    const wrapper = editor(); await generate(wrapper);
    expect(wrapper.get(selector('cancel')).attributes('disabled')).toBeUndefined();
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeDefined();
    await wrapper.get(selector('cancel')).trigger('click');
    if (settle === 'resolve') pending.resolve({ text: 'Cancelled draft' }); else pending.reject(new Error('Cancelled error'));
    await flushPromises();
    expect(wrapper.find(selector('preview')).exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    await wrapper.get(selector('open')).trigger('click');
    expect((wrapper.get(selector('seed')).element as HTMLTextAreaElement).value).toBe('Original words');
  });

  it.each(['resolve', 'reject'] as const)('keeps the newer preview when a cancelled request later %ss', async settle => {
    const first = deferred<{ text: string }>(); const second = deferred<{ text: string }>();
    vi.spyOn(api, 'generateField').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const wrapper = editor(); await generate(wrapper, 'First idea'); await wrapper.get(selector('cancel')).trigger('click');
    await generate(wrapper, 'Second idea'); second.resolve({ text: 'Current result' }); await flushPromises();
    if (settle === 'resolve') first.resolve({ text: 'Old result' }); else first.reject(new Error('Old error'));
    await flushPromises();
    expect(wrapper.get(selector('preview')).text()).toBe('Current result');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    await wrapper.get(selector('apply')).trigger('click');
    expect(wrapper.emitted('update:modelValue')).toEqual([['Current result']]);
  });

  it.each([
    ['target words', { modelValue: 'Edited by the user' }],
    ['editing identity with identical words', { contextKey: 'card:2' }],
    ['disabled state', { disabled: true }],
    ['field kind', { field: Object.keys(FIELD_GENERATION_FIELDS)[1] as FieldGenerationField }],
  ])('discards pending and preview results when %s changes', async (_name, changed) => {
    const pending = deferred<{ text: string }>();
    const request = vi.spyOn(api, 'generateField').mockReturnValueOnce(pending.promise).mockResolvedValue({ text: 'Preview to discard' });
    const wrapper = editor(); await generate(wrapper); await wrapper.setProps(changed);
    pending.resolve({ text: 'Late stale result' }); await flushPromises();
    expect(wrapper.find(selector('preview')).exists()).toBe(false);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    await wrapper.setProps({ field, modelValue: 'Original words', contextKey: 'card:1', disabled: false });
    await generate(wrapper); await flushPromises(); expect(request).toHaveBeenCalledTimes(2);
    const staleApply = wrapper.get(selector('apply')).element as HTMLButtonElement;
    await wrapper.setProps(changed);
    staleApply.click(); await flushPromises();
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(wrapper.find(selector('preview')).exists()).toBe(false);
  });

  it('does not resurrect a draft when the target changes away and back', async () => {
    const pending = deferred<{ text: string }>(); vi.spyOn(api, 'generateField').mockReturnValue(pending.promise);
    const wrapper = editor(); await generate(wrapper);
    await wrapper.setProps({ contextKey: 'card:2' }); await wrapper.setProps({ contextKey: 'card:1' });
    pending.resolve({ text: 'Stale despite the same identity again' }); await flushPromises();
    expect(wrapper.find(selector('preview')).exists()).toBe(false);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('cannot begin drafting while disabled', async () => {
    const request = vi.spyOn(api, 'generateField'); const wrapper = editor({ disabled: true });
    expect(wrapper.get(selector('open')).attributes('disabled')).toBeDefined();
    await wrapper.get(selector('open')).trigger('click');
    expect(wrapper.find(selector('seed')).exists()).toBe(false); expect(request).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('ignores request %s and detached Apply after unmount', async settle => {
    const pending = deferred<{ text: string }>();
    const request = vi.spyOn(api, 'generateField').mockResolvedValueOnce({ text: 'Detached draft' }).mockReturnValueOnce(pending.promise);
    const wrapper = editor(); await generate(wrapper); await flushPromises();
    const apply = wrapper.get(selector('apply')).element as HTMLButtonElement;
    wrapper.unmount(); apply.click(); await flushPromises();
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    const second = editor(); await generate(second); second.unmount();
    if (settle === 'resolve') pending.resolve({ text: 'Late unmounted draft' }); else pending.reject(new Error('Late unmounted error'));
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(2); expect(second.emitted('update:modelValue')).toBeUndefined();
  });
});


describe('explicit premise drafting', () => {
  const premise = 'A harbor town owes its survival to a missing lighthouse keeper.';
  async function choosePremise(wrapper: ReturnType<typeof mount>) {
    await wrapper.get(selector('open')).trigger('click');
    await wrapper.get(selector('source')).setValue('premise');
  }

  it('defaults to My description even when a premise is available, preserving the legacy payload', async () => {
    const request = vi.spyOn(api, 'generateField').mockResolvedValue({ text: 'Draft' });
    const wrapper = editor({ premise, premiseLabel: 'Harbor scenario' });
    await wrapper.get(selector('open')).trigger('click');
    expect((wrapper.get(selector('source')).element as HTMLSelectElement).value).toBe('description');
    expect(wrapper.get(selector('source')).text()).toContain('My description');
    expect(wrapper.get(selector('source')).text()).toContain('Scenario premise');
    expect((wrapper.get(selector('seed')).element as HTMLTextAreaElement).value).toBe('Original words');
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    expect(request).toHaveBeenCalledWith({ field, seed: 'Original words' });
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('shows the complete named premise read-only and sends it with an optional empty hint through fetch', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'Premise draft' }) });
    vi.stubGlobal('fetch', fetch);
    const wrapper = editor({ premise, premiseLabel: 'Harbor scenario' });
    await choosePremise(wrapper);
    const display = wrapper.get(selector('premise'));
    expect((display.element as HTMLTextAreaElement).value).toBe(premise);
    expect(display.attributes('readonly')).toBeDefined();
    expect(display.attributes('aria-label')).toContain('Harbor scenario');
    expect((wrapper.get(selector('hint')).element as HTMLTextAreaElement).value).toBe('');
    expect(wrapper.find(selector('seed')).exists()).toBe(false);
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    expect(fetch).toHaveBeenCalledWith('/api/authoring/generate-field', expect.objectContaining({ body: JSON.stringify({ field, seed: '', premise }) }));
    expect(wrapper.get(selector('preview')).text()).toBe('Premise draft');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    await wrapper.get(selector('apply')).trigger('click');
    expect(wrapper.emitted('update:modelValue')).toEqual([['Premise draft']]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('allowlists the request keys while retaining optional premise', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'Draft' }) });
    vi.stubGlobal('fetch', fetch);
    const input = { field, seed: '', premise, privateNotes: 'Must stay local' };
    await api.generateField(input);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ field, seed: '', premise });
  });

  it('preserves independent descriptions across source changes and clears the old preview', async () => {
    const request = vi.spyOn(api, 'generateField').mockResolvedValue({ text: 'Draft' });
    const wrapper = editor({ premise }); await wrapper.get(selector('open')).trigger('click');
    await wrapper.get(selector('seed')).setValue('My original idea');
    await wrapper.get(selector('source')).setValue('premise');
    await wrapper.get(selector('hint')).setValue('Make it eerie');
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    expect(request).toHaveBeenLastCalledWith({ field, seed: 'Make it eerie', premise });
    await wrapper.get(selector('source')).setValue('description');
    expect(wrapper.find(selector('preview')).exists()).toBe(false);
    expect((wrapper.get(selector('seed')).element as HTMLTextAreaElement).value).toBe('My original idea');
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    expect(request).toHaveBeenLastCalledWith({ field, seed: 'My original idea' });
    await wrapper.get(selector('source')).setValue('premise');
    expect((wrapper.get(selector('hint')).element as HTMLTextAreaElement).value).toBe('Make it eerie');
  });

  it.each([['empty', ''], ['blank', '   '], ['too long', 'x'.repeat(4001)]])('disables %s premise choice', async (_reason, unavailable) => {
    const wrapper = editor({ premise: unavailable }); await wrapper.get(selector('open')).trigger('click');
    expect(wrapper.get(`${selector('source')} option[value="premise"]`).attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toMatch(/premise.*(available|4000|4,000|characters|blank)/i);
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeUndefined();
  });

  it.each(['scenario.premise', 'scenario.boundaries', 'npc.limit', 'npc.limits', 'character.pronouns', 'live.publicReveal'] as const)('does not offer premise derivation for %s', async field => {
    const wrapper = editor({ field, premise }); await wrapper.get(selector('open')).trigger('click');
    expect(wrapper.find(selector('source')).exists()).toBe(false);
  });

  it('omits source choice when no premise context was provided', async () => {
    const wrapper = editor(); await wrapper.get(selector('open')).trigger('click');
    expect(wrapper.find(selector('source')).exists()).toBe(false);
  });

  it('accepts trimmed premise and hint limits and rejects an oversized hint', async () => {
    const request = vi.spyOn(api, 'generateField').mockResolvedValue({ text: 'Draft' });
    const fullPremise = ' ' + 'p'.repeat(4000) + ' ';
    const wrapper = editor({ premise: fullPremise }); await choosePremise(wrapper);
    expect(wrapper.get(selector('hint')).attributes('maxlength')).toBe('12000');
    await wrapper.get(selector('hint')).setValue('x'.repeat(12001));
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeDefined();
    await wrapper.get(selector('hint')).setValue(' ' + 'x'.repeat(12000) + ' ');
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeUndefined();
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    expect(request).toHaveBeenCalledWith({ field, seed: ' ' + 'x'.repeat(12000) + ' ', premise: fullPremise });
  });

  it.each(['description', 'premise'] as const)('invalidates a preview when the %s input changes', async source => {
    vi.spyOn(api, 'generateField').mockResolvedValue({ text: 'Obsolete draft' });
    const wrapper = editor({ premise }); await wrapper.get(selector('open')).trigger('click');
    if (source === 'premise') await wrapper.get(selector('source')).setValue(source);
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    const staleApply = wrapper.get(selector('apply')).element as HTMLButtonElement;
    await wrapper.get(selector(source === 'premise' ? 'hint' : 'seed')).setValue('Changed direction');
    staleApply.click(); await flushPromises();
    expect(wrapper.find(selector('preview')).exists()).toBe(false);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it.each(['resolve', 'reject'] as const)('ignores an old %s after switching sources and keeps the newer request pending', async settle => {
    const first = deferred<{ text: string }>(); const second = deferred<{ text: string }>();
    vi.spyOn(api, 'generateField').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const wrapper = editor({ premise }); await generate(wrapper, 'My words');
    await wrapper.get(selector('source')).setValue('premise');
    await wrapper.get(selector('generate')).trigger('click');
    if (settle === 'resolve') first.resolve({ text: 'Old draft' }); else first.reject(new Error('Old failure'));
    await flushPromises();
    expect(wrapper.find(selector('preview')).exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeDefined();
    second.resolve({ text: 'Current draft' }); await flushPromises();
    expect(wrapper.get(selector('preview')).text()).toBe('Current draft');
  });

  it.each(['premise', 'premiseLabel'] as const)('invalidates pending and preview on %s changes including away and back', async key => {
    const pending = deferred<{ text: string }>();
    vi.spyOn(api, 'generateField').mockReturnValueOnce(pending.promise).mockResolvedValue({ text: 'Draft to discard' });
    const initial = key === 'premise' ? premise : 'Harbor scenario';
    const wrapper = editor({ premise, premiseLabel: 'Harbor scenario' }); await choosePremise(wrapper);
    await wrapper.get(selector('hint')).setValue('Keep these words');
    await wrapper.get(selector('generate')).trigger('click');
    await wrapper.setProps({ [key]: 'Changed context' }); await wrapper.setProps({ [key]: initial });
    pending.resolve({ text: 'Obsolete draft' }); await flushPromises();
    expect(wrapper.find(selector('preview')).exists()).toBe(false);
    expect((wrapper.get(selector('hint')).element as HTMLTextAreaElement).value).toBe('Keep these words');
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    expect(wrapper.find(selector('preview')).exists()).toBe(true);
    await wrapper.setProps({ [key]: 'Changed again' });
    expect(wrapper.find(selector('preview')).exists()).toBe(false);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('blocks a premise request if its source disappears while open', async () => {
    const request = vi.spyOn(api, 'generateField');
    const wrapper = editor({ premise }); await choosePremise(wrapper);
    await wrapper.setProps({ premise: '' });
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeDefined();
    await wrapper.get(selector('generate')).trigger('click');
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['pending resolution', 'pending rejection', 'preview'] as const)('allows returning to preserved description when premise disappears during %s', async state => {
    const oldRequest = deferred<{ text: string }>();
    const request = vi.spyOn(api, 'generateField').mockReturnValueOnce(oldRequest.promise).mockResolvedValue({ text: 'Description draft' });
    const wrapper = editor({ premise }); await wrapper.get(selector('open')).trigger('click');
    await wrapper.get(selector('seed')).setValue('Keep my own description');
    await wrapper.get(selector('source')).setValue('premise');
    await wrapper.get(selector('generate')).trigger('click');
    let staleApply: HTMLButtonElement | undefined;
    if (state === 'preview') {
      oldRequest.resolve({ text: 'Obsolete premise draft' }); await flushPromises();
      staleApply = wrapper.get(selector('apply')).element as HTMLButtonElement;
    }
    await wrapper.setProps({ premise: undefined });
    expect(wrapper.find(selector('preview')).exists()).toBe(false);
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeDefined();
    expect(wrapper.get(`${selector('source')} option[value="premise"]`).attributes('disabled')).toBeDefined();
    await wrapper.get(selector('source')).setValue('description');
    expect((wrapper.get(selector('seed')).element as HTMLTextAreaElement).value).toBe('Keep my own description');
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeUndefined();
    staleApply?.click(); await flushPromises();
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    expect(request).toHaveBeenLastCalledWith({ field, seed: 'Keep my own description' });
    if (state === 'pending resolution') oldRequest.resolve({ text: 'Obsolete premise draft' });
    if (state === 'pending rejection') oldRequest.reject(new Error('Obsolete premise error'));
    await flushPromises();
    expect(wrapper.get(selector('preview')).text()).toBe('Description draft');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

});


describe('current character context', () => {
  const characterContext = { kind: 'character', displayName: 'Aster', pronouns: 'they/them', appearance: 'Silver coat', personality: 'Patient', backstory: 'Former courier', specialty: 'Navigation', flaw: 'Distrustful', connection: 'Owes the crew', secret: 'The map is forged', possessions: ['Map', 'Compass'] };
  const npcContext = { kind: 'npc', displayName: 'Mara', role: 'Keeper', secrets: ['A hidden key'], knowledge: [{ statement: 'The tide is rising', category: 'belief' }], aliases: ['The Keeper'] };

  it.each(['description', 'premise'] as const)('sends exactly the current authored context with %s and discloses its private fields', async source => {
    const request = vi.spyOn(api, 'generateField').mockResolvedValue({ text: 'Context draft' });
    const wrapper = editor({ field: 'character.appearance', characterContext, premise: 'A flooded port' });
    await wrapper.get(selector('open')).trigger('click');
    if (source === 'premise') {
      await wrapper.get(selector('source')).setValue('premise');
      await wrapper.get(selector('hint')).setValue('A weathered look');
    } else await wrapper.get(selector('seed')).setValue('A weathered look');
    expect(wrapper.text()).toMatch(/entered fields for Aster, including private notes/i);
    expect(wrapper.text()).not.toContain('Only this description is sent');
    const control = wrapper.get(selector(source === 'premise' ? 'hint' : 'seed'));
    const help = control.attributes('aria-describedby')!.split(/\s+/).map(id => wrapper.get(`[id="${id}"]`).text()).join(' ');
    expect(help).toMatch(/Aster.*private notes/i);
    expect(help).toContain(source === 'premise' ? 'sent. Uses entered fields' : 'field. Uses entered fields');
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    expect(request).toHaveBeenCalledWith({ field: 'character.appearance', seed: 'A weathered look', ...(source === 'premise' ? { premise: 'A flooded port' } : {}), characterContext });
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it.each([
    ['character.backstory', characterContext], ['npc.goal', npcContext],
  ])('allows an empty description for %s with useful matching context', async (field, context) => {
    const request = vi.spyOn(api, 'generateField').mockResolvedValue({ text: 'Context draft' });
    const wrapper = editor({ field, modelValue: '', characterContext: context });
    await wrapper.get(selector('open')).trigger('click');
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeUndefined();
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    expect(request).toHaveBeenCalledWith({ field, seed: '', characterContext: context });
  });

  it.each([
    ['character.pronouns', characterContext], ['npc.limit', npcContext], ['npc.limits', npcContext],
  ])('still requires explicit words for %s', async (field, context) => {
    const request = vi.spyOn(api, 'generateField').mockResolvedValue({ text: 'Explicit draft' });
    const wrapper = editor({ field, modelValue: '', characterContext: context, premise: 'A flooded port' });
    await wrapper.get(selector('open')).trigger('click');
    expect(wrapper.find(selector('source')).exists()).toBe(false);
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeDefined();
    await wrapper.get(selector('seed')).setValue('Explicit wording');
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    expect(request).toHaveBeenCalledWith({ field, seed: 'Explicit wording', characterContext: context });
  });

  it.each([
    ['wrong family', 'character.appearance', npcContext],
    ['unrelated field', 'scenario.genre', characterContext],
    ['unknown data', 'character.appearance', { ...characterContext, sessionId: 'other-session' }],
    ['oversized field', 'character.appearance', { ...characterContext, secret: 'x'.repeat(2001) }],
    ['oversized context', 'npc.goal', { kind: 'npc', knowledge: Array.from({ length: 30 }, () => ({ statement: 'x'.repeat(6000), category: 'fact' })) }],
  ])('clearly blocks %s without omitting context', async (_reason, field, context) => {
    const request = vi.spyOn(api, 'generateField');
    const wrapper = editor({ field, characterContext: context });
    await wrapper.get(selector('open')).trigger('click');
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeDefined();
    expect(wrapper.get('[role="alert"]').text()).toMatch(/character context/i);
    await wrapper.get(selector('generate')).trigger('click');
    expect(request).not.toHaveBeenCalled();
  });

  it('blocks a raw request over the byte budget even when trimmed inputs fit', async () => {
    const request = vi.spyOn(api, 'generateField');
    const wrapper = editor({ field: 'character.appearance', characterContext });
    await wrapper.get(selector('open')).trigger('click');
    await wrapper.get(selector('seed')).setValue(' '.repeat(256 * 1024) + 'Brief');
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeDefined();
    expect(wrapper.get('[role="alert"]').text()).toMatch(/request.*too large/i);
    await wrapper.get(selector('generate')).trigger('click');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([{ kind: 'character' }, { kind: 'character', displayName: '  ', possessions: [' '] }])('does not treat empty authored values as useful context', async context => {
    const wrapper = editor({ field: 'character.appearance', modelValue: '', characterContext: context });
    await wrapper.get(selector('open')).trigger('click');
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeDefined();
  });

  it.each(['resolve', 'reject'] as const)('invalidates a pending %s on nested edits away and back and takes an immutable request snapshot', async settle => {
    const first = deferred<{ text: string }>(); const second = deferred<{ text: string }>();
    const request = vi.spyOn(api, 'generateField').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const context = reactive({ ...npcContext, knowledge: [{ statement: 'Original knowledge', category: 'belief' }] });
    const wrapper = editor({ field: 'npc.goal', characterContext: context });
    await generate(wrapper, 'Keep this description');
    const captured = request.mock.calls[0]![0] as { characterContext?: unknown };
    context.knowledge[0]!.statement = 'Changed knowledge';
    expect(captured.characterContext).toEqual({ ...npcContext, knowledge: [{ statement: 'Original knowledge', category: 'belief' }] });
    context.knowledge[0]!.statement = 'Original knowledge';
    await flushPromises();
    expect((wrapper.get(selector('seed')).element as HTMLTextAreaElement).value).toBe('Keep this description');
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeUndefined();
    await wrapper.get(selector('generate')).trigger('click');
    if (settle === 'resolve') first.resolve({ text: 'Stale draft' }); else first.reject(new Error('Stale error'));
    await flushPromises();
    expect(wrapper.find(selector('preview')).exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeDefined();
    second.resolve({ text: 'Current draft' }); await flushPromises();
    expect(wrapper.get(selector('preview')).text()).toBe('Current draft');
  });

  it('invalidates a preview synchronously on an array edit away and back without closing the panel', async () => {
    vi.spyOn(api, 'generateField').mockResolvedValue({ text: 'Stale draft' });
    const context = reactive({ ...characterContext, possessions: ['Map'] });
    const wrapper = editor({ field: 'character.appearance', characterContext: context });
    await generate(wrapper, 'Keep this description'); await flushPromises();
    const staleApply = wrapper.get(selector('apply')).element as HTMLButtonElement;
    context.possessions.push('Compass'); context.possessions.pop();
    staleApply.click(); await flushPromises();
    expect(wrapper.find(selector('preview')).exists()).toBe(false);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect((wrapper.get(selector('seed')).element as HTMLTextAreaElement).value).toBe('Keep this description');
  });
});
