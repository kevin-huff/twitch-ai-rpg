// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { PICTURE_MODELS } from '@rpg/contracts';
import type { PictureSettings as Settings } from '@rpg/contracts';
import PictureSettings from './PictureSettings.vue';

const FieldGeneratorStub = { props: ['field', 'modelValue', 'contextKey', 'disabled', 'premise', 'premiseLabel'], template: '<button type="button" class="generator-stub" :disabled="disabled">AI Generate</button>' };
const FLUX_LINE = 'Pictures of a beat use FLUX 3 Klein when anyone in them has a portrait, because it is the only model that can draw your cast from their portraits.';
const QUICK_PICKS = [
  ['Painterly', 'Painterly digital illustration, rich color, cinematic lighting'],
  ['Comic book ink', 'Bold black-ink comic book art, flat bright colors, heavy outlines, halftone shading'],
  ['Watercolor storybook', 'Soft watercolor storybook illustration, loose washes, warm paper texture'],
  ['Anime', 'Clean anime illustration, crisp line art, vivid cel shading'],
  ['Dark fantasy oil painting', 'Dark fantasy oil painting, heavy brushstrokes, deep shadows, warm candlelight'],
  ['Cinematic photo', 'Cinematic film still, photorealistic, shallow depth of field, moody lighting'],
  ['Pixel art', 'Detailed 16-bit pixel art, limited palette, crisp pixels'],
  ['Film noir', 'Black-and-white film noir illustration, high contrast, hard shadows'],
] as const;

const base: Settings = { style: 'Old style', model: PICTURE_MODELS[0]!.id };
const mountIt = (settings: Settings | null = base, extra: Record<string, unknown> = {}) => mount(PictureSettings, {
  props: { settings, premise: 'A heist at sea', premiseLabel: 'the show premise', disabled: false, ...extra },
  global: { stubs: { FieldGenerator: FieldGeneratorStub } },
});
type Wrapper = ReturnType<typeof mountIt>;
const style = (w: Wrapper) => w.get('[data-testid="picture-style"]');
const model = (w: Wrapper) => w.get('[data-testid="picture-model"]');
const save = (w: Wrapper) => w.get('[data-testid="picture-settings-save"]');

describe('PictureSettings', () => {
  it('renders nothing when there are no settings', () => {
    const w = mountIt(null);
    expect(w.find('[data-testid="picture-settings"]').exists()).toBe(false);
  });

  it('is a closed fold-out titled Picture settings', () => {
    const w = mountIt();
    const details = w.get('details[data-testid="picture-settings"]');
    expect(details.attributes('open')).toBeUndefined();
    expect(details.get('summary').text()).toBe('Picture settings');
  });

  it('shows the saved style in a labelled box limited to 300 characters', () => {
    const w = mountIt();
    expect((style(w).element as HTMLInputElement).value).toBe('Old style');
    expect(style(w).attributes('maxlength')).toBe('300');
    expect(w.text()).toContain('Art style');
    expect(w.get('label').text()).toContain('Art style');
  });

  it('offers every quick pick and each one fills the box with its text', async () => {
    const w = mountIt();
    const picks = w.findAll('[data-testid^="picture-style-pick-"]');
    expect(picks.map(pick => pick.text())).toEqual(QUICK_PICKS.map(([label]) => label));
    for (const [index, [, text]] of QUICK_PICKS.entries()) {
      await w.get(`[data-testid="picture-style-pick-${index}"]`).trigger('click');
      expect((style(w).element as HTMLInputElement).value).toBe(text);
    }
  });

  it('keeps a quick pick editable', async () => {
    const w = mountIt();
    await w.get('[data-testid="picture-style-pick-3"]').trigger('click');
    await style(w).setValue('Clean anime illustration, pastel');
    await save(w).trigger('click');
    expect(w.emitted('save')).toEqual([[{ style: 'Clean anime illustration, pastel', model: base.model }]]);
  });

  it('hands the style generator its field, premise and the style box', async () => {
    const w = mountIt();
    const generator = w.getComponent(FieldGeneratorStub);
    expect(generator.props('field')).toBe('scenario.pictureStyle');
    expect(generator.props('premise')).toBe('A heist at sea');
    expect(generator.props('premiseLabel')).toBe('the show premise');
    expect(generator.props('modelValue')).toBe('Old style');
    await style(w).setValue('Typed look');
    expect(generator.props('modelValue')).toBe('Typed look');
    generator.vm.$emit('update:modelValue', 'Generated look');
    await w.vm.$nextTick();
    expect((style(w).element as HTMLInputElement).value).toBe('Generated look');
  });

  it('lists the models by label and shows the selected model description', async () => {
    const w = mountIt();
    const options = model(w).findAll('option');
    expect(options.map(option => option.text())).toEqual(PICTURE_MODELS.map(entry => entry.label));
    expect(options.map(option => (option.element as HTMLOptionElement).value)).toEqual(PICTURE_MODELS.map(entry => entry.id));
    const description = () => w.get('[data-testid="picture-model-description"]').text();
    expect(description()).toBe(PICTURE_MODELS[0]!.description);
    await model(w).setValue(PICTURE_MODELS[1]!.id);
    expect(description()).toBe(PICTURE_MODELS[1]!.description);
    expect(w.text()).toContain('Picture model');
  });

  it('says that beat pictures with portraits use FLUX 3 Klein', () => {
    expect(mountIt().text()).toContain(FLUX_LINE);
  });

  it('keeps a model that is not on the list selectable as the server default', async () => {
    const w = mountIt({ style: '', model: 'fake-image' });
    const options = model(w).findAll('option');
    expect(options[0]!.text()).toBe('fake-image (server default)');
    expect((options[0]!.element as HTMLOptionElement).value).toBe('fake-image');
    expect(options).toHaveLength(PICTURE_MODELS.length + 1);
    expect((model(w).element as HTMLSelectElement).value).toBe('fake-image');
    await style(w).setValue('Ink');
    await save(w).trigger('click');
    expect(w.emitted('save')).toEqual([[{ style: 'Ink', model: 'fake-image' }]]);
  });

  it('does not add a server-default option for a listed model', () => {
    const w = mountIt();
    expect(model(w).findAll('option')).toHaveLength(PICTURE_MODELS.length);
    expect(model(w).text()).not.toContain('server default');
  });

  it('emits the trimmed style and the chosen model on save', async () => {
    const w = mountIt();
    await style(w).setValue('  Moody ink  ');
    await model(w).setValue(PICTURE_MODELS[1]!.id);
    await save(w).trigger('click');
    expect(w.emitted('save')).toEqual([[{ style: 'Moody ink', model: PICTURE_MODELS[1]!.id }]]);
  });

  it('can save a cleared style', async () => {
    const w = mountIt();
    await style(w).setValue('');
    await save(w).trigger('click');
    expect(w.emitted('save')).toEqual([[{ style: '', model: base.model }]]);
  });

  it('keeps save off until something changed and while disabled', async () => {
    const w = mountIt();
    expect(save(w).attributes('disabled')).toBeDefined();
    await style(w).setValue('Different');
    expect(save(w).attributes('disabled')).toBeUndefined();
    await style(w).setValue('Old style');
    expect(save(w).attributes('disabled')).toBeDefined();
    await style(w).setValue('  Old style  ');
    expect(save(w).attributes('disabled')).toBeDefined();
    await model(w).setValue(PICTURE_MODELS[1]!.id);
    expect(save(w).attributes('disabled')).toBeUndefined();
    await w.setProps({ disabled: true });
    expect(save(w).attributes('disabled')).toBeDefined();
    await save(w).trigger('click');
    expect(w.emitted('save')).toBeUndefined();
  });

  it('blocks the quick picks and the generator while disabled', async () => {
    const w = mountIt(base, { disabled: true });
    expect(w.get('[data-testid="picture-style-pick-0"]').attributes('disabled')).toBeDefined();
    expect(w.getComponent(FieldGeneratorStub).props('disabled')).toBe(true);
    expect(style(w).attributes('disabled')).toBeDefined();
    expect(model(w).attributes('disabled')).toBeDefined();
  });

  it('takes new saved values when nothing is unsaved', async () => {
    const w = mountIt();
    await w.setProps({ settings: { style: 'Saved elsewhere', model: PICTURE_MODELS[1]!.id } });
    expect((style(w).element as HTMLInputElement).value).toBe('Saved elsewhere');
    expect((model(w).element as HTMLSelectElement).value).toBe(PICTURE_MODELS[1]!.id);
    expect(save(w).attributes('disabled')).toBeDefined();
  });

  it('keeps unsaved edits when new values arrive, and compares against the newest values', async () => {
    const w = mountIt();
    await style(w).setValue('My unsaved look');
    await w.setProps({ settings: { style: 'Saved elsewhere', model: base.model } });
    expect((style(w).element as HTMLInputElement).value).toBe('My unsaved look');
    expect(save(w).attributes('disabled')).toBeUndefined();
    await style(w).setValue('Saved elsewhere');
    expect(save(w).attributes('disabled')).toBeDefined();
  });

  it('keeps an unsaved model choice and the style beside it when new values arrive', async () => {
    const w = mountIt();
    await model(w).setValue(PICTURE_MODELS[1]!.id);
    await w.setProps({ settings: { style: 'Newer', model: base.model } });
    expect((model(w).element as HTMLSelectElement).value).toBe(PICTURE_MODELS[1]!.id);
    expect((style(w).element as HTMLInputElement).value).toBe('Old style');
    expect(save(w).attributes('disabled')).toBeUndefined();
  });

  it("shows the server's tidied style after a save and keeps following other tabs", async () => {
    const w = mountIt();
    await style(w).setValue('Moody  ink.');
    await save(w).trigger('click');
    await w.setProps({ disabled: true });
    await w.setProps({ settings: { style: 'Moody ink', model: base.model } });
    await w.setProps({ disabled: false });
    expect((style(w).element as HTMLInputElement).value).toBe('Moody ink');
    expect(save(w).attributes('disabled')).toBeDefined();
    await w.setProps({ settings: { style: 'Saved in another tab', model: base.model } });
    expect((style(w).element as HTMLInputElement).value).toBe('Saved in another tab');
  });

  it("fills a box saved blank with the scenario's style the server sends back", async () => {
    const w = mountIt();
    await style(w).setValue('');
    await save(w).trigger('click');
    await w.setProps({ settings: { style: 'The scenario style', model: base.model } });
    expect((style(w).element as HTMLInputElement).value).toBe('The scenario style');
    expect(save(w).attributes('disabled')).toBeDefined();
  });

  it('treats a closing period or doubled spaces as no change', async () => {
    const w = mountIt();
    for (const text of ['Old style.', 'Old  style', ' Old style . ']) {
      await style(w).setValue(text);
      expect(save(w).attributes('disabled'), text).toBeDefined();
    }
  });

  it('keeps the typed style when a save fails, and new values from elsewhere leave it alone', async () => {
    const w = mountIt();
    await style(w).setValue('My look');
    await save(w).trigger('click');
    await w.setProps({ disabled: true });
    await w.setProps({ disabled: false });
    expect((style(w).element as HTMLInputElement).value).toBe('My look');
    expect(save(w).attributes('disabled')).toBeUndefined();
    await w.setProps({ settings: { style: 'Saved in another tab', model: base.model } });
    expect((style(w).element as HTMLInputElement).value).toBe('My look');
  });

  it('shows the fold-out once settings arrive after starting empty', async () => {
    const w = mountIt(null);
    await w.setProps({ settings: base });
    expect((style(w).element as HTMLInputElement).value).toBe('Old style');
  });
});
