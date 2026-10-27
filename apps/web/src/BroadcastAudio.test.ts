// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, reactive } from 'vue';
import type { SessionSnapshot } from '@rpg/contracts';
import BroadcastAudio from './BroadcastAudio.vue';
import StageView from './StageView.vue';
import { createTable, provideTable } from './table';

const mocks = vi.hoisted(() => ({ controllers: [] as any[], create: vi.fn() }));
vi.mock('./playback', () => ({ createPlaybackController: mocks.create }));
vi.mock('./api', () => ({ api: { snapshot: vi.fn() }, subscribeToSession: vi.fn(() => () => {}) }));

function fakeController(context: unknown) {
  const controller = {
    context,
    state: reactive({ snapshot: null as any, manifest: null, audioStatus: 'missing', preparing: false, commandPending: false, listening: false, presenting: false, muted: true, volume: 1, error: '' }),
    claim: vi.fn(async () => {}), listen: vi.fn(), release: vi.fn(async () => {}), mute: vi.fn(), setVolume: vi.fn(), command: vi.fn(), replay: vi.fn(), prepare: vi.fn(),
    refresh: vi.fn(), setContext: vi.fn(), dispose: vi.fn(),
  };
  mocks.controllers.push(controller);
  return controller;
}

const manifest = { beatId: 'beat-1', segments: [{ id: 'one', text: 'Hello.', speaker: 'Narrator', voiceProfileId: 'n', url: '/x' }, { id: 'two', text: 'Hi.', speaker: 'Mara', voiceProfileId: 'm', url: '/y' }] };
const playback = (extra: Record<string, unknown> = {}) => ({ presenter: { available: false, leaseExpiresAtMs: null }, status: 'idle', segmentIndex: null, manifest: null, ...extra });
const mountAudio = (mode: 'present' | 'listen' | 'off', beatId = 'beat-1') => mount(BroadcastAudio, { props: { sessionId: 'show', beatId, mode } });

beforeEach(() => {
  mocks.controllers.length = 0;
  mocks.create.mockReset();
  mocks.create.mockImplementation(fakeController);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; delete (window as any).obsstudio; window.history.replaceState({}, '', '/'); });

describe('BroadcastAudio', () => {
  it('claims the presenter slot every 3 seconds only while it is free', async () => {
    const wrapper = mountAudio('present');
    const [controller] = mocks.controllers;
    expect(mocks.create).toHaveBeenCalledWith({ sessionId: 'show', beatId: 'beat-1', director: false, stage: true });
    await vi.advanceTimersByTimeAsync(3000);
    expect(controller.claim).not.toHaveBeenCalled();
    controller.state.snapshot = playback();
    await vi.advanceTimersByTimeAsync(3000);
    expect(controller.claim).toHaveBeenCalledTimes(1);
    controller.state.snapshot = playback({ presenter: { available: true, leaseExpiresAtMs: 1 } });
    await vi.advanceTimersByTimeAsync(6000);
    expect(controller.claim).toHaveBeenCalledTimes(1);
    controller.state.snapshot = playback();
    controller.state.presenting = true;
    await vi.advanceTimersByTimeAsync(6000);
    expect(controller.claim).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('listens once a snapshot exists and again while not listening', async () => {
    const wrapper = mountAudio('listen');
    const [controller] = mocks.controllers;
    expect(mocks.create).toHaveBeenCalledWith({ sessionId: 'show', beatId: 'beat-1', director: false, stage: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(controller.listen).not.toHaveBeenCalled();
    controller.state.snapshot = playback();
    await vi.advanceTimersByTimeAsync(5000);
    expect(controller.listen).toHaveBeenCalledTimes(1);
    controller.state.listening = true;
    await vi.advanceTimersByTimeAsync(10000);
    expect(controller.listen).toHaveBeenCalledTimes(1);
    controller.state.listening = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(controller.listen).toHaveBeenCalledTimes(2);
    expect(controller.claim).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('creates no controller when off', async () => {
    const wrapper = mountAudio('off');
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="broadcast-audio"]').attributes('data-state')).toBe('off');
    wrapper.unmount();
  });

  it('passes a new beat to the controller and disposes it on unmount, stopping the timers', async () => {
    const wrapper = mountAudio('present');
    const [controller] = mocks.controllers;
    await wrapper.setProps({ beatId: 'beat-2' });
    expect(controller.setContext).toHaveBeenCalledWith({ sessionId: 'show', beatId: 'beat-2', director: false, stage: true });
    wrapper.unmount();
    expect(controller.dispose).toHaveBeenCalledTimes(1);
    controller.state.snapshot = playback();
    await vi.advanceTimersByTimeAsync(9000);
    expect(controller.claim).not.toHaveBeenCalled();
  });

  it('emits status and the playing segment id, and never renders anything visible', async () => {
    const wrapper = mountAudio('present');
    const [controller] = mocks.controllers;
    controller.state.snapshot = playback({ status: 'playing', segmentIndex: 1, manifest });
    await nextTick();
    expect(wrapper.emitted('segment')?.at(-1)).toEqual(['two']);
    controller.state.snapshot = playback({ status: 'paused', segmentIndex: 1, manifest });
    await nextTick();
    expect(wrapper.emitted('segment')?.at(-1)).toEqual([null]);
    controller.state.presenting = true;
    controller.state.error = 'Presenter lease was lost.';
    await nextTick();
    expect(wrapper.emitted('status')?.at(-1)).toEqual([{ presenting: true, listening: false, error: 'Presenter lease was lost.' }]);
    expect(wrapper.element.hasAttribute('hidden')).toBe(true);
    expect(wrapper.text()).toBe('');
    expect(wrapper.html()).not.toContain('lease was lost');
    wrapper.unmount();
  });
});

function stageSnapshot(): SessionSnapshot {
  return {
    schemaVersion: 1, role: 'stage', eventSeq: 0,
    session: { id: 'show', title: 'The Ledger Job', status: 'live', mode: 'conversation', stateRevision: 0, beatNumber: 1, actionRoundNumber: 0, inputEpoch: 0, scene: { id: 'bar', title: 'The Velvet Static', description: 'Find the missing ledger.', locationId: 'bar' } },
    characters: [], npcs: [], tracks: [], facts: [], activeBeat: null, corrections: [],
    history: [{ id: 'beat-1', kind: 'conversation', beatNumber: 1, actionRoundNumber: 0, stateRevision: 0, publishedAt: '2026-10-28T20:00:00.000Z', segments: [{ id: 'line-1', kind: 'npc_dialogue', speaker: { entityId: 'mara', displayName: 'Mara Vale' }, text: 'Tell me why.', recipientCharacterIds: [], delivery: 'neutral', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: true }], rolls: [], outcomes: [], textOnly: true }],
  } as unknown as SessionSnapshot;
}

function mountView(withSnapshot = true) {
  window.history.replaceState({}, '', '/sessions/show/stage');
  const table = createTable();
  if (withSnapshot) table.snapshot.value = stageSnapshot();
  const Host = defineComponent({ setup() { provideTable(table); return () => h(StageView); } });
  return { wrapper: mount(Host), table };
}

describe('StageView', () => {
  it('shows exactly one audio panel and no broadcast audio outside OBS', async () => {
    const { wrapper } = mountView();
    await flushPromises();
    expect(wrapper.findAll('.audio-panel')).toHaveLength(1);
    expect(wrapper.find('[data-testid="broadcast-audio"]').exists()).toBe(false);
    expect(wrapper.find('.stage-frame').exists()).toBe(true);
    expect(wrapper.get('[data-testid="preview-strip"]').text()).toContain('Preview only, not for OBS. For OBS, use a link from Stream this show.');
    expect(wrapper.find('.stage-frame button, .stage-frame input, .stage-frame select, .stage-frame img').exists()).toBe(false);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ stage: true, director: false }));
    wrapper.unmount();
  });

  it('shows broadcast audio, no operator bar and no audio panel inside OBS', async () => {
    (window as any).obsstudio = {};
    const { wrapper } = mountView();
    await flushPromises();
    expect(wrapper.find('[data-testid="broadcast-audio"]').exists()).toBe(true);
    expect(wrapper.find('.audio-panel').exists()).toBe(false);
    expect(wrapper.find('.operator-bar').exists()).toBe(false);
    expect(wrapper.find('[data-testid="preview-strip"]').exists()).toBe(false);
    expect(mocks.create).toHaveBeenCalledWith({ sessionId: 'show', beatId: 'beat-1', director: false, stage: true });
    wrapper.unmount();
  });

  it('marks the playing line as speaking through the active segment id', async () => {
    (window as any).obsstudio = {};
    const { wrapper } = mountView();
    await flushPromises();
    mocks.controllers[0].state.snapshot = playback({ status: 'playing', segmentIndex: 0, manifest: { beatId: 'beat-1', segments: [{ id: 'line-1', text: 'Tell me why.', speaker: 'Mara Vale', voiceProfileId: 'm', url: '/x' }] } });
    await nextTick(); await nextTick();
    expect(wrapper.find('.speaking').exists()).toBe(true);
    wrapper.unmount();
  });

  it('shows the offline slate inside the frame before a snapshot exists', async () => {
    const { wrapper } = mountView(false);
    expect(wrapper.find('.stage-frame').exists()).toBe(true);
    expect(wrapper.text()).toContain('The story continues shortly');
    wrapper.unmount();
  });

  it('shows a table error as plain text in the operator bar only', async () => {
    const { wrapper, table } = mountView();
    table.error.value = 'Could not load <b>x</b>';
    await nextTick();
    expect(wrapper.get('.operator-bar').text()).toContain('Could not load <b>x</b>');
    expect(wrapper.find('.stage-frame').text()).not.toContain('Could not load');
    wrapper.unmount();
  });
});
