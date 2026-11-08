// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectorSnapshot } from '@rpg/contracts';

const transport = vi.hoisted(() => ({ playback: vi.fn(), showAudioHolder: vi.fn(), releasePicture: vi.fn() }));
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
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); transport.playback.mockReset(); transport.releasePicture.mockReset(); transport.showAudioHolder.mockReset(); transport.showAudioHolder.mockResolvedValue({ holder: null }); transport.releasePicture.mockResolvedValue({ ok: true }); transport.playback.mockResolvedValue(playback(true)); });
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
    expect(wrapper.find('ul').attributes('aria-label')).toBe('Show status');
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

  it('shows the pinned line with Release only while a picture is pinned', async () => {
    const plain = mountStrip();
    await flushPromises();
    expect(plain.find('[data-testid="pinned-line"]').exists()).toBe(false);
    plain.unmount();
    const wrapper = mountStrip({ pinnedPicture: { imageId: 'i', kind: 'beat', label: 'Beat 3' } });
    await flushPromises();
    expect(wrapper.get('[data-testid="pinned-line"]').text()).toContain('Pinned: Beat 3');
    await wrapper.get('[data-testid="release-pinned"]').trigger('click');
    await flushPromises();
    expect(transport.releasePicture).toHaveBeenCalledWith('show one');
    wrapper.unmount();
  });

  it('shows a refused release inline', async () => {
    transport.releasePicture.mockRejectedValue(new Error('No picture is pinned right now.'));
    const wrapper = mountStrip({ pinnedPicture: { imageId: 'i', kind: 'beat', label: 'Beat 3' } });
    await flushPromises();
    await wrapper.get('[data-testid="release-pinned"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="release-error"]').text()).toBe('No picture is pinned right now.');
    expect(wrapper.get('[data-testid="release-pinned"]').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  describe('auto-resume chip', () => {
    const holder = (patch: Record<string, unknown> = {}) => ({ holderId: '11111111-1111-4111-8111-111111111111', label: 'Stream PC', showTitle: 'Show', browser: 'obs', claimedAt: '2026-10-28T19:59:00.000Z', ...patch });
    const time = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const at = '2026-10-28T20:00:00.000Z';

    it('names an OBS holder that resumed narration', async () => {
      transport.showAudioHolder.mockResolvedValue({ holder: holder({ resumedAt: at }) });
      const wrapper = mountStrip();
      await flushPromises();
      expect(wrapper.get('[data-testid="auto-resumed"]').text()).toContain(`Narration resumed by itself on Stream PC (OBS) at ${time(at)}.`);
      wrapper.unmount();
    });

    it('names a browser holder', async () => {
      transport.showAudioHolder.mockResolvedValue({ holder: holder({ browser: 'browser', label: 'Laptop', resumedAt: at }) });
      const wrapper = mountStrip();
      await flushPromises();
      expect(wrapper.get('[data-testid="auto-resumed"]').text()).toContain(`on Laptop (a browser) at ${time(at)}.`);
      wrapper.unmount();
    });

    it('says a page for an unknown holder', async () => {
      transport.showAudioHolder.mockResolvedValue({ holder: holder({ browser: 'unknown', resumedAt: at }) });
      const wrapper = mountStrip();
      await flushPromises();
      expect(wrapper.get('[data-testid="auto-resumed"]').text()).toContain('(a page)');
      wrapper.unmount();
    });

    it('shows nothing without resumedAt or without a holder', async () => {
      transport.showAudioHolder.mockResolvedValue({ holder: holder() });
      const wrapper = mountStrip();
      await flushPromises();
      expect(wrapper.find('[data-testid="auto-resumed"]').exists()).toBe(false);
      expect(wrapper.find('.status-strip').exists()).toBe(false);
      transport.showAudioHolder.mockResolvedValue({ holder: null });
      await vi.advanceTimersByTimeAsync(5000);
      expect(wrapper.find('[data-testid="auto-resumed"]').exists()).toBe(false);
      wrapper.unmount();
    });

    it('hides on Dismiss and shows again for a newer resumedAt', async () => {
      transport.showAudioHolder.mockResolvedValue({ holder: holder({ resumedAt: at }) });
      const wrapper = mountStrip();
      await flushPromises();
      await wrapper.get('[data-testid="auto-resumed-dismiss"]').trigger('click');
      expect(wrapper.find('[data-testid="auto-resumed"]').exists()).toBe(false);
      await vi.advanceTimersByTimeAsync(5000);
      expect(wrapper.find('[data-testid="auto-resumed"]').exists()).toBe(false);
      transport.showAudioHolder.mockResolvedValue({ holder: holder({ resumedAt: '2026-10-28T20:10:00.000Z' }) });
      await vi.advanceTimersByTimeAsync(5000);
      expect(wrapper.find('[data-testid="auto-resumed"]').exists()).toBe(true);
      wrapper.unmount();
    });

    it('keeps the other chips and the last good answer when the holder call fails', async () => {
      transport.playback.mockResolvedValue(playback(false));
      transport.showAudioHolder.mockResolvedValue({ holder: holder({ resumedAt: at }) });
      const wrapper = mountStrip();
      await flushPromises();
      transport.showAudioHolder.mockRejectedValue(new Error('offline'));
      await vi.advanceTimersByTimeAsync(5000);
      expect(wrapper.find('[data-testid="warning-no-audio"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="warning-audio-unknown"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="auto-resumed"]').exists()).toBe(true);
      wrapper.unmount();
    });
  });

  describe('downed characters', () => {
    const chars = [
      { id: 'c1', displayName: 'Scrot', condition: 'down' },
      { id: 'c2', displayName: 'Mira' },
      { id: 'c3', displayName: 'Old Pete', condition: 'dead' },
      { id: 'c4', displayName: 'Vee', condition: 'down' },
    ];
    const lc = (id: string, band: string, total: number) => ({ id: `last-chance:${id}`, actorCharacterId: id, lastChance: true, faces: [3, 4], total, band });
    const beat = (phase: string, resolution: unknown = null) => ({ id: 'beat', phase, resolution });

    it('says the window is open while the round takes lines or shows stakes', async () => {
      for (const phase of ['collecting', 'stakes_review']) {
        const wrapper = mountStrip({ characters: chars.slice(0, 2), activeBeat: beat(phase) });
        await flushPromises();
        expect(wrapper.get('[data-testid="condition-c1"]').text()).toBe("Scrot is down. Someone can save Scrot in this round. If nobody does, Scrot gets a last-chance roll when this round's dice are rolled.");
        wrapper.unmount();
      }
    });

    it('says the window closes at the next round when there is no round', async () => {
      const wrapper = mountStrip({ characters: chars.slice(0, 2) });
      await flushPromises();
      expect(wrapper.get('[data-testid="condition-c1"]').text()).toBe("Scrot is down. Someone can save Scrot in the next round. If nobody does, Scrot gets a last-chance roll when that round's dice are rolled.");
      expect(wrapper.find('.status-strip').exists()).toBe(true);
      wrapper.unmount();
    });

    it('says how a rolled last chance lands', async () => {
      const resolution = { rolls: [lc('c1', 'costly', 8), lc('c4', 'setback', 4)], outcomes: [], effects: [] };
      const wrapper = mountStrip({ characters: chars, activeBeat: beat('locked', resolution) });
      await flushPromises();
      expect(wrapper.get('[data-testid="condition-c1"]').text()).toBe("Scrot's last chance rolled 8: Scrot pulls through at 7 of 8 when you publish.");
      expect(wrapper.get('[data-testid="condition-c4"]').text()).toBe("Vee's last chance rolled 4: Vee dies when you publish.");
      wrapper.unmount();
    });

    it('says a rescue lands, and a beat with no dice leaves the window open', async () => {
      const rescued = mountStrip({ characters: chars.slice(0, 2), activeBeat: beat('draft_review', { rolls: [], outcomes: [], effects: [{ kind: 'character_rescue', characterId: 'c1' }] }) });
      await flushPromises();
      expect(rescued.get('[data-testid="condition-c1"]').text()).toBe('Scrot is saved when you publish and comes back up at 6 of 8.');
      rescued.unmount();
      const quiet = mountStrip({ characters: chars.slice(0, 2), activeBeat: beat('locked', { rolls: [], outcomes: [], effects: [] }) });
      await flushPromises();
      expect(quiet.get('[data-testid="condition-c1"]').text()).toBe('Scrot is down. This beat has no dice, so someone can still save Scrot in the next round.');
      quiet.unmount();
    });

    it('shows two downed characters at once and none for up or dead ones', async () => {
      const wrapper = mountStrip({ characters: chars });
      await flushPromises();
      expect(wrapper.findAll('[data-testid^="condition-"]').map(item => item.attributes('data-testid'))).toEqual(['condition-c1', 'condition-c4']);
      wrapper.unmount();
      const none = mountStrip({ characters: [chars[1], chars[2]] });
      await flushPromises();
      expect(none.find('.status-strip').exists()).toBe(false);
      none.unmount();
    });
  });
});
