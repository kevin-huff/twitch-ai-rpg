// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftAudioManifest } from '@rpg/contracts';
import DraftAudioPanel from './DraftAudioPanel.vue';

const preparationId = '11111111-1111-4111-8111-111111111111';
const instances: FakeAudio[] = [];
class FakeAudio {
  src: string;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  load = vi.fn();
  constructor(src: string) { this.src = src; instances.push(this); }
}
const props = { sessionId: 'show', beatId: 'beat-one', beatRevision: 5, draftRevision: 2, generation: 3, dirty: false, busy: false, rendering: false };
const endpoint = '/api/sessions/show/beats/beat-one/draft-audio';
const manifest = (): DraftAudioManifest => ({
  preparationId, beatId: props.beatId, draftRevision: props.draftRevision, generation: props.generation,
  segments: [
    { index: 0, text: 'Mara considers her answer.', speaker: 'Narrator', voiceProfileId: 'narrator', url: `${endpoint}/${preparationId}/segments/0` },
    { index: 1, text: 'You should ask the owner.', speaker: 'Mara', voiceProfileId: 'mara', url: `${endpoint}/${preparationId}/segments/1` },
  ],
});
const response = (data: unknown, ok = true, status = ok ? 200 : 503) => ({ ok, status, json: async () => data }) as Response;
const ready = () => response({ status: 'ready', manifest: manifest() });
const wrappers: ReturnType<typeof mount>[] = [];
function panel(overrides: Partial<typeof props> = {}) {
  const wrapper = mount(DraftAudioPanel, { props: { ...props, ...overrides } });
  wrappers.push(wrapper); return wrapper;
}
const field = (id: string) => `[data-testid="${id}"]`;
async function click(wrapper: ReturnType<typeof mount>, id: string) {
  await wrapper.get(field(id)).trigger('click'); await flushPromises();
}

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  vi.useFakeTimers(); instances.length = 0;
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => ready()));
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('private recording review', () => {
  it('restores a saved recording without playing, preparing, or publishing it', async () => {
    const wrapper = panel(); await flushPromises();
    expect(fetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({ credentials: 'same-origin' }));
    expect(instances).toHaveLength(0);
    expect(wrapper.get(field('preview-draft-audio')).element.matches(':disabled')).toBe(false);
    expect(wrapper.get(field('publish-draft-audio')).element.matches(':disabled')).toBe(false);
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.text()).toMatch(/private|director/i);
    expect(wrapper.text()).toMatch(/AI-generated/i);
    expect(wrapper.emitted('publish')).toBeUndefined();
  });

  it('prepares only the saved revisions and keeps the selected identity on every request and media URL', async () => {
    const identity = 'a'.repeat(32);
    window.history.replaceState({}, '', `/sessions/show/director?identity=${identity}`);
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: 'missing' }));
    const wrapper = panel(); await flushPromises();
    await click(wrapper, 'prepare-draft-audio');
    expect(fetch).toHaveBeenLastCalledWith(endpoint, expect.objectContaining({ method: 'POST', headers: { 'X-RPG-Identity': identity, 'Content-Type': 'application/json' } }));
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)![1]!.body));
    expect(body).toEqual({ commandId: expect.any(String), expectedBeatRevision: 5, draftRevision: 2, generation: 3 });
    expect(instances).toHaveLength(0);
    await click(wrapper, 'preview-draft-audio');
    expect(instances[0]!.src).toBe(`${manifest().segments[0]!.url}?identity=${identity}`);
  });

  it('plays the reviewed clips in order and emits only the chosen preparation on publication', async () => {
    const wrapper = panel(); await flushPromises();
    await click(wrapper, 'preview-draft-audio');
    const first = instances[0]!;
    expect(first.play).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain('Mara considers her answer.');
    first.onended!(); await flushPromises();
    expect(first.pause).toHaveBeenCalled();
    expect(instances[1]!.src).toBe(manifest().segments[1]!.url);
    await click(wrapper, 'publish-draft-audio');
    expect(instances[1]!.pause).toHaveBeenCalled();
    expect(wrapper.emitted('publish')).toEqual([[preparationId]]);
    expect(vi.mocked(fetch).mock.calls.every(call => !call[1]?.method)).toBe(true);
  });

  it('ignores completion and error callbacks from a clip after the next clip starts', async () => {
    const wrapper = panel(); await flushPromises();
    await click(wrapper, 'preview-draft-audio');
    const ended = instances[0]!.onended!; const failed = instances[0]!.onerror!;
    ended(); await flushPromises();
    ended(); failed(); await flushPromises();
    expect(instances).toHaveLength(2);
    expect(instances[1]!.pause).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('stops and discards the preview as soon as script edits are unsaved', async () => {
    const wrapper = panel(); await flushPromises();
    await click(wrapper, 'preview-draft-audio');
    const audio = instances[0]!; const ended = audio.onended!;
    await wrapper.setProps({ dirty: true });
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.onended).toBeNull();
    expect(wrapper.get(field('publish-draft-audio')).element.matches(':disabled')).toBe(true);
    expect(wrapper.get(field('preview-draft-audio')).element.matches(':disabled')).toBe(true);
    expect(wrapper.text()).toMatch(/save.*script/i);
    ended(); await flushPromises();
    expect(instances).toHaveLength(1);
    await wrapper.setProps({ dirty: false }); await flushPromises();
    expect(wrapper.get(field('preview-draft-audio')).element.matches(':disabled')).toBe(false);
    expect(instances).toHaveLength(1);
  });

  it('ignores preparation results that arrive after the saved draft changes', async () => {
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: 'missing' }));
    const wrapper = panel(); await flushPromises();
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await wrapper.get(field('prepare-draft-audio')).trigger('click');
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: 'missing' }));
    await wrapper.setProps({ draftRevision: 3, generation: 4 }); await flushPromises();
    finish(ready()); await flushPromises();
    expect(wrapper.get(field('publish-draft-audio')).element.matches(':disabled')).toBe(true);
    expect(instances).toHaveLength(0);
  });

  it('invalidates audio when regeneration begins even if the last draft revision remains unchanged', async () => {
    const wrapper = panel(); await flushPromises();
    await click(wrapper, 'preview-draft-audio');
    await wrapper.setProps({ rendering: true, generation: 4 });
    expect(instances[0]!.pause).toHaveBeenCalled();
    expect(wrapper.get(field('publish-draft-audio')).element.matches(':disabled')).toBe(true);
    expect(wrapper.get(field('prepare-draft-audio')).element.matches(':disabled')).toBe(true);
    expect(wrapper.text()).toMatch(/generat/i);
  });

  it('keeps a reviewed recording through a continuity-only beat revision change', async () => {
    const wrapper = panel(); await flushPromises();
    await click(wrapper, 'preview-draft-audio');
    await wrapper.setProps({ beatRevision: 6 });
    expect(instances[0]!.pause).not.toHaveBeenCalled();
    expect(wrapper.get(field('publish-draft-audio')).element.matches(':disabled')).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('pauses preview and disables actions during another operation without losing saved readiness', async () => {
    const wrapper = panel(); await flushPromises();
    await click(wrapper, 'preview-draft-audio');
    await wrapper.setProps({ busy: true });
    expect(instances[0]!.pause).toHaveBeenCalled();
    expect(wrapper.get(field('publish-draft-audio')).element.matches(':disabled')).toBe(true);
    await wrapper.setProps({ busy: false });
    expect(wrapper.get(field('publish-draft-audio')).element.matches(':disabled')).toBe(false);
    expect(instances).toHaveLength(1);
  });

  it('polls a current preparation without resubmitting speech or starting playback', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: 'preparing', preparationId }));
    const wrapper = panel(); await flushPromises();
    expect(wrapper.get(field('prepare-draft-audio')).element.matches(':disabled')).toBe(true);
    await vi.advanceTimersByTimeAsync(1500); await flushPromises();
    expect(wrapper.get(field('publish-draft-audio')).element.matches(':disabled')).toBe(false);
    expect(instances).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls.every(call => !call[1]?.method)).toBe(true);
  });

  it.each(['foreign-session', 'old-generation', 'public-url'])('rejects a %s recording response', async problem => {
    const value = manifest();
    if (problem === 'foreign-session') value.segments[0]!.url = value.segments[0]!.url.replace('/show/', '/another/');
    if (problem === 'old-generation') value.generation--;
    if (problem === 'public-url') value.segments[0]!.url = `/api/sessions/show/audio/assets/${'a'.repeat(64)}`;
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: 'ready', manifest: value }));
    const wrapper = panel(); await flushPromises();
    expect(wrapper.get(field('publish-draft-audio')).element.matches(':disabled')).toBe(true);
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(instances).toHaveLength(0);
  });

  it('contains preparation and autoplay failures while leaving text-only publication available', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: 'missing' }));
    const wrapper = panel(); await flushPromises();
    vi.mocked(fetch).mockResolvedValueOnce(response({ message: 'Speech could not be prepared.' }, false));
    await click(wrapper, 'prepare-draft-audio');
    expect(wrapper.get('[role="alert"]').text()).toContain('Speech could not be prepared.');
    expect(wrapper.text()).toMatch(/text.only/i);
    await click(wrapper, 'prepare-draft-audio');
    vi.stubGlobal('Audio', class extends FakeAudio { constructor(src: string) { super(src); this.play.mockRejectedValue(new Error('NotAllowedError')); } });
    await click(wrapper, 'preview-draft-audio');
    expect(wrapper.get('[role="alert"]').text()).toMatch(/browser|permission/i);
    expect(wrapper.get(field('publish-draft-audio')).element.matches(':disabled')).toBe(false);
  });

  it.each(['resolve', 'reject'])('does not let a late play %s or old error stop a newer preview', async completion => {
    let finish!: () => void;
    let fail!: (reason: unknown) => void;
    vi.stubGlobal('Audio', class extends FakeAudio {
      constructor(src: string) { super(src); if (instances.length === 1) this.play.mockImplementation(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; })); }
    });
    const wrapper = panel(); await flushPromises();
    await click(wrapper, 'preview-draft-audio');
    const oldError = instances[0]!.onerror!;
    await click(wrapper, 'stop-draft-preview');
    await click(wrapper, 'preview-draft-audio');
    if (completion === 'resolve') finish(); else fail(new Error('old rejection'));
    oldError(); await flushPromises();
    expect(instances[0]!.pause).toHaveBeenCalled();
    expect(instances[1]!.pause).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('reuses an uncertain preparation request until the server reports an outcome', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: 'missing' }));
    const wrapper = panel(); await flushPromises();
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Connection interrupted'));
    await click(wrapper, 'prepare-draft-audio');
    const first = vi.mocked(fetch).mock.calls.at(-1)![1]!.body;
    await click(wrapper, 'prepare-draft-audio');
    expect(vi.mocked(fetch).mock.calls.at(-1)![1]!.body).toBe(first);
    expect(wrapper.get(field('publish-draft-audio')).element.matches(':disabled')).toBe(false);
  });

  it.each(['fetch', 'body'])('bounds a stalled GET %s so the director can recover', async phase => {
    vi.mocked(fetch).mockImplementationOnce(() => phase === 'fetch'
      ? new Promise<Response>(() => {})
      : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) } as Response));
    const wrapper = panel(); await flushPromises();
    expect(wrapper.get(field('prepare-draft-audio')).element.matches(':disabled')).toBe(true);
    await vi.advanceTimersByTimeAsync(10_001); await flushPromises();
    expect(wrapper.get(field('prepare-draft-audio')).element.matches(':disabled')).toBe(false);
    expect(wrapper.get('[role="alert"]').text()).toMatch(/timed out|too long/i);
    await click(wrapper, 'prepare-draft-audio');
    expect(wrapper.get(field('publish-draft-audio')).element.matches(':disabled')).toBe(false);
  });

  it.each(['fetch', 'body'])('bounds a stalled prepare %s and checks its result without another paid request', async phase => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: 'missing' }));
    const wrapper = panel(); await flushPromises();
    vi.mocked(fetch).mockImplementationOnce(() => phase === 'fetch'
      ? new Promise<Response>(() => {})
      : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) } as Response));
    await wrapper.get(field('prepare-draft-audio')).trigger('click');
    await vi.advanceTimersByTimeAsync(60_001); await flushPromises();
    await vi.advanceTimersByTimeAsync(1500); await flushPromises();
    expect(wrapper.get(field('publish-draft-audio')).element.matches(':disabled')).toBe(false);
    expect(vi.mocked(fetch).mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
    expect(instances).toHaveLength(0);
  });

  it('clears a stalled request deadline immediately when unmounted', async () => {
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(() => {}));
    const wrapper = panel(); await flushPromises();
    wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1);
    expect(vi.getTimerCount()).toBe(0);
    await flushPromises();
  });

  it('stops and refuses continuation when the selected browser identity changes', async () => {
    window.history.replaceState({}, '', `/?identity=${'a'.repeat(32)}`);
    const wrapper = panel(); await flushPromises();
    await click(wrapper, 'preview-draft-audio');
    const ended = instances[0]!.onended!;
    window.history.replaceState({}, '', `/?identity=${'b'.repeat(32)}`);
    ended(); await flushPromises();
    expect(instances).toHaveLength(1);
    expect(instances[0]!.pause).toHaveBeenCalled();
    expect(wrapper.get(field('publish-draft-audio')).element.matches(':disabled')).toBe(true);
  });

  it('ignores a result from the prior identity and cleans up media and timers on unmount', async () => {
    let finish!: (value: Response) => void;
    window.history.replaceState({}, '', `/?identity=${'a'.repeat(32)}`);
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const wrapper = panel();
    window.history.replaceState({}, '', `/?identity=${'b'.repeat(32)}`);
    finish(ready()); await flushPromises();
    expect(wrapper.get(field('publish-draft-audio')).element.matches(':disabled')).toBe(true);
    wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
