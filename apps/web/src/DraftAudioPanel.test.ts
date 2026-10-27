// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftAudioManifest } from '@rpg/contracts';
import DraftAudioPanel from './DraftAudioPanel.vue';
import type { VoiceState } from './voice-state';

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
function panel(overrides: Partial<typeof props> & { paused?: boolean } = {}) {
  const wrapper = mount(DraftAudioPanel, { props: { ...props, ...overrides } });
  wrappers.push(wrapper); return wrapper;
}
const field = (id: string) => `[data-testid="${id}"]`;
const voices = (wrapper: ReturnType<typeof mount>) => (wrapper.emitted('voice') ?? []).map(event => event[0] as VoiceState);
const lastVoice = (wrapper: ReturnType<typeof mount>) => voices(wrapper).at(-1);
const posts = () => vi.mocked(fetch).mock.calls.filter(call => call[1]?.method === 'POST');
const missing = () => response({ status: 'missing' });
const previewDisabled = (wrapper: ReturnType<typeof mount>) => wrapper.get(field('preview-draft-audio')).element.matches(':disabled');
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

describe('narration preview', () => {
  it('restores a saved recording without playing or preparing it and reports the voice ready', async () => {
    const wrapper = panel(); await flushPromises();
    expect(fetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({ credentials: 'same-origin' }));
    expect(posts()).toHaveLength(0);
    expect(instances).toHaveLength(0);
    expect(previewDisabled(wrapper)).toBe(false);
    expect(wrapper.find(field('prepare-draft-audio')).exists()).toBe(false);
    expect(wrapper.find(field('publish-draft-audio')).exists()).toBe(false);
    expect(wrapper.text()).toContain('Narration preview');
    expect(wrapper.get(field('draft-audio-status')).text()).toBe('Voice ready. Preview it here if you like.');
    expect(wrapper.text()).toMatch(/AI-generated/i);
    expect(voices(wrapper)).toEqual([{ status: 'checking' }, { status: 'ready', preparationId }]);
  });

  it('has no publish emits and no highlight prop', async () => {
    const wrapper = panel(); await flushPromises();
    expect(wrapper.emitted('publish')).toBeUndefined();
    expect(wrapper.emitted('recording-ready')).toBeUndefined();
    expect(Object.keys(wrapper.props())).not.toContain('highlight');
    expect(wrapper.text()).not.toContain('Publish with narration');
  });

  it('prepares the saved revisions by itself and keeps the selected identity on every request and media URL', async () => {
    const identity = 'a'.repeat(32);
    window.history.replaceState({}, '', `/sessions/show/director?identity=${identity}`);
    vi.mocked(fetch).mockResolvedValueOnce(missing());
    const wrapper = panel(); await flushPromises();
    expect(fetch).toHaveBeenLastCalledWith(endpoint, expect.objectContaining({ method: 'POST', headers: { 'X-RPG-Identity': identity, 'Content-Type': 'application/json' } }));
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)![1]!.body));
    expect(body).toEqual({ commandId: expect.any(String), expectedBeatRevision: 5, draftRevision: 2, generation: 3 });
    expect(instances).toHaveLength(0);
    await click(wrapper, 'preview-draft-audio');
    expect(instances[0]!.src).toBe(`${manifest().segments[0]!.url}?identity=${identity}`);
  });

  it('reports checking, preparing, then ready while it prepares by itself', async () => {
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockResolvedValueOnce(missing());
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const wrapper = panel(); await flushPromises();
    expect(lastVoice(wrapper)).toEqual({ status: 'preparing' });
    expect(wrapper.get(field('draft-audio-status')).text()).toBe('Preparing voice…');
    expect(wrapper.find(field('prepare-draft-audio')).exists()).toBe(false);
    finish(ready()); await flushPromises();
    expect(voices(wrapper)).toEqual([{ status: 'checking' }, { status: 'preparing' }, { status: 'ready', preparationId }]);
  });

  it('prepares once per beat, draft revision and generation', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(missing()).mockResolvedValueOnce(ready());
    const wrapper = panel(); await flushPromises();
    expect(posts()).toHaveLength(1);
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: 'ready', manifest: manifest() }));
    await wrapper.setProps({ dirty: true }); await wrapper.setProps({ dirty: false }); await flushPromises();
    expect(posts()).toHaveLength(1);
    vi.mocked(fetch).mockResolvedValueOnce(missing())
      .mockResolvedValueOnce(response({ status: 'ready', manifest: { ...manifest(), draftRevision: 3 } }));
    await wrapper.setProps({ draftRevision: 3 }); await flushPromises();
    expect(posts()).toHaveLength(2);
    expect(JSON.parse(String(posts()[1]![1]!.body))).toMatchObject({ draftRevision: 3, generation: 3 });
    expect(lastVoice(wrapper)).toEqual({ status: 'ready', preparationId });
  });

  it('does not prepare again by itself for a key whose accepted preparation later reported missing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(missing()).mockResolvedValueOnce(response({ status: 'preparing', preparationId }));
    const wrapper = panel(); await flushPromises();
    expect(posts()).toHaveLength(1);
    vi.mocked(fetch).mockImplementation(async () => missing());
    await wrapper.setProps({ dirty: true }); await wrapper.setProps({ dirty: false }); await flushPromises();
    await vi.advanceTimersByTimeAsync(5000); await flushPromises();
    expect(posts()).toHaveLength(1);
    expect(lastVoice(wrapper)?.status).toBe('failed');
    expect(wrapper.find(field('prepare-draft-audio')).exists()).toBe(true);
  });

  it.each([['dirty', { dirty: true }, { dirty: false }], ['rendering', { rendering: true }, { rendering: false }], ['busy', { busy: true }, { busy: false }]] as const)(
    'waits while %s and prepares as soon as nothing blocks', async (_name, block, unblock) => {
      vi.mocked(fetch).mockImplementation(async () => missing());
      const wrapper = panel(block); await flushPromises();
      expect(posts()).toHaveLength(0);
      vi.mocked(fetch).mockImplementation(async (_url, init) => init?.method === 'POST' ? ready() : missing());
      await wrapper.setProps(unblock); await flushPromises();
      expect(posts()).toHaveLength(1);
      expect(lastVoice(wrapper)).toEqual({ status: 'ready', preparationId });
    });

  it('reports checking while the script is dirty, rendering or the identity is invalid', async () => {
    const wrapper = panel(); await flushPromises();
    await wrapper.setProps({ dirty: true });
    expect(lastVoice(wrapper)).toEqual({ status: 'checking' });
    expect(wrapper.text()).toMatch(/save.*script/i);
    vi.mocked(fetch).mockResolvedValueOnce(ready());
    await wrapper.setProps({ dirty: false }); await flushPromises();
    expect(lastVoice(wrapper)).toEqual({ status: 'ready', preparationId });
    await wrapper.setProps({ rendering: true });
    expect(lastVoice(wrapper)).toEqual({ status: 'checking' });
  });

  it('never changes the reported voice because of busy alone', async () => {
    const wrapper = panel(); await flushPromises();
    const before = voices(wrapper).length;
    await wrapper.setProps({ busy: true }); await flushPromises();
    await wrapper.setProps({ busy: false }); await flushPromises();
    expect(voices(wrapper)).toHaveLength(before);
    expect(lastVoice(wrapper)).toEqual({ status: 'ready', preparationId });
  });

  it('reports a busy wait for a missing recording as preparing, not checking', async () => {
    vi.mocked(fetch).mockImplementation(async () => missing());
    const wrapper = panel({ busy: true }); await flushPromises();
    expect(lastVoice(wrapper)).toEqual({ status: 'preparing' });
  });

  it('reports unavailable when speech is not set up and offers no prepare button', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(missing()).mockResolvedValueOnce(response({ status: 'unavailable' }));
    const wrapper = panel(); await flushPromises();
    expect(lastVoice(wrapper)).toEqual({ status: 'unavailable' });
    expect(wrapper.get(field('draft-audio-status')).text()).toBe('Speech is not set up. Publish without voice.');
    expect(wrapper.find(field('prepare-draft-audio')).exists()).toBe(false);
  });

  it('reports a refused preparation with its plain message and waits for Prepare voice again', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(missing()).mockResolvedValueOnce(response({ message: 'Speech could not be prepared.' }, false, 422));
    const wrapper = panel(); await flushPromises();
    expect(lastVoice(wrapper)).toEqual({ status: 'failed', message: 'Speech could not be prepared.' });
    expect(wrapper.get('[role="alert"]').text()).toContain('Speech could not be prepared.');
    expect(wrapper.get(field('draft-audio-status')).text()).toBe('The voice could not be prepared. Prepare voice again, or publish without voice.');
    vi.mocked(fetch).mockImplementation(async () => missing());
    await vi.advanceTimersByTimeAsync(10_000); await flushPromises();
    await wrapper.setProps({ busy: true }); await wrapper.setProps({ busy: false }); await flushPromises();
    expect(posts()).toHaveLength(1);
    const again = wrapper.get(field('prepare-draft-audio'));
    expect(again.text()).toBe('Prepare voice again');
    vi.mocked(fetch).mockImplementation(async () => ready());
    await click(wrapper, 'prepare-draft-audio');
    expect(posts()).toHaveLength(2);
    expect(lastVoice(wrapper)).toEqual({ status: 'ready', preparationId });
    expect(wrapper.find(field('prepare-draft-audio')).exists()).toBe(false);
  });

  it('does not prepare by itself when the server already holds a failed preparation', async () => {
    vi.mocked(fetch).mockImplementation(async () => response({ status: 'failed', preparationId }));
    const wrapper = panel(); await flushPromises();
    await vi.advanceTimersByTimeAsync(5000); await flushPromises();
    expect(posts()).toHaveLength(0);
    expect(lastVoice(wrapper)).toEqual({ status: 'failed', message: 'The voice could not be prepared. Prepare voice again, or publish without voice.' });
    expect(wrapper.find(field('prepare-draft-audio')).exists()).toBe(true);
  });

  it('reports a preparation the server says failed and offers Prepare voice again', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(missing()).mockResolvedValueOnce(response({ status: 'failed', preparationId }));
    const wrapper = panel(); await flushPromises();
    expect(posts()).toHaveLength(1);
    expect(lastVoice(wrapper)?.status).toBe('failed');
    expect(wrapper.get(field('prepare-draft-audio')).text()).toBe('Prepare voice again');
    await vi.advanceTimersByTimeAsync(20_000); await flushPromises();
    expect(lastVoice(wrapper)?.status).toBe('failed');
  });

  it('keeps checking after one failed status reply and ends ready without ever reporting failed', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ message: 'Server error.' }, false, 500));
    const wrapper = panel(); await flushPromises();
    expect(lastVoice(wrapper)).toEqual({ status: 'checking' });
    expect(wrapper.find(field('prepare-draft-audio')).exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000); await flushPromises();
    expect(voices(wrapper).map(voice => voice.status)).not.toContain('failed');
    expect(lastVoice(wrapper)).toEqual({ status: 'ready', preparationId });
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('keeps checking after a status check times out and ends ready without ever reporting failed', async () => {
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(() => {}));
    const wrapper = panel(); await flushPromises();
    await vi.advanceTimersByTimeAsync(10_001); await flushPromises();
    expect(lastVoice(wrapper)).toEqual({ status: 'checking' });
    await vi.advanceTimersByTimeAsync(1000); await flushPromises();
    expect(voices(wrapper).map(voice => voice.status)).not.toContain('failed');
    expect(lastVoice(wrapper)).toEqual({ status: 'ready', preparationId });
  });

  it('backs off 1, 2, 4, 8 then every 10 seconds without a limit on tries', async () => {
    vi.mocked(fetch).mockImplementation(async () => response({}, false, 500));
    const wrapper = panel(); await flushPromises();
    const gets = () => vi.mocked(fetch).mock.calls.length;
    expect(gets()).toBe(1);
    for (const [delay, count] of [[1000, 2], [2000, 3], [4000, 4], [8000, 5], [10_000, 6], [10_000, 7], [10_000, 8]] as const) {
      await vi.advanceTimersByTimeAsync(delay - 1); await flushPromises();
      expect(gets()).toBe(count - 1);
      await vi.advanceTimersByTimeAsync(1); await flushPromises();
      expect(gets()).toBe(count);
    }
    expect(voices(wrapper).map(voice => voice.status)).not.toContain('failed');
    vi.mocked(fetch).mockImplementation(async () => ready());
    await vi.advanceTimersByTimeAsync(10_000); await flushPromises();
    expect(lastVoice(wrapper)).toEqual({ status: 'ready', preparationId });
  });

  it('starts the back-off again after a good reply', async () => {
    const replies = [response({}, false, 500), response({}, false, 500), response({}, false, 500),
      response({ status: 'preparing', preparationId }), response({}, false, 500)];
    const times: number[] = [];
    vi.mocked(fetch).mockImplementation(async () => { times.push(Date.now()); return replies.shift() ?? ready(); });
    const wrapper = panel(); await flushPromises();
    await vi.advanceTimersByTimeAsync(20_000); await flushPromises();
    expect(times).toHaveLength(6);
    const gaps = times.slice(1).map((time, index) => time - times[index]!);
    expect(gaps.slice(0, 2)).toEqual([1000, 2000]);
    expect(gaps[4]).toBe(1000);
    expect(voices(wrapper).map(voice => voice.status)).not.toContain('failed');
    expect(lastVoice(wrapper)).toEqual({ status: 'ready', preparationId });
  });

  it('treats a server error on prepare as a blip and checks the result without another paid request', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(missing()).mockResolvedValueOnce(response({ message: 'Upstream error.' }, false, 502));
    const wrapper = panel(); await flushPromises();
    expect(posts()).toHaveLength(1);
    expect(lastVoice(wrapper)).toEqual({ status: 'preparing' });
    expect(wrapper.find(field('prepare-draft-audio')).exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000); await flushPromises();
    expect(posts()).toHaveLength(1);
    expect(voices(wrapper).map(voice => voice.status)).not.toContain('failed');
    expect(lastVoice(wrapper)).toEqual({ status: 'ready', preparationId });
  });

  it.each([
    ['a 500 reply', 1000, () => Promise.resolve(response({ message: 'Server error.' }, false, 500))],
    ['a dropped connection', 1000, () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a timeout', 61_000, () => new Promise<Response>(() => {})],
  ] as const)('sends the same preparation again when the check after %s finds nothing saved', async (_kind, wait, failure) => {
    vi.mocked(fetch).mockResolvedValueOnce(missing()).mockImplementationOnce(failure)
      .mockResolvedValueOnce(missing()).mockResolvedValueOnce(ready());
    const wrapper = panel(); await flushPromises();
    expect(posts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(wait); await flushPromises();
    expect(posts()).toHaveLength(2);
    expect(JSON.parse(String(posts()[1]![1]!.body))).toEqual(JSON.parse(String(posts()[0]![1]!.body)));
    expect(voices(wrapper).map(voice => voice.status)).toEqual(['checking', 'preparing', 'ready']);
    expect(wrapper.find(field('prepare-draft-audio')).exists()).toBe(false);
  });

  it('keeps backing off between preparations that keep failing in transit and stays preparing', async () => {
    const sent: number[] = [];
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      if (init?.method !== 'POST') return missing();
      sent.push(Date.now());
      return sent.length < 5 ? response({ message: 'Server error.' }, false, 500) : ready();
    });
    const wrapper = panel(); await flushPromises();
    await vi.advanceTimersByTimeAsync(20_000); await flushPromises();
    expect(sent.slice(1).map((time, index) => time - sent[index]!)).toEqual([1000, 2000, 4000, 8000]);
    expect(new Set(posts().map(call => JSON.parse(String(call[1]!.body)).commandId)).size).toBe(1);
    expect(voices(wrapper).map(voice => voice.status)).toEqual(['checking', 'preparing', 'ready']);
  });

  it.each([
    ['was dropped', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['was still under way', () => new Promise<Response>(() => {})],
  ] as const)('prepares again by itself when a preparation that %s is followed by an undone edit and nothing was saved', async (_fate, first) => {
    vi.mocked(fetch).mockResolvedValueOnce(missing()).mockImplementationOnce(first);
    const wrapper = panel(); await flushPromises();
    expect(posts()).toHaveLength(1);
    vi.mocked(fetch).mockImplementation(async (_url, init) => init?.method === 'POST' ? ready() : missing());
    await wrapper.setProps({ dirty: true }); await wrapper.setProps({ dirty: false }); await flushPromises();
    expect(posts()).toHaveLength(2);
    expect(voices(wrapper).map(voice => voice.status)).not.toContain('failed');
    expect(lastVoice(wrapper)).toEqual({ status: 'ready', preparationId });
  });

  it('waits for another operation to finish before sending a lost preparation again', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(missing()).mockResolvedValueOnce(response({ message: 'Server error.' }, false, 500));
    const wrapper = panel(); await flushPromises();
    vi.mocked(fetch).mockImplementation(async (_url, init) => init?.method === 'POST' ? ready() : missing());
    await wrapper.setProps({ busy: true });
    await vi.advanceTimersByTimeAsync(5000); await flushPromises();
    expect(posts()).toHaveLength(1);
    expect(lastVoice(wrapper)).toEqual({ status: 'preparing' });
    await wrapper.setProps({ busy: false }); await flushPromises();
    expect(posts()).toHaveLength(2);
    expect(voices(wrapper).map(voice => voice.status)).not.toContain('failed');
    expect(lastVoice(wrapper)).toEqual({ status: 'ready', preparationId });
  });

  it('clears a pending retry when the saved draft changes and when unmounted', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({}, false, 500));
    const wrapper = panel(); await flushPromises();
    expect(vi.getTimerCount()).toBe(2);
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => {}));
    await wrapper.setProps({ dirty: true });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000); await flushPromises();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    vi.mocked(fetch).mockResolvedValueOnce(response({}, false, 500));
    await wrapper.setProps({ dirty: false }); await flushPromises();
    expect(vi.getTimerCount()).toBe(2);
    wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('plays the clips in order and stops them', async () => {
    const wrapper = panel(); await flushPromises();
    await click(wrapper, 'preview-draft-audio');
    const first = instances[0]!;
    expect(first.play).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain('Mara considers her answer.');
    first.onended!(); await flushPromises();
    expect(first.pause).toHaveBeenCalled();
    expect(instances[1]!.src).toBe(manifest().segments[1]!.url);
    await click(wrapper, 'stop-draft-preview');
    expect(instances[1]!.pause).toHaveBeenCalled();
    expect(wrapper.find(field('stop-draft-preview')).exists()).toBe(false);
    expect(vi.mocked(fetch).mock.calls.every(call => !call[1]?.method)).toBe(true);
  });

  it('says the show is paused', async () => {
    const wrapper = panel({ paused: true }); await flushPromises();
    expect(wrapper.get('p.draft-audio-paused').text()).toBe('The show is paused. Resume it to publish.');
  });

  it('shows no paused text when the show is running', async () => {
    const wrapper = panel(); await flushPromises();
    expect(wrapper.find('.draft-audio-paused').exists()).toBe(false);
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
    expect(previewDisabled(wrapper)).toBe(true);
    ended(); await flushPromises();
    expect(instances).toHaveLength(1);
    await wrapper.setProps({ dirty: false }); await flushPromises();
    expect(previewDisabled(wrapper)).toBe(false);
    expect(instances).toHaveLength(1);
  });

  it('ignores preparation results that arrive after the saved draft changes', async () => {
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockResolvedValueOnce(missing());
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const wrapper = panel(); await flushPromises();
    expect(posts()).toHaveLength(1);
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: 'preparing', preparationId }));
    await wrapper.setProps({ draftRevision: 3, generation: 4 }); await flushPromises();
    finish(ready()); await flushPromises();
    expect(previewDisabled(wrapper)).toBe(true);
    expect(lastVoice(wrapper)).toEqual({ status: 'preparing' });
    expect(instances).toHaveLength(0);
  });

  it('invalidates audio when regeneration begins even if the last draft revision remains unchanged', async () => {
    const wrapper = panel(); await flushPromises();
    await click(wrapper, 'preview-draft-audio');
    await wrapper.setProps({ rendering: true, generation: 4 });
    expect(instances[0]!.pause).toHaveBeenCalled();
    expect(previewDisabled(wrapper)).toBe(true);
    expect(lastVoice(wrapper)).toEqual({ status: 'checking' });
    expect(wrapper.text()).toMatch(/being written/i);
  });

  it('keeps a reviewed recording through a continuity-only beat revision change', async () => {
    const wrapper = panel(); await flushPromises();
    await click(wrapper, 'preview-draft-audio');
    await wrapper.setProps({ beatRevision: 6 });
    expect(instances[0]!.pause).not.toHaveBeenCalled();
    expect(lastVoice(wrapper)).toEqual({ status: 'ready', preparationId });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('pauses preview during another operation without losing the ready voice', async () => {
    const wrapper = panel(); await flushPromises();
    await click(wrapper, 'preview-draft-audio');
    await wrapper.setProps({ busy: true });
    expect(instances[0]!.pause).toHaveBeenCalled();
    expect(previewDisabled(wrapper)).toBe(true);
    await wrapper.setProps({ busy: false });
    expect(previewDisabled(wrapper)).toBe(false);
    expect(lastVoice(wrapper)).toEqual({ status: 'ready', preparationId });
    expect(instances).toHaveLength(1);
  });

  it('polls a current preparation without resubmitting speech or starting playback', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: 'preparing', preparationId }));
    const wrapper = panel(); await flushPromises();
    expect(lastVoice(wrapper)).toEqual({ status: 'preparing' });
    await vi.advanceTimersByTimeAsync(1500); await flushPromises();
    expect(lastVoice(wrapper)).toEqual({ status: 'ready', preparationId });
    expect(instances).toHaveLength(0);
    expect(posts()).toHaveLength(0);
  });

  it.each(['foreign-session', 'old-generation', 'public-url'])('rejects a %s recording response', async problem => {
    const value = manifest();
    if (problem === 'foreign-session') value.segments[0]!.url = value.segments[0]!.url.replace('/show/', '/another/');
    if (problem === 'old-generation') value.generation--;
    if (problem === 'public-url') value.segments[0]!.url = `/api/sessions/show/audio/assets/${'a'.repeat(64)}`;
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: 'ready', manifest: value }));
    const wrapper = panel(); await flushPromises();
    expect(previewDisabled(wrapper)).toBe(true);
    expect(lastVoice(wrapper)).toEqual({ status: 'checking' });
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(instances).toHaveLength(0);
    expect(posts()).toHaveLength(0);
  });

  it('contains a preview playback failure without changing the ready voice', async () => {
    vi.stubGlobal('Audio', class extends FakeAudio { constructor(src: string) { super(src); this.play.mockRejectedValue(new Error('NotAllowedError')); } });
    const wrapper = panel(); await flushPromises();
    await click(wrapper, 'preview-draft-audio');
    expect(wrapper.get('[role="alert"]').text()).toMatch(/browser|permission/i);
    expect(lastVoice(wrapper)).toEqual({ status: 'ready', preparationId });
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

  it('checks an uncertain preparation request for an outcome instead of sending another', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(missing()).mockRejectedValueOnce(new Error('Connection interrupted'));
    const wrapper = panel(); await flushPromises();
    expect(lastVoice(wrapper)).toEqual({ status: 'preparing' });
    expect(wrapper.find(field('prepare-draft-audio')).exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000); await flushPromises();
    expect(posts()).toHaveLength(1);
    expect(voices(wrapper).map(voice => voice.status)).not.toContain('failed');
    expect(lastVoice(wrapper)).toEqual({ status: 'ready', preparationId });
  });

  it.each(['fetch', 'body'])('bounds a stalled GET %s so the director can recover', async phase => {
    vi.mocked(fetch).mockImplementationOnce(() => phase === 'fetch'
      ? new Promise<Response>(() => {})
      : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) } as Response));
    const wrapper = panel(); await flushPromises();
    expect(lastVoice(wrapper)).toEqual({ status: 'checking' });
    await vi.advanceTimersByTimeAsync(10_001); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toMatch(/timed out|too long/i);
    expect(lastVoice(wrapper)).toEqual({ status: 'checking' });
    expect(wrapper.find(field('prepare-draft-audio')).exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000); await flushPromises();
    expect(posts()).toHaveLength(0);
    expect(voices(wrapper).map(voice => voice.status)).not.toContain('failed');
    expect(lastVoice(wrapper)).toEqual({ status: 'ready', preparationId });
  });

  it.each(['fetch', 'body'])('bounds a stalled prepare %s and checks its result without another paid request', async phase => {
    vi.mocked(fetch).mockResolvedValueOnce(missing());
    vi.mocked(fetch).mockImplementationOnce(() => phase === 'fetch'
      ? new Promise<Response>(() => {})
      : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) } as Response));
    const wrapper = panel(); await flushPromises();
    await vi.advanceTimersByTimeAsync(59_000); await flushPromises();
    expect(lastVoice(wrapper)).toEqual({ status: 'preparing' });
    await vi.advanceTimersByTimeAsync(1_001); await flushPromises();
    await vi.advanceTimersByTimeAsync(1500); await flushPromises();
    expect(lastVoice(wrapper)).toEqual({ status: 'ready', preparationId });
    expect(posts()).toHaveLength(1);
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
    expect(previewDisabled(wrapper)).toBe(true);
    expect(lastVoice(wrapper)).toEqual({ status: 'checking' });
  });

  it('ignores a result from the prior identity and cleans up media and timers on unmount', async () => {
    let finish!: (value: Response) => void;
    window.history.replaceState({}, '', `/?identity=${'a'.repeat(32)}`);
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const wrapper = panel();
    window.history.replaceState({}, '', `/?identity=${'b'.repeat(32)}`);
    finish(ready()); await flushPromises();
    expect(previewDisabled(wrapper)).toBe(true);
    expect(lastVoice(wrapper)).toEqual({ status: 'checking' });
    expect(posts()).toHaveLength(0);
    wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
