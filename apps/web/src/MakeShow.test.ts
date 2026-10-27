// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterCardDefinition, ScenarioDefinition, ScenarioDraftJob, TemplateVersion } from '@rpg/contracts';

const api = vi.hoisted(() => ({
  library: vi.fn(), startScenarioDraft: vi.fn(), scenarioDraft: vi.fn(), saveScenario: vi.fn(),
  generateCard: vi.fn(), saveCharacterTemplate: vi.fn(), createCustom: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ api }));
vi.mock('./navigate', () => ({ navigate }));

import MakeShow from './MakeShow.vue';

const definition = {
  schemaVersion: 1, title: 'The Lost Lighthouse', premise: 'A storm traps the keepers.', genre: '', tone: '', boundaries: ['Keep injuries off screen.'],
  locations: [{ id: 'l1', title: 'Lantern room' }],
  openingScene: { id: 's1', title: 'Storm', description: '', locationId: 'l1' },
  npcs: [{ id: 'n1', displayName: 'Mara' }],
  tracks: [{ id: 't1', label: 'Tide' }],
  facts: [{ id: 'f1', text: 'a', visibility: 'public' }],
} as unknown as ScenarioDefinition;
const savedScenario: TemplateVersion<ScenarioDefinition> = { id: 'scn-new', version: 1, definition };
const older = { id: 'scn-old', version: 2, definition: { ...definition, title: 'The Old Vault' } } as TemplateVersion<ScenarioDefinition>;
const succeeded: ScenarioDraftJob = {
  status: 'succeeded', jobId: 'job-1', definition, adjustments: ['Dropped a place.'], warnings: ['Check Mara.'], suggestedBoundaries: ['Keep injuries off screen.'],
};
const t = (name: string) => `[data-testid="${name}"]`;
const wrappers: ReturnType<typeof mount>[] = [];

function setup() {
  const wrapper = mount(MakeShow);
  wrappers.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  window.sessionStorage.clear();
  for (const fn of Object.values(api)) fn.mockReset();
  navigate.mockReset();
  api.library.mockResolvedValue({ scenarios: [older], characters: [] as TemplateVersion<CharacterCardDefinition>[] });
  api.startScenarioDraft.mockResolvedValue(succeeded);
  api.saveScenario.mockResolvedValue(savedScenario);
  api.createCustom.mockResolvedValue({ sessionId: 'show-1' });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });

describe('make a show', () => {
  it('opens ready to write a story, with Small as the default and the other sizes tucked away', async () => {
    const wrapper = setup();
    await flushPromises();
    expect(wrapper.get('h1').text()).toBe('Make a show');
    expect(wrapper.find(t('scenario-generator-open')).exists()).toBe(false);
    expect(wrapper.text()).toContain("What's the story?");
    expect(wrapper.get(t('scenario-generator-generate')).text()).toBe('Write my story');
    const options = wrapper.get('details.scenario-generator-options');
    expect(options.attributes('open')).toBeUndefined();
    expect(options.get('summary').text()).toBe('More options');
    expect((wrapper.get(t('scenario-generator-size')).element as HTMLSelectElement).value).toBe('small');
    expect(wrapper.text()).not.toContain('Nothing is saved until');
    expect(wrapper.find(t('show-title')).exists()).toBe(false);
  });

  it('writes a story, previews it, saves it with its boundaries and shows the form', async () => {
    const wrapper = setup();
    await flushPromises();
    await wrapper.get(t('scenario-generator-prompt')).setValue('A haunted lighthouse');
    await wrapper.get(t('scenario-generator-generate')).trigger('click');
    await flushPromises();
    expect(api.startScenarioDraft).toHaveBeenCalledWith({ prompt: 'A haunted lighthouse', size: 'small', boundaries: [] });
    const preview = wrapper.get(t('scenario-generator-preview')).text();
    expect(preview).toContain('The Lost Lighthouse');
    expect(preview).toContain('A storm traps the keepers.');
    expect(preview).toContain('Lantern room');
    expect(preview).toContain('Mara');
    expect(preview).toContain('Keep injuries off screen.');
    expect(preview).not.toContain('Tracks');
    expect(preview).not.toContain('Facts');
    expect(preview).not.toContain('What the app changed');
    expect(preview).not.toContain('Check before you save');
    expect(wrapper.get(t('scenario-generator-apply')).text()).toBe('Use this story');
    expect(api.saveScenario).not.toHaveBeenCalled();

    await wrapper.get(t('scenario-generator-apply')).trigger('click');
    await flushPromises();
    expect(api.saveScenario).toHaveBeenCalledTimes(1);
    expect(api.saveScenario).toHaveBeenCalledWith({ expectedVersion: 0, definition });
    expect(api.saveScenario.mock.calls[0]![0].definition.boundaries).toEqual(['Keep injuries off screen.']);
    expect((wrapper.get(t('show-title')).element as HTMLInputElement).value).toBe('The Lost Lighthouse');
    expect((wrapper.get(t('make-saved-story')).element as HTMLSelectElement).value).toBe('scn-new:1');
  });

  it('resumes a remembered draft on mount and keeps the box when waiting is cancelled', async () => {
    window.sessionStorage.setItem('rpg-scenario-draft-job', 'job-1');
    api.scenarioDraft.mockResolvedValue(succeeded);
    const wrapper = setup();
    await flushPromises();
    expect(api.scenarioDraft).toHaveBeenCalledWith('job-1');
    expect(wrapper.find(t('scenario-generator-preview')).exists()).toBe(true);
    await wrapper.get(t('scenario-generator-prompt')).setValue('Kept text');
    await wrapper.get(t('scenario-generator-cancel')).trigger('click');
    expect(wrapper.find(t('scenario-generator-preview')).exists()).toBe(false);
    expect((wrapper.get(t('scenario-generator-prompt')).element as HTMLTextAreaElement).value).toBe('Kept text');
  });

  it('shows the form when a saved story is chosen', async () => {
    const wrapper = setup();
    await flushPromises();
    const select = wrapper.get(t('make-saved-story'));
    const labels = select.findAll('option').map(option => option.text());
    expect(labels).toEqual(['Choose a saved story', 'The Old Vault']);
    await select.setValue('scn-old:2');
    expect((wrapper.get(t('show-title')).element as HTMLInputElement).value).toBe('The Old Vault');
    expect(api.saveScenario).not.toHaveBeenCalled();
    await select.setValue('');
    expect(wrapper.find(t('show-title')).exists()).toBe(false);
  });

  it('goes to the new show\'s Cast & lobby once the show is created', async () => {
    const wrapper = setup();
    await flushPromises();
    await wrapper.get(t('make-saved-story')).setValue('scn-old:2');
    await wrapper.get(t('create-show')).trigger('click');
    await flushPromises();
    expect(api.createCustom).toHaveBeenCalledTimes(1);
    expect(api.createCustom.mock.calls[0]![1]).toEqual({ templateId: 'scn-old', version: 2 });
    expect(navigate).toHaveBeenCalledWith('/sessions/show-1/lobby');
  });

  it('keeps the story and shows the error beside the button when it cannot be saved', async () => {
    api.saveScenario.mockRejectedValue(new Error('Could not save.'));
    const wrapper = setup();
    await flushPromises();
    await wrapper.get(t('scenario-generator-prompt')).setValue('A haunted lighthouse');
    await wrapper.get(t('scenario-generator-generate')).trigger('click');
    await flushPromises();
    await wrapper.get(t('scenario-generator-apply')).trigger('click');
    await flushPromises();
    expect(wrapper.get(t('scenario-generator-apply-error')).text()).toBe('Could not save.');
    expect(wrapper.get(t('scenario-generator-apply-error')).attributes('role')).toBe('alert');
    expect(wrapper.find('.error-notice').exists()).toBe(false);
    expect(wrapper.find(t('scenario-generator-preview')).exists()).toBe(true);
    expect(wrapper.find(t('show-title')).exists()).toBe(false);
  });

  async function failedSave() {
    api.saveScenario.mockRejectedValue(new Error('Could not save.'));
    const wrapper = setup();
    await flushPromises();
    await wrapper.get(t('scenario-generator-prompt')).setValue('A haunted lighthouse');
    await wrapper.get(t('scenario-generator-generate')).trigger('click');
    await flushPromises();
    await wrapper.get(t('scenario-generator-apply')).trigger('click');
    await flushPromises();
    expect(wrapper.find(t('scenario-generator-apply-error')).exists()).toBe(true);
    return wrapper;
  }

  it('clears the save error when the story is cancelled', async () => {
    const wrapper = await failedSave();
    await wrapper.get(t('scenario-generator-cancel')).trigger('click');
    await flushPromises();
    expect(wrapper.find(t('scenario-generator-apply-error')).exists()).toBe(false);
  });

  it('clears the save error when a new story is written', async () => {
    const wrapper = await failedSave();
    api.startScenarioDraft.mockReturnValue(new Promise(() => {}));
    await wrapper.get(t('scenario-generator-generate')).trigger('click');
    await flushPromises();
    expect(wrapper.find(t('scenario-generator-apply-error')).exists()).toBe(false);
  });

  it('saves the same story on the second press without a new AI run', async () => {
    api.saveScenario.mockRejectedValueOnce(new Error('Could not save.'));
    const wrapper = setup();
    await flushPromises();
    await wrapper.get(t('scenario-generator-prompt')).setValue('A haunted lighthouse');
    await wrapper.get(t('scenario-generator-generate')).trigger('click');
    await flushPromises();
    await wrapper.get(t('scenario-generator-apply')).trigger('click');
    await flushPromises();
    expect(wrapper.get(t('scenario-generator-apply')).text()).toBe('Use this story');
    expect(wrapper.get(t('scenario-generator-preview')).text()).toContain('The Lost Lighthouse');
    expect(wrapper.get(t('scenario-generator-apply-error')).text()).toBe('Could not save.');
    expect(api.startScenarioDraft).toHaveBeenCalledTimes(1);

    await wrapper.get(t('scenario-generator-apply')).trigger('click');
    await flushPromises();
    expect(api.saveScenario).toHaveBeenCalledTimes(2);
    expect(api.startScenarioDraft).toHaveBeenCalledTimes(1);
    expect(wrapper.find(t('scenario-generator-apply-error')).exists()).toBe(false);
    expect(wrapper.find(t('scenario-generator-preview')).exists()).toBe(false);
    expect((wrapper.get(t('show-title')).element as HTMLInputElement).value).toBe('The Lost Lighthouse');
  });

  it('forgets a remembered draft only once its story is saved', async () => {
    window.sessionStorage.setItem('rpg-scenario-draft-job', 'job-1');
    api.scenarioDraft.mockResolvedValue(succeeded);
    api.saveScenario.mockRejectedValueOnce(new Error('Could not save.'));
    const wrapper = setup();
    await flushPromises();
    await wrapper.get(t('scenario-generator-apply')).trigger('click');
    await flushPromises();
    expect(window.sessionStorage.getItem('rpg-scenario-draft-job')).toBe('job-1');
    await wrapper.get(t('scenario-generator-apply')).trigger('click');
    await flushPromises();
    expect(window.sessionStorage.getItem('rpg-scenario-draft-job')).toBeNull();
    expect(wrapper.find(t('scenario-generator-preview')).exists()).toBe(false);
  });

  it('does not mention content boundaries in the make help line', async () => {
    const wrapper = setup();
    await flushPromises();
    const help = wrapper.get('.scenario-generator-panel .field-help').text();
    expect(help).toContain('Describe the story in a few sentences');
    expect(help).not.toContain('content boundaries');
  });
});
