// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectorSnapshot } from '@rpg/contracts';

const transport = vi.hoisted(() => ({ playback: vi.fn() }));
vi.mock('./api', () => ({ api: transport }));

import DirectorStatusStrip from './DirectorStatusStrip.vue';

const NOW = Date.parse('2026-10-28T20:00:00Z');
const job = (id: string, status: string, beatId = 'beat') => ({ id, beatId, task: 'render', generation: 1, status, error: null });
const active = { id: 'beat', phase: 'collecting' };

function snapshot(patch: Record<string, unknown> = {}) {
  return { role: 'director', session: { status: 'live' }, history: [], submissions: [], jobs: [], activeBeat: null, ...patch } as unknown as DirectorSnapshot;
}
const playback = (available: boolean) => ({ presenter: { available, leaseExpiresAtMs: null } });
const mountStrip = (patch: Record<string, unknown> = {}) => mount(DirectorStatusStrip, { props: { snapshot: snapshot(patch), sessionId: 'show one' } });
const audioEvents = (wrapper: ReturnType<typeof mountStrip>) => (wrapper.emitted('audio') ?? []).map(args => args[0]);

describe('DirectorStatusStrip', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); transport.playback.mockReset(); transport.playback.mockResolvedValue(playback(true)); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders nothing when all is well', async () => {
    const wrapper = mountStrip();
    await flushPromises();
    expect(wrapper.find('.status-strip').exists()).toBe(false);
    expect(wrapper.text()).toBe('');
    wrapper.unmount();
  });

  it('warns with a link to Stream this show when nobody presents, and follows the five second poll', async () => {
    transport.playback.mockResolvedValue(playback(false));
    const wrapper = mountStrip();
    await flushPromises();
    expect(wrapper.find('ul').attributes('aria-label')).toBe('Show warnings');
    expect(wrapper.get('[data-testid="warning-no-audio"]').text()).toContain('No show audio');
    expect(wrapper.find('a').text()).toBe('Stream this show');
    expect(wrapper.find('a').attributes('href')).toContain('/sessions/show%20one/lobby#stage-links');
    transport.playback.mockResolvedValue(playback(true));
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.playback).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="warning-no-audio"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("warns when the show audio can't be checked", async () => {
    transport.playback.mockRejectedValue(new Error('offline'));
    const wrapper = mountStrip();
    await flushPromises();
    expect(wrapper.get('[data-testid="warning-audio-unknown"]').text()).toBe("Can't check the show audio");
    wrapper.unmount();
  });

  it('emits audio after the first poll and on every change only', async () => {
    const wrapper = mountStrip();
    await flushPromises();
    expect(audioEvents(wrapper)).toEqual(['presenting']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(audioEvents(wrapper)).toEqual(['presenting']);
    transport.playback.mockResolvedValue(playback(false));
    await vi.advanceTimersByTimeAsync(5000);
    transport.playback.mockRejectedValue(new Error('offline'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(audioEvents(wrapper)).toEqual(['presenting', 'none', 'unknown']);
    wrapper.unmount();
  });

  it('shows the stuck warning only after a job of the active beat has been seen for over 60 seconds', async () => {
    const wrapper = mountStrip({ activeBeat: active, jobs: [job('j1', 'running')] });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(59000);
    expect(wrapper.find('[data-testid="warning-stuck"]').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(wrapper.get('[data-testid="warning-stuck"]').text()).toBe('The AI is taking longer than usual (61 s)');
    wrapper.unmount();
  });

  it('ignores finished jobs and jobs of other beats', async () => {
    const wrapper = mountStrip({ activeBeat: active, jobs: [job('a', 'succeeded'), job('b', 'running', 'other')] });
    await flushPromises();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(90000);
    expect(wrapper.find('[data-testid="warning-stuck"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('starts the clock for a new job later, counting from when it was first seen', async () => {
    const wrapper = mountStrip({ activeBeat: active });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(100000);
    await wrapper.setProps({ snapshot: snapshot({ activeBeat: active, jobs: [job('late', 'queued')] }) });
    expect(wrapper.find('[data-testid="warning-stuck"]').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(61000);
    expect(wrapper.find('[data-testid="warning-stuck"]').exists()).toBe(true);
    await wrapper.setProps({ snapshot: snapshot({ activeBeat: active, jobs: [job('late', 'succeeded')] }) });
    expect(wrapper.find('[data-testid="warning-stuck"]').exists()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    wrapper.unmount();
  });

  it('ticks a clock only while a job is waiting or running', async () => {
    const idle = mountStrip();
    await flushPromises();
    expect(vi.getTimerCount()).toBe(1);
    idle.unmount();
    const busy = mountStrip({ activeBeat: active, jobs: [job('j', 'queued')] });
    await flushPromises();
    expect(vi.getTimerCount()).toBe(2);
    busy.unmount();
  });

  it('clears every timer when it unmounts', async () => {
    const wrapper = mountStrip({ activeBeat: active, jobs: [job('j', 'running')] });
    await flushPromises();
    expect(vi.getTimerCount()).toBe(2);
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(transport.playback).toHaveBeenCalledTimes(1);
  });
});
