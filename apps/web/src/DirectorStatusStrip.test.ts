// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectorSnapshot } from '@rpg/contracts';

const transport = vi.hoisted(() => ({ playback: vi.fn() }));
vi.mock('./api', () => ({ api: transport }));

import DirectorStatusStrip from './DirectorStatusStrip.vue';

const NOW = Date.parse('2026-10-28T20:00:00Z');
const submission = (id: string, kind: 'say' | 'act' | 'ooc', status = 'queued') => ({ id, sessionId: 's', characterId: 'c', contextBeatId: null, inputEpoch: 0, revision: 1, kind, text: 'x', recipientNpcIds: [], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: true, status });

function snapshot(patch: Record<string, unknown> = {}) {
  return { role: 'director', session: { status: 'live' }, history: [], submissions: [], jobs: [], activeBeat: null, ...patch } as unknown as DirectorSnapshot;
}
const playback = (available: boolean, source?: 'show_link' | 'preview' | null) => ({ presenter: { available, leaseExpiresAtMs: null, ...(source === undefined ? {} : { source }) } });
const mountStrip = (patch: Record<string, unknown> = {}) => mount(DirectorStatusStrip, { props: { snapshot: snapshot(patch), sessionId: 'show one' } });

describe('DirectorStatusStrip', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); transport.playback.mockReset(); transport.playback.mockResolvedValue(playback(true)); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([['live', 'Live'], ['paused', 'Paused'], ['lobby', 'Lobby'], ['ended', 'Ended']])('names the %s state in words', async (status, text) => {
    const wrapper = mountStrip({ session: { status } });
    await flushPromises();
    expect(wrapper.text()).toContain(text);
    wrapper.unmount();
  });

  it('counts lines and questions separately, ignoring locked and published input', async () => {
    const wrapper = mountStrip({ submissions: [submission('a', 'say'), submission('b', 'act', 'selected'), submission('c', 'ooc'), submission('d', 'say', 'locked'), submission('e', 'say', 'published')] });
    await flushPromises();
    expect(wrapper.text()).toContain('Queue: 2 lines · 1 question');
    wrapper.unmount();
  });

  it('shows presenting audio without a setup link', async () => {
    const wrapper = mountStrip();
    await flushPromises();
    expect(wrapper.text()).toContain('Stage audio: presenting');
    expect(wrapper.find('a').exists()).toBe(false);
    wrapper.unmount();
  });

  it('names the OBS show link as the presenter', async () => {
    transport.playback.mockResolvedValue(playback(true, 'show_link'));
    const wrapper = mountStrip();
    await flushPromises();
    expect(wrapper.text()).toContain('Stage audio: OBS show link');
    expect(wrapper.find('a').exists()).toBe(false);
    wrapper.unmount();
  });

  it('names a stage preview tab as the presenter', async () => {
    transport.playback.mockResolvedValue(playback(true, 'preview'));
    const wrapper = mountStrip();
    await flushPromises();
    expect(wrapper.text()).toContain('Stage audio: a stage preview tab');
    expect(wrapper.find('a').exists()).toBe(false);
    wrapper.unmount();
  });

  it('links to the stage and OBS links when nobody presents, and follows the five second poll', async () => {
    transport.playback.mockResolvedValue(playback(false));
    const wrapper = mountStrip();
    await flushPromises();
    expect(wrapper.text()).toContain('Stage audio: no presenter');
    expect(wrapper.find('a').text()).toBe('Set up stage audio');
    expect(wrapper.find('a').attributes('href')).toContain('/sessions/show%20one/lobby#stage-links');
    transport.playback.mockResolvedValue(playback(true));
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.playback).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain('Stage audio: presenting');
    wrapper.unmount();
  });

  it('reports unknown stage audio when the lookup fails', async () => {
    transport.playback.mockRejectedValue(new Error('offline'));
    const wrapper = mountStrip();
    await flushPromises();
    expect(wrapper.text()).toContain('Stage audio: unknown');
    wrapper.unmount();
  });

  it('shows the last publish and refreshes it every 30 seconds', async () => {
    const wrapper = mountStrip({ history: [{ id: 'b', publishedAt: new Date(NOW - 3 * 60000).toISOString() }] });
    await flushPromises();
    expect(wrapper.text()).toContain('Last publish: 3 min ago');
    await vi.advanceTimersByTimeAsync(60000);
    expect(wrapper.text()).toContain('Last publish: 4 min ago');
    wrapper.unmount();
  });

  it('says so when nothing has been published', async () => {
    const wrapper = mountStrip();
    await flushPromises();
    expect(wrapper.text()).toContain('Nothing published yet');
    wrapper.unmount();
  });

  it('shows the AI chip only while a job for the active beat is waiting or running', async () => {
    const job = (task: string, status: string, beatId = 'beat') => ({ id: `${task}${status}${beatId}`, beatId, task, generation: 1, status, error: null });
    const active = { id: 'beat', phase: 'collecting' };
    const planning = mountStrip({ activeBeat: active, jobs: [job('plan', 'running')] });
    const drafting = mountStrip({ activeBeat: active, jobs: [job('render', 'queued')] });
    const idle = mountStrip({ activeBeat: active, jobs: [job('plan', 'succeeded'), job('render', 'running', 'other')] });
    await flushPromises();
    expect(planning.text()).toContain('AI: planning…');
    expect(drafting.text()).toContain('AI: drafting…');
    expect(idle.text()).not.toContain('AI:');
    for (const wrapper of [planning, drafting, idle]) wrapper.unmount();
  });

  it('uses no audio-panel or status classes', async () => {
    const wrapper = mountStrip();
    await flushPromises();
    expect(wrapper.find('.audio-panel').exists()).toBe(false);
    expect(wrapper.find('.status').exists()).toBe(false);
    wrapper.unmount();
  });

  it('clears both timers when it unmounts', async () => {
    const wrapper = mountStrip();
    await flushPromises();
    expect(vi.getTimerCount()).toBe(2);
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(transport.playback).toHaveBeenCalledTimes(1);
  });
});
