// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackSnapshot } from '../../../packages/contracts/src/playback';
import AudioPanel from './AudioPanel.vue';

const playbackId = '11111111-1111-4111-8111-111111111111';
const leaseId = '22222222-2222-4222-8222-222222222222';
const instances: FakeAudio[] = [];
class FakeAudio {
  src: string;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  load = vi.fn();
  currentTime = 0;
  volume = 1;
  muted = false;
  readyState = 4;
  duration = 120;
  constructor(src: string) { this.src = src; instances.push(this); }
}
const manifest = { beatId: 'beat-1', segments: [
  { id: 'one', text: 'Mara sets down the glass.', speaker: 'Narrator', voiceProfileId: 'narrator', url: `/api/sessions/show/audio/assets/${'a'.repeat(64)}` },
  { id: 'two', text: 'Who sent you?', speaker: 'Mara Vale', voiceProfileId: 'mara', url: `/api/sessions/show/audio/assets/${'b'.repeat(64)}` },
] };
let shared: PlaybackSnapshot;
let latest: unknown;
let preparation: { ok: boolean; data: unknown };
const wrappers: ReturnType<typeof mount>[] = [];
const serverNow = () => 100_000 + Math.floor(performance.now());
const response = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => data }) as Response;
const requests = (suffix: string) => vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith(suffix));
function active(overrides: Partial<PlaybackSnapshot> = {}) {
  shared = { ...shared, playbackId, manifest, status: 'playing', segmentIndex: 0, positionMs: 3000, anchorTimeMs: 99_000, presenter: { available: true, leaseExpiresAtMs: 110_000 }, ...overrides };
}
function panel(props: { director: boolean; stage?: boolean; beatId?: string; compact?: boolean } = { director: true, beatId: 'beat-1' }) {
  const wrapper = mount(AudioPanel, { props: { sessionId: 'show', ...props } });
  wrappers.push(wrapper);
  return wrapper;
}
async function click(wrapper: ReturnType<typeof mount>, testId: string) {
  await wrapper.get(`[data-testid="${testId}"]`).trigger('click');
  await flushPromises();
}

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  vi.useFakeTimers(); vi.setSystemTime(0); instances.length = 0;
  shared = { schemaVersion: 1, sessionId: 'show', revision: 0, sampleRevision: 0, serverTimeMs: 100_000, playbackId: null, status: 'idle', manifest: null, segmentIndex: null, positionMs: 0, anchorTimeMs: null, presenter: { available: false, leaseExpiresAtMs: null } };
  latest = { status: 'ready', manifest };
  preparation = { ok: true, data: { status: 'ready', manifest } };
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.includes('/audio/')) return body ? response(preparation.data, preparation.ok) : response(latest);
    shared.serverTimeMs = serverNow();
    if (url.endsWith('/presenter')) {
      shared = { ...shared, revision: shared.revision + (body.type === 'renew' ? 0 : 1), sampleRevision: shared.sampleRevision + 1,
        presenter: { available: body.type !== 'release', leaseExpiresAtMs: body.type === 'release' ? null : serverNow() + 10_000 } };
      if (body.type === 'release' && shared.status === 'playing') shared = { ...shared, status: 'paused', anchorTimeMs: null };
      return response({ snapshot: shared, ...(body.type === 'claim' ? { leaseId } : {}) });
    }
    if (url.endsWith('/commands')) {
      const changes: Partial<PlaybackSnapshot> = body.type === 'start'
        ? { playbackId, manifest, status: 'playing', segmentIndex: 0, positionMs: 0, anchorTimeMs: serverNow() }
        : body.type === 'pause' ? { status: 'paused', anchorTimeMs: null }
        : body.type === 'resume' ? { status: 'playing', anchorTimeMs: serverNow() }
        : body.type === 'skip' ? { segmentIndex: 1, positionMs: 0, anchorTimeMs: serverNow() }
        : { status: 'stopped', segmentIndex: null, positionMs: 0, anchorTimeMs: null };
      shared = { ...shared, ...changes, revision: shared.revision + 1, sampleRevision: shared.sampleRevision + 1 };
      return response({ snapshot: shared });
    }
    if (url.endsWith('/telemetry')) return response({ snapshot: shared });
    return response(shared);
  }));
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('coordinated reviewed audio panel', () => {
  it('exists before any publication, stays silent, and lets a stage volunteer before narration is prepared', async () => {
    const wrapper = panel({ director: true });
    await flushPromises();
    expect(wrapper.find('[data-testid="audio-panel"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="playback-status"]').text()).toMatch(/idle|not started|waiting/i);
    expect(wrapper.text()).toMatch(/publish a beat/i);
    expect(wrapper.find('[data-testid="prepare-audio"]').exists()).toBe(false);
    expect(requests('/audio/undefined')).toHaveLength(0);
    expect(instances).toHaveLength(0);
    const stage = panel({ director: false, stage: true });
    await flushPromises();
    expect(stage.get('[data-testid="present-audio"]').attributes('disabled')).toBeUndefined();
    expect(stage.find('[data-testid="listen-audio"]').exists()).toBe(false);
  });

  it('uses the selected identity for preparation, shared commands, polls, and native audio downloads', async () => {
    const identity = 'a'.repeat(32);
    window.history.replaceState({}, '', `/sessions/show/director?identity=${identity}`);
    active(); latest = { status: 'missing' };
    const wrapper = panel(); await flushPromises();
    expect(fetch).toHaveBeenCalledWith('/api/sessions/show/playback', expect.objectContaining({ headers: { 'X-RPG-Identity': identity } }));
    expect(fetch).toHaveBeenCalledWith('/api/sessions/show/audio/beat-1', expect.objectContaining({ headers: { 'X-RPG-Identity': identity } }));
    await click(wrapper, 'prepare-audio');
    expect(requests('/audio/beat-1').at(-1)?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-RPG-Identity': identity } });
    await click(wrapper, 'listen-audio');
    expect(instances[0].src).toBe(`${manifest.segments[0].url}?identity=${identity}`);
    await click(wrapper, 'pause-audio');
    expect(requests('/commands').at(-1)?.[1]).toMatchObject({ headers: { 'X-RPG-Identity': identity } });
    expect(JSON.parse(String(requests('/commands').at(-1)?.[1]?.body))).toMatchObject({ type: 'pause', playbackId });
  });

  it('does not play on mount, polling, or later publications and removes every timer on unmount', async () => {
    active();
    const wrapper = panel({ director: false, beatId: 'beat-1' }); await flushPromises();
    expect(instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3000);
    latest = { status: 'missing' };
    await wrapper.setProps({ beatId: 'beat-2' }); await flushPromises();
    expect(instances).toHaveLength(0);
    expect(fetch).toHaveBeenCalledWith('/api/sessions/show/audio/beat-2', expect.objectContaining({ credentials: 'same-origin' }));
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('offers stage ownership without shared controls or an unowned listening bypass', async () => {
    const wrapper = panel({ director: false, stage: true, beatId: 'beat-1' }); await flushPromises();
    for (const id of ['listen-audio', 'prepare-audio', 'start-audio', 'pause-audio', 'skip-audio', 'stop-audio']) expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(false);
    expect(wrapper.text()).toMatch(/one.*presenter|one browser.*broadcast/i);
    expect(wrapper.text()).toContain('The main show link in OBS supplies broadcast audio. Present audio here takes it over.');
    expect(wrapper.text()).not.toContain('Choose Present audio in this stage browser');
    await click(wrapper, 'present-audio');
    expect(wrapper.get('.audio-confirm').text()).toContain('Take the broadcast audio from OBS? Viewers will hear this browser instead.');
    expect(requests('/presenter')).toHaveLength(0);
    await click(wrapper, 'confirm-present-audio');
    expect(wrapper.find('.audio-confirm').exists()).toBe(false);
    expect(wrapper.find('[data-testid="release-audio"]').exists()).toBe(true);
    expect(instances).toHaveLength(0);
    await click(wrapper, 'release-audio');
    expect(JSON.parse(String(requests('/presenter').at(-1)?.[1]?.body))).toMatchObject({ type: 'release', leaseId });
    shared.presenter = { available: true, leaseExpiresAtMs: 110_000 };
    shared.sampleRevision++;
    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.get('[data-testid="present-audio"]').attributes('disabled')).toBeDefined();
  });

  it('uses the show-link wording on the stage and names Listen in this browser elsewhere', async () => {
    const stage = panel({ director: false, stage: true, beatId: 'beat-1' }); await flushPromises();
    expect(stage.text()).toContain('AI-generated voices. The main show link in OBS plays the broadcast audio. Volume affects this browser.');
    const director = panel(); await flushPromises();
    expect(director.text()).toContain('AI-generated voices. Audio starts only after you choose Listen in this browser. Volume and mute affect this browser.');
  });

  it('closes the Present here confirm when another browser becomes the presenter', async () => {
    const wrapper = panel({ director: false, stage: true, beatId: 'beat-1' }); await flushPromises();
    await click(wrapper, 'present-audio');
    expect(wrapper.find('.audio-confirm').exists()).toBe(true);
    shared.presenter = { available: true, leaseExpiresAtMs: 110_000 };
    shared.sampleRevision++;
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(wrapper.find('.audio-confirm').exists()).toBe(false);
  });

  it('does not claim the presenter lease when the confirm is cancelled, and claims it on Present here', async () => {
    const wrapper = panel({ director: false, stage: true, beatId: 'beat-1' }); await flushPromises();
    await click(wrapper, 'present-audio');
    const cancel = wrapper.findAll('.audio-confirm button').find(b => b.text() === 'Cancel')!;
    expect(cancel.classes()).toContain('quiet');
    await cancel.trigger('click'); await flushPromises();
    expect(wrapper.find('.audio-confirm').exists()).toBe(false);
    expect(requests('/presenter')).toHaveLength(0);
    expect(wrapper.find('[data-testid="release-audio"]').exists()).toBe(false);
    await click(wrapper, 'present-audio');
    await click(wrapper, 'confirm-present-audio');
    expect(requests('/presenter')).toHaveLength(1);
    expect(JSON.parse(String(requests('/presenter')[0][1]?.body))).toMatchObject({ type: 'claim' });
  });

  it('gates director start on a ready latest manifest and presenter, and switches to deliberate replay after stop', async () => {
    const wrapper = panel(); await flushPromises();
    expect(wrapper.get('[data-testid="start-audio"]').attributes('disabled')).toBeDefined();
    const hostStage = panel({ director: true, stage: true, beatId: 'beat-1' }); await flushPromises();
    await click(hostStage, 'present-audio');
    await click(hostStage, 'confirm-present-audio');
    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.get('[data-testid="start-audio"]').attributes('disabled')).toBeUndefined();
    await click(wrapper, 'start-audio');
    expect(JSON.parse(String(requests('/commands').at(-1)?.[1]?.body))).toMatchObject({ type: 'start', beatId: 'beat-1' });
    expect(wrapper.find('[data-testid="start-audio"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="replay-audio"]').exists()).toBe(true);
    await click(wrapper, 'stop-audio');
    expect(wrapper.find('[data-testid="replay-audio"]').exists()).toBe(true);
    await click(wrapper, 'replay-audio');
    expect(JSON.parse(String(requests('/commands').at(-1)?.[1]?.body))).toMatchObject({ type: 'start', beatId: 'beat-1' });
  });

  it('keeps presenter ownership in the stage view and points an ordinary director to the main show link', async () => {
    const wrapper = panel(); await flushPromises();
    expect(wrapper.find('[data-testid="present-audio"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="release-audio"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Load the main show link in OBS');
    expect(wrapper.text()).not.toMatch(/choose Present audio/i);
    expect(wrapper.find('[data-testid="listen-audio"]').exists()).toBe(true);
    active({ sampleRevision: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.find('[data-testid="present-audio"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="release-audio"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="pause-audio"]').exists()).toBe(true);
  });

  it('keeps captions and transport for the pinned performance while the latest beat is missing or preparing', async () => {
    active();
    const wrapper = panel(); await flushPromises();
    await click(wrapper, 'listen-audio');
    const clip = instances[0];
    latest = { status: 'missing' };
    await wrapper.setProps({ beatId: 'beat-2' }); await flushPromises();
    expect(wrapper.find('.audio-caption').text()).toContain(manifest.segments[0].text);
    expect(clip.pause).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="pause-audio"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[data-testid="start-audio"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="replay-audio"]').attributes('disabled')).toBeUndefined();
    let finish!: (value: Response) => void;
    const delayed = new Promise<Response>(resolve => { finish = resolve; });
    vi.mocked(fetch).mockImplementationOnce(() => delayed);
    await wrapper.get('[data-testid="prepare-audio"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="stop-audio"]').attributes('disabled')).toBeUndefined();
    await click(wrapper, 'stop-audio');
    expect(JSON.parse(String(requests('/commands').at(-1)?.[1]?.body)).type).toBe('stop');
    finish(response({ status: 'preparing' })); await flushPromises();
  });

  it('replays the pinned performance when a newer publication has no prepared audio', async () => {
    active({ status: 'stopped', segmentIndex: null, anchorTimeMs: null });
    latest = { status: 'missing' };
    const wrapper = panel({ director: true, beatId: 'beat-2' }); await flushPromises();
    expect(wrapper.get('[data-testid="start-audio"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="replay-audio"]').attributes('disabled')).toBeUndefined();
    await click(wrapper, 'replay-audio');
    expect(JSON.parse(String(requests('/commands').at(-1)?.[1]?.body))).toMatchObject({ type: 'start', beatId: 'beat-1' });
    expect(instances).toHaveLength(0);
  });

  it('sends director pause, resume and skip to shared playback while local listening stays optional', async () => {
    active();
    const wrapper = panel(); await flushPromises();
    expect(instances).toHaveLength(0);
    await click(wrapper, 'pause-audio');
    expect(wrapper.get('[data-testid="playback-status"]').text()).toMatch(/paused/i);
    await click(wrapper, 'resume-audio');
    await click(wrapper, 'skip-audio');
    expect(requests('/commands').map(call => JSON.parse(String(call[1]?.body)).type)).toEqual(['pause', 'resume', 'skip']);
    expect(wrapper.find('.audio-caption').text()).toContain(manifest.segments[1].text);
    expect(instances).toHaveLength(0);
  });

  it('gives players only optional Listen, mute and local volume without sending shared mutations', async () => {
    active();
    const wrapper = panel({ director: false, beatId: 'beat-1' }); await flushPromises();
    for (const id of ['present-audio', 'release-audio', 'prepare-audio', 'start-audio', 'replay-audio', 'pause-audio', 'resume-audio', 'skip-audio', 'stop-audio']) expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(false);
    await click(wrapper, 'listen-audio');
    expect(instances[0].play).toHaveBeenCalledOnce();
    expect(instances[0].currentTime).toBeCloseTo(4);
    await wrapper.get('[data-testid="audio-volume"]').setValue('0.35');
    expect(instances[0].volume).toBe(.35);
    expect(wrapper.text()).toMatch(/local|this browser/i);
    await click(wrapper, 'mute-audio');
    expect(instances[0].pause).toHaveBeenCalled();
    expect(wrapper.find('[data-testid="listen-audio"]').exists()).toBe(true);
    expect(vi.mocked(fetch).mock.calls.every(call => !call[1]?.method)).toBe(true);
  });

  it('announces playback and accessible volume without adding status roles that obscure saved feedback', async () => {
    const wrapper = panel(); await flushPromises();
    expect(wrapper.find('[role="status"], output').exists()).toBe(false);
    expect(wrapper.get('[data-testid="playback-status"]').attributes('aria-live')).toBe('polite');
    const volume = wrapper.get('[data-testid="audio-volume"]');
    expect(volume.attributes('aria-valuetext')).toBe('100%');
    await volume.setValue('0.35');
    expect(volume.attributes('aria-valuetext')).toBe('35%');
    expect(wrapper.get('.audio-volume-value').attributes('aria-hidden')).toBe('true');
    expect(wrapper.get('.audio-volume-value').text()).toBe('35%');
  });

  it('contains provider failures and preserves current playback controls and published text', async () => {
    active(); latest = { status: 'missing' };
    preparation = { ok: false, data: { message: 'Speech provider unavailable.' } };
    const wrapper = panel(); await flushPromises();
    await click(wrapper, 'prepare-audio');
    expect(wrapper.get('[role="alert"]').text()).toContain('Speech provider unavailable.');
    expect(wrapper.text()).toContain('The published text remains available.');
    expect(wrapper.get('[data-testid="stop-audio"]').attributes('disabled')).toBeUndefined();
    expect(instances).toHaveLength(0);
  });

  it('shows malformed or foreign prepared manifests and prevents starting them', async () => {
    latest = { status: 'ready', manifest: { ...manifest, segments: [{ ...manifest.segments[0], url: 'https://foreign.test/private.mp3' }] } };
    const wrapper = panel(); await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="start-audio"]').attributes('disabled')).toBeDefined();
    expect(instances).toHaveLength(0);
  });

  it('surfaces blocked playback and allows an explicit Listen retry without a substitute voice', async () => {
    active();
    vi.stubGlobal('Audio', class extends FakeAudio { constructor(src: string) { super(src); if (instances.length === 1) this.play.mockRejectedValue(new Error('NotAllowedError')); } });
    const wrapper = panel({ director: false, beatId: 'beat-1' }); await flushPromises();
    await click(wrapper, 'listen-audio');
    expect(wrapper.get('[role="alert"]').text()).toContain('Playback could not start');
    expect(instances).toHaveLength(1);
    await click(wrapper, 'listen-audio');
    expect(instances).toHaveLength(2);
    expect(instances[1].play).toHaveBeenCalledOnce();
  });

  it('cleans local audio and ownership when the mounted role or session changes', async () => {
    active();
    const wrapper = panel(); await flushPromises();
    await click(wrapper, 'listen-audio');
    await wrapper.setProps({ director: false, stage: true }); await flushPromises();
    expect(instances[0].pause).toHaveBeenCalled();
    expect(wrapper.find('[data-testid="listen-audio"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="pause-audio"]').exists()).toBe(false);
    shared = { ...shared, sessionId: 'next-show', presenter: { available: false, leaseExpiresAtMs: null }, manifest: null, status: 'idle', playbackId: null, segmentIndex: null, anchorTimeMs: null };
    await wrapper.setProps({ sessionId: 'next-show', beatId: undefined }); await flushPromises();
    expect(fetch).toHaveBeenCalledWith('/api/sessions/next-show/playback', expect.anything());
    expect(wrapper.get('[data-testid="present-audio"]').attributes('disabled')).toBeUndefined();
    expect(instances).toHaveLength(1);
  });
});

describe('compact audio panel', () => {
  it('renders only the listen control, volume and note', async () => {
    active();
    const wrapper = panel({ director: false, beatId: 'beat-1', compact: true }); await flushPromises();
    const root = wrapper.get('section.audio-panel.compact');
    expect(root.attributes('aria-label')).toBe('Narration');
    expect(wrapper.get('[data-testid="listen-audio"]').text()).toBe('Hear the story here');
    expect(wrapper.get('label.audio-volume').text()).toContain('Volume');
    expect(wrapper.text()).toContain('AI-generated voices. Plays the narration in this browser, in step with the show.');
    for (const id of ['playback-status', 'prepare-audio', 'start-audio', 'replay-audio', 'pause-audio', 'resume-audio', 'skip-audio', 'stop-audio', 'present-audio', 'release-audio']) expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(false);
    expect(wrapper.find('.audio-heading').exists()).toBe(false);
    expect(wrapper.find('.audio-caption').exists()).toBe(false);
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });

  it('listens, mutes and sets volume without any command request', async () => {
    active();
    const wrapper = panel({ director: false, beatId: 'beat-1', compact: true }); await flushPromises();
    await click(wrapper, 'listen-audio');
    expect(wrapper.get('[data-testid="mute-audio"]').text()).toBe('Mute');
    await wrapper.get('[data-testid="audio-volume"]').setValue('0.35');
    expect(instances[0].volume).toBe(.35);
    await click(wrapper, 'mute-audio');
    expect(wrapper.get('[data-testid="listen-audio"]').text()).toBe('Hear the story here');
    expect(vi.mocked(fetch).mock.calls.some(call => (call[1] as RequestInit | undefined)?.method)).toBe(false);
  });

  it('still shows blocked playback as an alert', async () => {
    active();
    vi.stubGlobal('Audio', class extends FakeAudio { constructor(src: string) { super(src); this.play.mockRejectedValue(new Error('NotAllowedError')); } });
    const wrapper = panel({ director: false, beatId: 'beat-1', compact: true }); await flushPromises();
    await click(wrapper, 'listen-audio');
    expect(wrapper.get('[role="alert"]').text()).toBe('The sound could not play in this browser. Press Hear the story here to try again. The story still plays on the stream.');
  });
});
