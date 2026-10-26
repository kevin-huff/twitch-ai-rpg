// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScenarioDefinition, ScenarioDraftJob } from '@rpg/contracts';
import { ZodError } from 'zod';
import ScenarioGenerator from './ScenarioGenerator.vue';

const KEY = 'rpg-scenario-draft-job';
const RESUME = 'Your earlier draft is still being written. It will appear here when it is ready.';

const T0 = new Date('2026-10-24T12:00:00.000Z').getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const selector = (name: string) => `[data-testid="scenario-generator-${name}"]`;
const wrappers: ReturnType<typeof mount>[] = [];

const definition = {
  schemaVersion: 1, title: 'The Lost Lighthouse', premise: 'A storm traps the keepers.', genre: '', tone: '', boundaries: [],
  locations: [{ id: 'l1', title: 'Lantern room' }, { id: 'l2', title: 'Cellar' }],
  openingScene: { id: 's1', title: 'Storm', description: '', locationId: 'l1' },
  npcs: [{ id: 'n1', displayName: 'Mara' }],
  tracks: [{ id: 't1', label: 'Tide' }, { id: 't2', label: 'Lamp oil' }],
  facts: [{ id: 'f1', text: 'a', visibility: 'public' }, { id: 'f2', text: 'b', visibility: 'director' }, { id: 'f3', text: 'c', visibility: 'public' }],
} as unknown as ScenarioDefinition;

const running = (deadlineMs = 180_000): ScenarioDraftJob => ({ status: 'running', jobId: 'job-1', size: 'medium', startedAt: iso(T0), deadlineAt: iso(T0 + deadlineMs) });
const succeeded = (extra: Partial<Extract<ScenarioDraftJob, { status: 'succeeded' }>> = {}): ScenarioDraftJob => ({
  status: 'succeeded', jobId: 'job-1', definition, adjustments: ['Dropped a place with no title.'], warnings: ['Mara hides in public text.'],
  suggestedBoundaries: ['Keep serious injuries off screen.'], ...extra,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function panel(props: Record<string, unknown> = {}) {
  const start = vi.fn().mockResolvedValue(running());
  const poll = vi.fn().mockResolvedValue(running());
  const wrapper = mount(ScenarioGenerator, { props: { boundaries: [], premise: '', replacesUnsaved: false, start, poll, ...props } });
  wrappers.push(wrapper);
  return { wrapper, start, poll };
}
async function open(wrapper: ReturnType<typeof mount>) { await wrapper.get(selector('open')).trigger('click'); }
async function generate(wrapper: ReturnType<typeof mount>, text = 'A haunted lighthouse') {
  await open(wrapper);
  await wrapper.get(selector('prompt')).setValue(text);
  await wrapper.get(selector('generate')).trigger('click');
  await flushPromises();
}
async function tick(ms: number) { await vi.advanceTimersByTimeAsync(ms); await flushPromises(); }

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); window.sessionStorage.clear(); });
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('ScenarioGenerator', () => {
  it('shows only the open button until pressed', async () => {
    const { wrapper } = panel();
    expect(wrapper.get(selector('open')).text()).toBe('Create the whole scenario with AI');
    expect(wrapper.find(selector('prompt')).exists()).toBe(false);
    await open(wrapper);
    expect(wrapper.find(selector('prompt')).exists()).toBe(true);
    expect(wrapper.get(selector('open')).attributes('disabled')).toBeDefined();
  });

  it('starts the prompt with the trimmed premise, capped at 4000 characters', async () => {
    const { wrapper } = panel({ premise: `  ${'a'.repeat(4500)}  ` });
    await open(wrapper);
    expect((wrapper.get(selector('prompt')).element as HTMLTextAreaElement).value).toBe('a'.repeat(4000));
    expect(wrapper.get(selector('prompt')).attributes('maxlength')).toBe('4000');
    const second = panel({ premise: '  A quiet harbor.  ' });
    await open(second.wrapper);
    expect((second.wrapper.get(selector('prompt')).element as HTMLTextAreaElement).value).toBe('A quiet harbor.');
  });

  it('offers Small, Medium and Large with Medium chosen', async () => {
    const { wrapper } = panel();
    await open(wrapper);
    const select = wrapper.get(selector('size'));
    expect(select.findAll('option').map(option => [option.text(), option.attributes('value')])).toEqual([['Small', 'small'], ['Medium', 'medium'], ['Large', 'large']]);
    expect((select.element as HTMLSelectElement).value).toBe('medium');
  });

  it('keeps Generate off for a blank prompt and sends the size and trimmed boundaries', async () => {
    const { wrapper, start } = panel({ boundaries: ['  No gore  ', '   ', 'No spiders'] });
    await open(wrapper);
    await wrapper.get(selector('prompt')).setValue('   ');
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeDefined();
    await wrapper.get(selector('prompt')).setValue('  A haunted lighthouse  ');
    await wrapper.get(selector('size')).setValue('large');
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeUndefined();
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ prompt: 'A haunted lighthouse', size: 'large', boundaries: ['No gore', 'No spiders'] });
  });

  it('shows the status with minutes from the job deadline', async () => {
    const { wrapper, start } = panel();
    start.mockResolvedValue(running(240_000));
    await generate(wrapper);
    expect(wrapper.get(selector('status')).text()).toBe('The AI is writing your story. This can take up to 4 minutes.');
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeDefined();
  });

  it('rounds the minutes up', async () => {
    const { wrapper, start } = panel();
    start.mockResolvedValue(running(150_000));
    await generate(wrapper);
    expect(wrapper.get(selector('status')).text()).toContain('up to 3 minutes');
  });

  it('first polls 2 seconds after start and then every 2 seconds', async () => {
    const { wrapper, poll } = panel();
    await generate(wrapper);
    expect(poll).not.toHaveBeenCalled();
    await tick(1999); expect(poll).not.toHaveBeenCalled();
    await tick(1); expect(poll).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledWith('job-1');
    await tick(2000); expect(poll).toHaveBeenCalledTimes(2);
    await tick(2000); expect(poll).toHaveBeenCalledTimes(3);
  });

  it('does not overlap a slow poll with the next one', async () => {
    const { wrapper, poll } = panel();
    const slow = deferred<ScenarioDraftJob>();
    poll.mockReturnValueOnce(slow.promise);
    await generate(wrapper);
    await tick(2000); expect(poll).toHaveBeenCalledTimes(1);
    await tick(10_000); expect(poll).toHaveBeenCalledTimes(1);
    slow.resolve(running()); await flushPromises();
    await tick(2000); expect(poll).toHaveBeenCalledTimes(2);
  });

  it('shows the preview when the job succeeds and stops polling', async () => {
    const { wrapper, poll } = panel();
    poll.mockResolvedValueOnce(running()).mockResolvedValueOnce(succeeded());
    await generate(wrapper);
    await tick(2000); await tick(2000);
    expect(wrapper.find(selector('status')).exists()).toBe(false);
    const preview = wrapper.get(selector('preview'));
    const text = preview.text();
    expect(text).toContain('The Lost Lighthouse');
    expect(text).toContain('A storm traps the keepers.');
    expect(text).toContain('2 places: Lantern room, Cellar');
    expect(text).toContain('1 character: Mara');
    expect(text).toContain('2 tracks: Tide, Lamp oil');
    expect(text).toContain('3 facts, 1 only the director sees');
    expect(preview.findAll('h4').map(heading => heading.text())).toEqual(['Places', 'Characters', 'Tracks', 'Facts', 'Suggested boundaries', 'What the app changed', 'Check before you save']);
    expect(text).toContain('Keep serious injuries off screen.');
    expect(text).toContain('Dropped a place with no title.');
    expect(text).toContain('Mara hides in public text.');
    const calls = poll.mock.calls.length;
    await tick(10_000); expect(poll).toHaveBeenCalledTimes(calls);
    expect(wrapper.text()).toContain('Nothing is saved until you press Save scenario version.');
  });

  it('leaves out empty sections of the preview', async () => {
    const { wrapper, start } = panel();
    start.mockResolvedValue(succeeded({ adjustments: [], warnings: [], suggestedBoundaries: [] }));
    await generate(wrapper);
    expect(wrapper.findAll('h4').map(heading => heading.text())).toEqual(['Places', 'Characters', 'Tracks', 'Facts']);
  });

  it('shows a failed job message with Try again', async () => {
    const { wrapper, poll } = panel();
    poll.mockResolvedValueOnce({ status: 'failed', jobId: 'job-1', code: 'generation_failed', message: "The AI's draft did not fit the form. Try again, or fill in the form yourself." });
    await generate(wrapper);
    await tick(2000);
    expect(wrapper.get('[role="alert"]').text()).toBe("The AI's draft did not fit the form. Try again, or fill in the form yourself.");
    expect(wrapper.get(selector('generate')).text()).toBe('Try again');
    expect(wrapper.find(selector('status')).exists()).toBe(false);
    await tick(10_000); expect(poll).toHaveBeenCalledTimes(1);
  });

  it('shows the message of a rejected start and Try again, then starts again', async () => {
    const { wrapper, start } = panel();
    start.mockRejectedValueOnce(new Error('A scenario draft is still being written. Wait for it to finish.'));
    await generate(wrapper);
    expect(wrapper.get('[role="alert"]').text()).toBe('A scenario draft is still being written. Wait for it to finish.');
    expect(wrapper.get(selector('generate')).text()).toBe('Try again');
    expect(wrapper.get(selector('prompt')).attributes('disabled')).toBeUndefined();
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    expect(start).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find(selector('status')).exists()).toBe(true);
  });

  it('says the draft expired on a 404 poll and stops polling', async () => {
    const { wrapper, poll } = panel();
    poll.mockRejectedValueOnce(Object.assign(new Error('That scenario draft was not found. It may have expired.'), { status: 404 }));
    await generate(wrapper);
    await tick(2000);
    expect(wrapper.get('[role="alert"]').text()).toBe('This draft is no longer on the server. Press Generate to try again.');
    expect(wrapper.get(selector('generate')).text()).toBe('Generate');
    await tick(10_000); expect(poll).toHaveBeenCalledTimes(1);
  });

  it('retries other poll errors until the give-up time, then shows the timeout message', async () => {
    const { wrapper, start, poll } = panel();
    start.mockResolvedValue(running(60_000));
    poll.mockRejectedValue(Object.assign(new Error('Server error'), { status: 500 }));
    await generate(wrapper);
    await tick(2000); await tick(2000);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find(selector('status')).exists()).toBe(true);
    await tick(87_000);
    expect(wrapper.get('[role="alert"]').text()).toBe('The AI took too long. Try again, or fill in the form yourself.');
    expect(wrapper.get(selector('generate')).text()).toBe('Try again');
    const calls = poll.mock.calls.length;
    await tick(20_000); expect(poll).toHaveBeenCalledTimes(calls);
  });

  it('recovers when a poll succeeds after an error', async () => {
    const { wrapper, poll } = panel();
    poll.mockRejectedValueOnce(new Error('Network down')).mockResolvedValueOnce(succeeded());
    await generate(wrapper);
    await tick(2000); await tick(2000);
    expect(wrapper.find(selector('preview')).exists()).toBe(true);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('gives up 30 seconds after the deadline even when the job still reports running', async () => {
    const { wrapper, start, poll } = panel();
    start.mockResolvedValue(running(40_000));
    await generate(wrapper);
    await tick(69_000);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    await tick(1500);
    expect(wrapper.get('[role="alert"]').text()).toContain('The AI took too long.');
    const calls = poll.mock.calls.length;
    await tick(10_000); expect(poll).toHaveBeenCalledTimes(calls);
  });

  it('does not depend on the browser clock agreeing with the server clock', async () => {
    const { wrapper, poll } = panel();
    vi.setSystemTime(T0 + 600_000);
    await generate(wrapper);
    await tick(1000);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    await tick(199_000);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    await tick(11_000);
    expect(wrapper.get('[role="alert"]').text()).toContain('The AI took too long.');
    const calls = poll.mock.calls.length;
    await tick(10_000); expect(poll).toHaveBeenCalledTimes(calls);
  });

  it('Cancel stops polling and closes the panel', async () => {
    const { wrapper, poll } = panel();
    await generate(wrapper);
    await tick(2000); expect(poll).toHaveBeenCalledTimes(1);
    await wrapper.get(selector('cancel')).trigger('click');
    expect(wrapper.find(selector('prompt')).exists()).toBe(false);
    await tick(10_000); expect(poll).toHaveBeenCalledTimes(1);
  });

  it('ignores a start that finishes after Cancel', async () => {
    const { wrapper, start, poll } = panel();
    const pending = deferred<ScenarioDraftJob>();
    start.mockReturnValue(pending.promise);
    await generate(wrapper);
    await wrapper.get(selector('cancel')).trigger('click');
    pending.resolve(running()); await flushPromises();
    await tick(10_000);
    expect(poll).not.toHaveBeenCalled();
    expect(wrapper.find(selector('status')).exists()).toBe(false);
  });

  it('ignores a poll that finishes after Cancel', async () => {
    const { wrapper, poll } = panel();
    const slow = deferred<ScenarioDraftJob>();
    poll.mockReturnValueOnce(slow.promise);
    await generate(wrapper);
    await tick(2000);
    await wrapper.get(selector('cancel')).trigger('click');
    slow.resolve(succeeded()); await flushPromises();
    expect(wrapper.find(selector('preview')).exists()).toBe(false);
    await open(wrapper);
    expect(wrapper.find(selector('preview')).exists()).toBe(false);
  });

  it('stops polling when unmounted', async () => {
    const { wrapper, poll } = panel();
    await generate(wrapper);
    await tick(2000); expect(poll).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    await tick(10_000); expect(poll).toHaveBeenCalledTimes(1);
  });

  it('loads the draft and emits every part, then closes', async () => {
    const { wrapper, start } = panel();
    start.mockResolvedValue(succeeded());
    await generate(wrapper);
    expect(wrapper.get(selector('apply')).text()).toBe('Load into the editor');
    expect(wrapper.text()).not.toContain('This replaces your unsaved changes in the editor.');
    await wrapper.get(selector('apply')).trigger('click');
    expect(wrapper.emitted('apply')).toEqual([[{
      definition, adjustments: ['Dropped a place with no title.'], warnings: ['Mara hides in public text.'], suggestedBoundaries: ['Keep serious injuries off screen.'],
    }]]);
    expect(wrapper.find(selector('prompt')).exists()).toBe(false);
    expect(wrapper.find(selector('preview')).exists()).toBe(false);
  });

  it('warns before replacing unsaved work', async () => {
    const { wrapper, start } = panel({ replacesUnsaved: true });
    start.mockResolvedValue(succeeded());
    await generate(wrapper);
    expect(wrapper.get(selector('apply')).text()).toBe('Replace the editor with this draft');
    expect(wrapper.text()).toContain('This replaces your unsaved changes in the editor.');
  });

  it('does not emit until the person presses apply', async () => {
    const { wrapper, start } = panel();
    start.mockResolvedValue(succeeded());
    await generate(wrapper);
    expect(wrapper.emitted('apply')).toBeUndefined();
  });

  it('disables everything while the parent disables it', async () => {
    const { wrapper } = panel({ disabled: true });
    expect(wrapper.get(selector('open')).attributes('disabled')).toBeDefined();
  });

  it('starts fresh when reopened after Cancel', async () => {
    const { wrapper, start } = panel({ premise: 'Premise text' });
    start.mockResolvedValue(succeeded());
    await generate(wrapper, 'Something else');
    await wrapper.get(selector('cancel')).trigger('click');
    await open(wrapper);
    expect(wrapper.find(selector('preview')).exists()).toBe(false);
    expect((wrapper.get(selector('prompt')).element as HTMLTextAreaElement).value).toBe('Premise text');
  });

  it('gives every control its own visible help and no name contains AI Generate', async () => {
    const { wrapper, start } = panel();
    start.mockResolvedValue(succeeded());
    await generate(wrapper);
    const controls = wrapper.findAll('input, textarea, select');
    expect(controls.length).toBeGreaterThanOrEqual(2);
    const seen = new Set<string>();
    for (const control of controls) {
      const ids = (control.attributes('aria-describedby') ?? '').split(' ').filter(Boolean);
      expect(ids).toHaveLength(1);
      expect(seen.has(ids[0])).toBe(false);
      seen.add(ids[0]);
      const help = wrapper.get(`[id="${ids[0]}"]`);
      expect(help.element.tagName).toBe('P');
      expect(help.classes()).toContain('field-help');
      expect(help.text().length).toBeGreaterThan(20);
      expect(control.element.closest('label')?.contains(help.element) ?? false).toBe(false);
    }
    for (const element of wrapper.element.querySelectorAll('button, section, [aria-label]')) {
      const name = `${element.getAttribute('aria-label') ?? ''} ${element.textContent ?? ''}`;
      expect(name).not.toContain('AI Generate');
    }
    expect(wrapper.find('.generator-panel, .generator-preview, .field-ai').exists()).toBe(false);
  });
});

describe('ScenarioGenerator resume and errors', () => {
  it('keeps the job id on Cancel, then resumes polling and shows the preview on reopen', async () => {
    const { wrapper, poll } = panel();
    await generate(wrapper);
    expect(window.sessionStorage.getItem(KEY)).toBe('job-1');
    await wrapper.get(selector('cancel')).trigger('click');
    expect(window.sessionStorage.getItem(KEY)).toBe('job-1');
    poll.mockResolvedValueOnce(running()).mockResolvedValueOnce(succeeded());
    await open(wrapper); await flushPromises();
    expect(poll).toHaveBeenCalledWith('job-1');
    expect(wrapper.get('[role="status"]').text()).toBe(RESUME);
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeDefined();
    await tick(2000);
    expect(wrapper.find(selector('preview')).exists()).toBe(true);
    expect(wrapper.text()).not.toContain(RESUME);
    expect(window.sessionStorage.getItem(KEY)).toBe('job-1');
  });

  it('keeps the resume sentence beside the normal status line while a resumed job runs', async () => {
    window.sessionStorage.setItem(KEY, 'job-1');
    const { wrapper, poll } = panel();
    await open(wrapper); await flushPromises();
    expect(poll).toHaveBeenCalledTimes(1);
    expect(wrapper.get(selector('resume')).text()).toBe(RESUME);
    expect(wrapper.get(selector('status')).text()).toContain('The AI is writing your story.');
  });

  it('gives up on a resumed job once its full time limit plus 30 seconds has passed since resuming', async () => {
    window.sessionStorage.setItem(KEY, 'job-1');
    const { wrapper } = panel();
    await open(wrapper); await flushPromises();
    await tick(209_000);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    await tick(1500);
    expect(wrapper.get('[role="alert"]').text()).toContain('The AI took too long.');
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it('gives up on a resumed job at 390 seconds when every poll fails', async () => {
    window.sessionStorage.setItem(KEY, 'job-1');
    const { wrapper, poll } = panel();
    poll.mockRejectedValue(Object.assign(new Error('Server error'), { status: 500 }));
    await open(wrapper); await flushPromises();
    expect(wrapper.get(selector('resume')).text()).toBe(RESUME);
    await tick(389_000);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    await tick(1500);
    expect(wrapper.get('[role="alert"]').text()).toContain('The AI took too long.');
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(wrapper.get(selector('generate')).text()).toBe('Try again');
    const calls = poll.mock.calls.length;
    await tick(10_000); expect(poll).toHaveBeenCalledTimes(calls);
  });

  it('remembers a draft whose start reply arrives after Cancel, then resumes it on reopen', async () => {
    const { wrapper, start, poll } = panel();
    const pending = deferred<ScenarioDraftJob>();
    start.mockReturnValue(pending.promise);
    await generate(wrapper);
    await wrapper.get(selector('cancel')).trigger('click');
    pending.resolve(running()); await flushPromises();
    expect(window.sessionStorage.getItem(KEY)).toBe('job-1');
    poll.mockResolvedValueOnce(succeeded());
    await open(wrapper); await flushPromises();
    expect(poll).toHaveBeenCalledWith('job-1');
    expect(wrapper.find(selector('preview')).exists()).toBe(true);
  });

  it('resumes the remembered job instead of showing the busy message when Generate hits a 409', async () => {
    const { wrapper, start, poll } = panel();
    start.mockRejectedValueOnce(Object.assign(new Error('A scenario draft is still being written. Wait for it to finish.'), { status: 409 }));
    poll.mockResolvedValueOnce(running()).mockResolvedValueOnce(succeeded());
    await open(wrapper);
    await wrapper.get(selector('prompt')).setValue('A haunted lighthouse');
    window.sessionStorage.setItem(KEY, 'job-1');
    await wrapper.get(selector('generate')).trigger('click'); await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(poll).toHaveBeenCalledWith('job-1');
    expect(wrapper.find(selector('status')).exists()).toBe(true);
    await tick(2000);
    expect(wrapper.find(selector('preview')).exists()).toBe(true);
  });

  it('shows the server message on a 409 when no id is remembered', async () => {
    const { wrapper, start } = panel();
    start.mockRejectedValueOnce(Object.assign(new Error('A scenario draft is still being written. Wait for it to finish.'), { status: 409 }));
    await generate(wrapper);
    expect(wrapper.get('[role="alert"]').text()).toBe('A scenario draft is still being written. Wait for it to finish.');
  });

  it('forgets the id after Load into the editor', async () => {
    const { wrapper, poll } = panel();
    poll.mockResolvedValueOnce(succeeded());
    await generate(wrapper);
    await tick(2000);
    expect(window.sessionStorage.getItem(KEY)).toBe('job-1');
    await wrapper.get(selector('apply')).trigger('click');
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it('forgets the id after Cancel on a shown preview', async () => {
    const { wrapper, poll } = panel();
    poll.mockResolvedValueOnce(succeeded());
    await generate(wrapper);
    await tick(2000);
    expect(window.sessionStorage.getItem(KEY)).toBe('job-1');
    await wrapper.get(selector('cancel')).trigger('click');
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    await open(wrapper);
    expect(wrapper.find(selector('resume')).exists()).toBe(false);
    expect(wrapper.find(selector('preview')).exists()).toBe(false);
  });

  it('forgets the id after a failed job', async () => {
    const { wrapper, poll } = panel();
    poll.mockResolvedValueOnce({ status: 'failed', jobId: 'job-1', code: 'generation_failed', message: 'Nope.' });
    await generate(wrapper);
    expect(window.sessionStorage.getItem(KEY)).toBe('job-1');
    await tick(2000);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it('forgets the id after a 404', async () => {
    const { wrapper, poll } = panel();
    poll.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }));
    await generate(wrapper);
    await tick(2000);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(wrapper.get('[role="alert"]').text()).toContain('no longer on the server');
  });

  it('forgets a remembered id that answers 404 on resume', async () => {
    window.sessionStorage.setItem(KEY, 'old-job');
    const { wrapper, poll } = panel();
    poll.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }));
    await open(wrapper); await flushPromises();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(wrapper.get('[role="alert"]').text()).toContain('no longer on the server');
    await wrapper.get(selector('prompt')).setValue('A haunted lighthouse');
    expect(wrapper.get(selector('generate')).attributes('disabled')).toBeUndefined();
  });

  it('keeps working when sessionStorage throws on every call', async () => {
    const boom = () => { throw new Error('storage blocked'); };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom);
    const { wrapper, poll } = panel();
    poll.mockResolvedValueOnce(running()).mockResolvedValueOnce(succeeded());
    await generate(wrapper);
    await tick(2000); await tick(2000);
    expect(wrapper.find(selector('preview')).exists()).toBe(true);
    await wrapper.get(selector('apply')).trigger('click');
    expect(wrapper.emitted('apply')).toHaveLength(1);
  });

  it('shows a plain sentence when the browser rejects the request', async () => {
    const { wrapper, start } = panel();
    const zod = new ZodError([{ code: 'too_big', origin: 'string', maximum: 200, inclusive: true, path: ['boundaries', 0], message: 'Too big' } as never]);
    start.mockRejectedValueOnce(zod);
    await generate(wrapper);
    expect(wrapper.get('[role="alert"]').text()).toBe('One of your content boundaries is too long, or there are more than 30. Shorten or remove some, then try again.');
  });

  it('keeps showing the message of an ordinary error', async () => {
    const { wrapper, start } = panel();
    start.mockRejectedValueOnce(Object.assign(new Error('Sign in again.'), { status: 401 }));
    await generate(wrapper);
    expect(wrapper.get('[role="alert"]').text()).toBe('Sign in again.');
  });

  it('keeps Generate secondary before and after a result, and the apply button plain', async () => {
    const { wrapper, start } = panel();
    await open(wrapper);
    expect(wrapper.get(selector('generate')).classes()).toContain('secondary');
    start.mockResolvedValue(succeeded());
    await generate(wrapper);
    expect(wrapper.get(selector('generate')).classes()).toContain('secondary');
    const apply = wrapper.get(selector('apply')).classes();
    expect(apply).not.toContain('secondary');
    expect(apply).not.toContain('quiet');
  });
});
