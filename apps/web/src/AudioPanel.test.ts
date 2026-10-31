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
const holderId = '33333333-3333-4333-8333-333333333333';
type HolderData = { holderId: string; label: string; showTitle: string; browser: 'obs' | 'browser' | 'unknown'; claimedAt: string | null };
let holder: HolderData | null;
let holderFails: boolean;
let stopRefusal: string | null;
const wrappers: ReturnType<typeof mount>[] = [];
const serverNow = () => 100_000 + Math.floor(performance.now());
const response = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => data }) as Response;
const requests = (suffix: string) => vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith(suffix));
function active(overrides: Partial<PlaybackSnapshot> = {}) {
  shared = { ...shared, playbackId, manifest, status: 'playing', segmentIndex: 0, positionMs: 3000, anchorTimeMs: 99_000, presenter: { available: true, leaseExpiresAtMs: 110_000 }, ...overrides };
}
function panel(props: { director: boolean; stage?: boolean; beatId?: string; compact?: boolean; autoPlayBeatId?: string | null } = { director: true, beatId: 'beat-1' }) {
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
  holder = null; holderFails = false; stopRefusal = null;
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.includes('/audio/')) return body ? response(preparation.data, preparation.ok) : response(latest);
    if (url.endsWith('/holder/stop')) {
      if (stopRefusal) return { ok: false, status: 409, json: async () => ({ message: stopRefusal }) } as Response;
      holder = null;
      return response({ holder: null });
    }
    if (url.endsWith('/playback/holder')) return holderFails ? response({ message: 'down' }, false) : response({ holder });
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

describe('auto-play after a voiced publish', () => {
  const starts = () => requests('/commands').filter(call => JSON.parse(String(call[1]?.body)).type === 'start');
  const withPresenter = () => { shared.presenter = { available: true, leaseExpiresAtMs: 110_000 }; shared.sampleRevision++; };

  it('sends one start once the manifest becomes ready', async () => {
    withPresenter(); latest = { status: 'missing' };
    panel({ director: true, beatId: 'beat-1', autoPlayBeatId: 'beat-1' }); await flushPromises();
    expect(starts()).toHaveLength(0);
    latest = { status: 'ready', manifest };
    await vi.advanceTimersByTimeAsync(3000); await flushPromises();
    expect(starts()).toHaveLength(1);
    expect(JSON.parse(String(starts()[0][1]?.body))).toMatchObject({ type: 'start', beatId: 'beat-1' });
  });

  it('waits while the previous narration plays, then starts', async () => {
    withPresenter();
    active({ manifest: { ...manifest, beatId: 'beat-0' } });
    panel({ director: true, beatId: 'beat-1', autoPlayBeatId: 'beat-1' }); await flushPromises();
    await vi.advanceTimersByTimeAsync(3000); await flushPromises();
    expect(starts()).toHaveLength(0);
    shared = { ...shared, status: 'complete', anchorTimeMs: null, revision: shared.revision + 1, sampleRevision: shared.sampleRevision + 1 };
    await vi.advanceTimersByTimeAsync(1000); await flushPromises();
    expect(starts()).toHaveLength(1);
    expect(JSON.parse(String(starts()[0][1]?.body))).toMatchObject({ beatId: 'beat-1' });
  });

  it('does not start without a presenter, nor when one appears later', async () => {
    panel({ director: true, beatId: 'beat-1', autoPlayBeatId: 'beat-1' }); await flushPromises();
    await vi.advanceTimersByTimeAsync(3000); await flushPromises();
    expect(starts()).toHaveLength(0);
    withPresenter();
    await vi.advanceTimersByTimeAsync(3000); await flushPromises();
    expect(starts()).toHaveLength(0);
  });

  it('does not start when the prop is absent or names an older beat', async () => {
    withPresenter();
    panel({ director: true, beatId: 'beat-1' });
    panel({ director: true, beatId: 'beat-1', autoPlayBeatId: 'beat-0' });
    panel({ director: true, beatId: 'beat-1', autoPlayBeatId: null });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(3000); await flushPromises();
    expect(starts()).toHaveLength(0);
  });

  it('does not auto-play on the stage or in compact mode', async () => {
    withPresenter();
    panel({ director: false, stage: true, beatId: 'beat-1', autoPlayBeatId: 'beat-1' });
    panel({ director: false, compact: true, beatId: 'beat-1', autoPlayBeatId: 'beat-1' });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(3000); await flushPromises();
    expect(starts()).toHaveLength(0);
  });

  it('sends a single start across many polls', async () => {
    withPresenter();
    panel({ director: true, beatId: 'beat-1', autoPlayBeatId: 'beat-1' }); await flushPromises();
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(3000);
    await flushPromises();
    expect(starts()).toHaveLength(1);
  });

  it('keeps the stage presenter controls inside a closed Audio options fold', async () => {
    const wrapper = panel({ director: false, stage: true, beatId: 'beat-1' }); await flushPromises();
    const fold = wrapper.get('[data-testid="audio-options"]');
    expect(fold.element.tagName).toBe('DETAILS');
    expect(fold.attributes('open')).toBeUndefined();
    expect(fold.get('summary').text()).toBe('Audio options');
    expect(fold.find('[data-testid="present-audio"]').exists()).toBe(true);
  });

  it('points the director to Stream this show when no browser is playing', async () => {
    const wrapper = panel(); await flushPromises();
    expect(wrapper.text()).toContain('You will find it in Cast & lobby, under Stream this show.');
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

describe('show audio holder on the director controls', () => {
  const claimedAt = '2026-10-29T18:05:00.000Z';
  const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(claimedAt));
  const withPresenter = () => { shared.presenter = { available: true, leaseExpiresAtMs: 110_000 }; shared.sampleRevision++; };
  const holderCalls = () => requests('/playback/holder');
  const otherHolderId = '44444444-4444-4444-8444-444444444444';
  const obsHolder = (): HolderData => ({ holderId, label: 'Main show', showTitle: 'Night one', browser: 'obs', claimedAt });
  beforeEach(() => { vi.setSystemTime(new Date('2026-10-29T18:06:00.000Z')); });

  it('names an OBS holder with the time it took over', async () => {
    withPresenter(); holder = { holderId, label: 'Main show', showTitle: 'Night one', browser: 'obs', claimedAt };
    const wrapper = panel(); await flushPromises();
    expect(wrapper.get('[data-testid="audio-holder"]').text()).toBe(`\u201CMain show\u201D has the show audio, in OBS, since ${clock}.`);
    expect(wrapper.find('[data-testid="audio-holder-none"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="stop-holder"]').text()).toBe('Stop that one');
  });

  it('says a regular browser is not OBS and an unknown one is just a browser', async () => {
    withPresenter(); holder = { holderId, label: 'Mara link', showTitle: 'Night one', browser: 'browser', claimedAt };
    const wrapper = panel(); await flushPromises();
    expect(wrapper.get('[data-testid="audio-holder"]').text()).toBe(`\u201CMara link\u201D has the show audio, in a regular browser (not OBS), since ${clock}.`);
    holder = { holderId, label: 'A page opened before this update', showTitle: 'Night one', browser: 'unknown', claimedAt: null };
    shared.revision++; await vi.advanceTimersByTimeAsync(1000); await flushPromises();
    expect(wrapper.get('[data-testid="audio-holder"]').text()).toBe('\u201CA page opened before this update\u201D has the show audio, in a browser.');
  });

  it('posts the shown holder id on Stop that one, shows the stopped line and looks again', async () => {
    withPresenter(); holder = { holderId, label: 'Main show', showTitle: 'Night one', browser: 'obs', claimedAt };
    const wrapper = panel(); await flushPromises();
    const before = holderCalls().length;
    await click(wrapper, 'stop-holder');
    const stop = requests('/holder/stop');
    expect(stop).toHaveLength(1);
    expect(stop[0][1]).toMatchObject({ method: 'POST' });
    const sent = JSON.parse(String(stop[0][1]?.body));
    expect(sent).toMatchObject({ holderId });
    expect(typeof sent.commandId).toBe('string');
    expect(wrapper.get('[data-testid="audio-holder-stopped"]').text()).toBe("Stopped. A page with the show's link, such as your OBS, takes over within a few seconds. If narration was playing, press Resume shared audio.");
    expect(holderCalls().length).toBeGreaterThan(before);
    expect(wrapper.find('[data-testid="audio-holder"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="audio-holder-unknown"]').exists()).toBe(false);
  });

  it('shows the refusal when the stop is refused', async () => {
    withPresenter(); holder = { holderId, label: 'Main show', showTitle: 'Night one', browser: 'obs', claimedAt };
    stopRefusal = 'The show audio moved to another page. Check who has it now.';
    const wrapper = panel(); await flushPromises();
    await click(wrapper, 'stop-holder');
    expect(wrapper.get('[data-testid="audio-holder-error"]').text()).toBe(stopRefusal);
    expect(wrapper.find('[data-testid="audio-holder-stopped"]').exists()).toBe(false);
  });

  it('says plainly that nobody is playing the show audio', async () => {
    const wrapper = panel(); await flushPromises();
    const none = wrapper.get('[data-testid="audio-holder-none"]');
    expect(none.text()).toContain('Nobody is playing the show audio right now.');
    expect(none.text()).toContain('Load the main show link in OBS. You will find it in Cast & lobby, under Stream this show.');
    expect(wrapper.find('[data-testid="stop-holder"]').exists()).toBe(false);
  });

  it('never asks for the holder on the stage or the compact panel', async () => {
    withPresenter(); holder = { holderId, label: 'Main show', showTitle: 'Night one', browser: 'obs', claimedAt };
    const stage = panel({ director: true, stage: true, beatId: 'beat-1' });
    const seat = panel({ director: false, stage: true, beatId: 'beat-1' });
    const compact = panel({ director: false, compact: true, beatId: 'beat-1' });
    const player = panel({ director: false, beatId: 'beat-1' });
    await flushPromises(); await vi.advanceTimersByTimeAsync(3000); await flushPromises();
    expect(holderCalls()).toHaveLength(0);
    for (const wrapper of [stage, seat, compact, player]) expect(wrapper.find('[data-testid="audio-holder"]').exists()).toBe(false);
  });

  it('shows nothing new and raises no error when the holder look-up fails', async () => {
    withPresenter(); holderFails = true;
    const wrapper = panel(); await flushPromises();
    expect(holderCalls().length).toBeGreaterThan(0);
    expect(wrapper.find('[data-testid="audio-holder"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="stop-holder"]').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('shows a fallback line while the holder look-up is pending, and swaps it for the holder', async () => {
    withPresenter(); holder = obsHolder();
    let release: (value: Response) => void = () => {};
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => (String(input).endsWith('/playback/holder') ? pending : original(input, init)));
    const wrapper = panel(); await flushPromises();
    expect(wrapper.get('[data-testid="audio-holder-unknown"]').text()).toBe('Another page has the show audio.');
    expect(wrapper.find('[data-testid="audio-holder"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="audio-holder-none"]').exists()).toBe(false);
    release(response({ holder })); await flushPromises();
    expect(wrapper.find('[data-testid="audio-holder-unknown"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="audio-holder"]').exists()).toBe(true);
  });

  it('shows the fallback line when the holder look-up fails, and not when nobody has the audio', async () => {
    withPresenter(); holderFails = true;
    const failed = panel(); await flushPromises();
    expect(failed.get('[data-testid="audio-holder-unknown"]').text()).toBe('Another page has the show audio.');
    shared.presenter = { available: false, leaseExpiresAtMs: null }; shared.sampleRevision++;
    const nobody = panel(); await flushPromises();
    expect(nobody.find('[data-testid="audio-holder-unknown"]').exists()).toBe(false);
    expect(nobody.find('[data-testid="audio-holder-none"]').exists()).toBe(true);
  });

  describe('a refused stop', () => {
    async function refused() {
      withPresenter(); holder = obsHolder(); stopRefusal = 'The show audio moved to another page. Check who has it now.';
      const wrapper = panel(); await flushPromises();
      await click(wrapper, 'stop-holder');
      expect(wrapper.get('[data-testid="audio-holder-error"]').text()).toBe(stopRefusal);
      return wrapper;
    }
    const lookAgain = async () => { shared.revision++; await vi.advanceTimersByTimeAsync(1000); await flushPromises(); };

    it('stays while the same holder comes back', async () => {
      const wrapper = await refused();
      await lookAgain();
      expect(wrapper.find('[data-testid="audio-holder"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="audio-holder-error"]').exists()).toBe(true);
    });

    it('clears when a different holder comes back', async () => {
      const wrapper = await refused();
      holder = { ...obsHolder(), holderId: otherHolderId, label: 'Mara link' };
      await lookAgain();
      expect(wrapper.get('[data-testid="audio-holder"]').text()).toContain('Mara link');
      expect(wrapper.find('[data-testid="audio-holder-error"]').exists()).toBe(false);
    });

    it('clears when nobody holds the audio any more', async () => {
      const wrapper = await refused();
      holder = null;
      await lookAgain();
      expect(wrapper.find('[data-testid="audio-holder-error"]').exists()).toBe(false);
    });

    it('stays beside the page that took over, as the look-up right after the refusal shows it', async () => {
      withPresenter(); holder = obsHolder();
      const wrapper = panel(); await flushPromises();
      stopRefusal = 'The show audio moved to another page. Check who has it now.';
      holder = { ...obsHolder(), holderId: otherHolderId, label: 'Mara link' };
      await click(wrapper, 'stop-holder');
      expect(wrapper.get('[data-testid="audio-holder"]').text()).toContain('Mara link');
      expect(wrapper.get('[data-testid="audio-holder-error"]').text()).toBe(stopRefusal);
    });

    it('stays when a later look-up fails, and when the same holder then comes back', async () => {
      const wrapper = await refused();
      holderFails = true;
      await lookAgain();
      expect(wrapper.get('[data-testid="audio-holder-error"]').text()).toBe(stopRefusal!);
      expect(wrapper.get('[data-testid="audio-holder-unknown"]').text()).toBe('Another page has the show audio.');
      holderFails = false;
      await lookAgain();
      expect(wrapper.find('[data-testid="audio-holder"]').exists()).toBe(true);
      expect(wrapper.get('[data-testid="audio-holder-error"]').text()).toBe(stopRefusal!);
    });
  });

  it('adds the weekday and date when the claim was on an earlier day, and keeps the time only for today', async () => {
    withPresenter();
    const earlier = '2026-10-28T18:05:00.000Z';
    holder = { ...obsHolder(), claimedAt: earlier };
    const wrapper = panel(); await flushPromises();
    const expected = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(earlier));
    const text = wrapper.get('[data-testid="audio-holder"]').text();
    expect(text).toBe(`\u201CMain show\u201D has the show audio, in OBS, since ${expected}.`);
    expect(expected).toMatch(/^[A-Z][a-z]{2}/);
    expect(text).not.toContain(`since ${clock}.`);
    holder = obsHolder();
    shared.revision++; await vi.advanceTimersByTimeAsync(1000); await flushPromises();
    expect(wrapper.get('[data-testid="audio-holder"]').text()).toBe(`\u201CMain show\u201D has the show audio, in OBS, since ${clock}.`);
  });

  it('adds no timers of its own', async () => {
    withPresenter(); holder = { holderId, label: 'Main show', showTitle: 'Night one', browser: 'obs', claimedAt };
    const wrapper = panel(); await flushPromises();
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
