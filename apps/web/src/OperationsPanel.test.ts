// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionOperations } from '@rpg/contracts';
import OperationsPanel from './OperationsPanel.vue';

const endpoint = '/api/sessions/show/operations';
const sample = (): SessionOperations => ({
  sessionId: 'show', sampledAt: '2026-10-22T11:00:10.000Z', lastSavedAt: '2026-10-22T11:00:00.000Z',
  limits: { ai: 'unlimited', speech: 'unlimited' },
  progress: [{ id: 'render-one', beatId: 'beat-one', kind: 'render', status: 'running', startedAt: '2026-10-22T11:00:00.000Z', finishedAt: null, completedSegments: null, totalSegments: null }],
  speech: { configured: true, draft: { beatId: 'beat-one', status: 'preparing', completedSegments: 1, totalSegments: 3 }, published: null },
  failures: [],
  usage: {
    since: '2026-10-22T10:00:00.000Z', partial: false,
    ai: { attempts: 7, succeeded: 2, failed: 1, pending: 3, interrupted: 1 },
    speech: { attempts: 2, succeeded: 1, failed: 0, pending: 1, interrupted: 0, characters: 125, cacheHits: 4, sharedHits: 2 },
    inputTokens: null, outputTokens: null, costUsd: null,
  },
});
const response = (data: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data }) as Response;
const wrappers: ReturnType<typeof mount>[] = [];
function panel(sessionId = 'show') {
  const wrapper = mount(OperationsPanel, { props: { sessionId } }); wrappers.push(wrapper); return wrapper;
}
const field = (id: string) => `[data-testid="${id}"]`;

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T12:00:00.000Z'));
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response(sample())));
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('director session status and usage', () => {
  it('loads only the private read endpoint with the selected identity and no cached response', async () => {
    const identity = 'a'.repeat(32);
    window.history.replaceState({}, '', `/sessions/show/director?identity=${identity}`);
    const wrapper = panel(); await flushPromises();
    expect(fetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', headers: { 'X-RPG-Identity': identity } }));
    expect(wrapper.findAll('button')).toHaveLength(0);
    expect(wrapper.find('[role="status"], output').exists()).toBe(false);
    expect(wrapper.emitted()).toEqual({});
  });

  it('shows unlimited limits, recorded attempts, coverage and unavailable billing fields honestly', async () => {
    const wrapper = panel(); await flushPromises();
    expect(wrapper.text()).not.toContain('Limits: Unlimited');
    expect(wrapper.get('summary').text()).toContain('Recorded usage');
    expect(wrapper.get(field('ai-attempts')).text()).toBe('7');
    expect(wrapper.get(field('speech-attempts')).text()).toBe('2');
    expect(wrapper.text()).toContain('Tokens and cost: Not reported');
    expect(wrapper.text()).toMatch(/field, library and character drafts are excluded/i);
    expect(wrapper.text()).toMatch(/not.*billing/i);
    expect(wrapper.get('time[data-testid="usage-since"]').attributes('datetime')).toBe(sample().usage.since);
    expect(wrapper.get('time[data-testid="last-saved"]').attributes('datetime')).toBe(sample().lastSavedAt);
    expect(wrapper.text()).toContain('Last saved session change');
    expect(wrapper.text()).not.toMatch(/\$|\d%/);
  });

  it('uses server sampling time for elapsed work and freezes completed durations', async () => {
    const value = sample();
    value.progress.push({ ...value.progress[0]!, id: 'plan-one', kind: 'plan', status: 'succeeded', finishedAt: '2026-10-22T11:00:03.000Z' });
    vi.mocked(fetch).mockResolvedValueOnce(response(value));
    const wrapper = panel(); await flushPromises();
    expect(wrapper.get(field('progress-render-one')).text()).toMatch(/Drafting the script.*10s/s);
    expect(wrapper.get(field('progress-plan-one')).text()).toMatch(/3s/);
    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.get(field('progress-render-one')).text()).toMatch(/11s/);
    expect(wrapper.get(field('progress-plan-one')).text()).toMatch(/3s/);
  });

  it.each([-3_600_000, 3_600_000])('keeps elapsed time monotonic after the local clock shifts by %s milliseconds', async shift => {
    const wrapper = panel(); await flushPromises();
    vi.setSystemTime(Date.now() + shift);
    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.get(field('progress-render-one')).text()).toMatch(/Elapsed 11s/);
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Unavailable'));
    await vi.advanceTimersByTimeAsync(1000); await flushPromises();
    expect(wrapper.get(field('operations-update')).text()).toMatch(/last successful update/i);
    const frozen = wrapper.get(field('progress-render-one')).text();
    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.get(field('progress-render-one')).text()).toBe(frozen);
  });

  it('shows observed clip readiness without assigning a percentage to artificial intelligence work', async () => {
    const value = sample();
    value.progress.push({ ...value.progress[0]!, id: 'audio-one', kind: 'draft_audio', completedSegments: 1, totalSegments: 3 });
    vi.mocked(fetch).mockResolvedValueOnce(response(value));
    const wrapper = panel(); await flushPromises();
    expect(wrapper.get(field('progress-audio-one')).text()).toContain('1 of 3 clips ready');
    expect(wrapper.get(field('draft-readiness')).text()).toContain('1 of 3 clips ready');
    expect(wrapper.get(field('progress-render-one')).text()).not.toMatch(/%|clips/);
    expect(wrapper.find('progress, [role="progressbar"]').exists()).toBe(false);
  });

  it('keeps readiness and zero usage honest when speech is not configured and no work exists', async () => {
    const value = sample(); value.progress = []; value.lastSavedAt = null;
    value.speech = { configured: false, draft: null, published: null };
    value.usage.ai = { attempts: 0, succeeded: 0, failed: 0, pending: 0, interrupted: 0 };
    vi.mocked(fetch).mockResolvedValueOnce(response(value));
    const wrapper = panel(); await flushPromises();
    expect(wrapper.text()).toContain('No preparation is running');
    expect(wrapper.text()).toContain('Speech is not configured');
    expect(wrapper.text()).toContain('No saved session change recorded');
    expect(wrapper.get(field('ai-attempts')).text()).toBe('0');
    expect(wrapper.text()).not.toMatch(/100%|complete session history/i);
  });

  it('marks partial records and treats interrupted outcomes as unknown completion', async () => {
    const value = sample(); value.usage.partial = true;
    vi.mocked(fetch).mockResolvedValueOnce(response(value));
    const wrapper = panel(); await flushPromises();
    expect(wrapper.get(field('usage-partial')).text()).toMatch(/incomplete/i);
    expect(wrapper.text()).toMatch(/completion unknown/i);
    expect(wrapper.text()).toContain('Cache reuse');
    expect(wrapper.text()).toContain('Shared preparation reuse');
  });

  it('keeps incomplete totals and recent failures visible while usage details are collapsed', async () => {
    const value = sample(); value.usage.partial = true;
    value.failures = [{ id: 'failed-one', kind: 'speech', occurredAt: value.sampledAt, message: 'Speech could not be prepared.' }];
    vi.mocked(fetch).mockResolvedValueOnce(response(value));
    const wrapper = panel(); await flushPromises();
    expect(wrapper.get('details').attributes('open')).toBeUndefined();
    expect(wrapper.get(field('usage-partial')).element.closest('details')).toBeNull();
    expect(wrapper.get(field('recent-failures')).element.closest('details')).toBeNull();
  });

  it('never renders arbitrary error text from recent failure records', async () => {
    const value = sample();
    value.failures = [{ id: 'failed-one', kind: 'render', occurredAt: value.sampledAt, message: 'SECRET raw provider prompt <img src=x onerror=alert(1)>' }];
    vi.mocked(fetch).mockResolvedValueOnce(response(value));
    const wrapper = panel(); await flushPromises();
    expect(wrapper.get(field('recent-failures')).text()).toContain('Script request failed');
    expect(wrapper.text()).not.toContain('SECRET');
    expect(wrapper.find('img').exists()).toBe(false);
  });

  it('polls every two seconds without overlapping an unfinished request or issuing commands', async () => {
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    panel(); await flushPromises();
    await vi.advanceTimersByTimeAsync(8000);
    expect(fetch).toHaveBeenCalledOnce();
    finish(response(sample())); await flushPromises();
    await vi.advanceTimersByTimeAsync(2000); await flushPromises();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.every(call => !call[1]?.method || call[1].method === 'GET')).toBe(true);
  });

  it('retains an explicitly stale snapshot on transport failure, then recovers without exposing raw errors', async () => {
    const wrapper = panel(); await flushPromises();
    vi.mocked(fetch).mockRejectedValueOnce(new Error('SECRET provider token'));
    await vi.advanceTimersByTimeAsync(2000); await flushPromises();
    expect(wrapper.get(field('ai-attempts')).text()).toBe('7');
    expect(wrapper.get(field('operations-update')).text()).toMatch(/last successful update/i);
    expect(wrapper.text()).not.toContain('SECRET');
    await vi.advanceTimersByTimeAsync(2000); await flushPromises();
    expect(wrapper.get(field('operations-update')).text()).not.toMatch(/last successful update/i);
  });

  it.each([401, 403, 404])('clears private counters on authorization response %s', async status => {
    const wrapper = panel(); await flushPromises();
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: 'SECRET denied' }, status));
    await vi.advanceTimersByTimeAsync(2000); await flushPromises();
    expect(wrapper.find(field('ai-attempts')).exists()).toBe(false);
    expect(wrapper.text()).toMatch(/unavailable|access/i);
    expect(wrapper.text()).not.toContain('SECRET');
  });

  it.each(['null', 'wrong session', 'negative counter', 'inconsistent counter', 'impossible progress', 'unexpected field'])('rejects a malformed %s snapshot', async problem => {
    let value: unknown = sample();
    if (problem === 'null') value = null;
    if (problem === 'wrong session') (value as SessionOperations).sessionId = 'another-show';
    if (problem === 'negative counter') (value as SessionOperations).usage.ai.attempts = -1;
    if (problem === 'inconsistent counter') (value as SessionOperations).usage.ai.attempts = 99;
    if (problem === 'impossible progress') (value as SessionOperations).speech.draft!.completedSegments = 9;
    if (problem === 'unexpected field') Object.assign(value!, { prompt: 'SECRET prompt' });
    vi.mocked(fetch).mockResolvedValueOnce(response(value));
    const wrapper = panel(); await flushPromises();
    expect(wrapper.find(field('ai-attempts')).exists()).toBe(false);
    expect(wrapper.get(field('operations-update')).text()).toMatch(/could not|unavailable/i);
    expect(wrapper.text()).not.toContain('SECRET');
  });

  it('clears and aborts the old session immediately, ignoring its later result', async () => {
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const wrapper = panel(); await flushPromises();
    const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
    const next = sample(); next.sessionId = 'next'; next.usage.ai = { attempts: 1, succeeded: 1, failed: 0, pending: 0, interrupted: 0 };
    vi.mocked(fetch).mockResolvedValueOnce(response(next));
    await wrapper.setProps({ sessionId: 'next' }); await flushPromises();
    expect(signal.aborted).toBe(true);
    expect(fetch).toHaveBeenLastCalledWith('/api/sessions/next/operations', expect.anything());
    finish(response(sample())); await flushPromises();
    expect(wrapper.get(field('ai-attempts')).text()).toBe('1');
  });

  it.each(['popstate', 'response'])('discards private data when identity changes before the next %s', async trigger => {
    let finish!: (value: Response) => void;
    const wrapper = panel(); await flushPromises();
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(2000); await flushPromises();
    window.history.replaceState({}, '', `/?identity=${'b'.repeat(32)}`);
    if (trigger === 'popstate') window.dispatchEvent(new PopStateEvent('popstate'));
    finish(response(sample())); await flushPromises();
    expect(wrapper.find(field('ai-attempts')).exists()).toBe(false);
    expect(wrapper.text()).toMatch(/identity.*changed|reload/i);
    const calls = vi.mocked(fetch).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it('does not fall back to another identity when the selected identity is malformed', async () => {
    window.history.replaceState({}, '', '/?identity=invalid');
    const wrapper = panel(); await flushPromises();
    expect(fetch).not.toHaveBeenCalled();
    expect(wrapper.text()).toMatch(/identity|reload/i);
  });

  it.each(['fetch', 'body'])('bounds stalled %s loading at ten seconds, including response parsing', async phase => {
    vi.mocked(fetch).mockImplementationOnce(() => phase === 'fetch'
      ? new Promise<Response>(() => {})
      : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) } as Response));
    const wrapper = panel(); await flushPromises();
    await vi.advanceTimersByTimeAsync(10_001); await flushPromises();
    expect(wrapper.get(field('operations-update')).text()).toMatch(/timed out|could not/i);
    expect(vi.mocked(fetch).mock.calls[0]![1]!.signal!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2000); await flushPromises();
    expect(wrapper.get(field('ai-attempts')).text()).toBe('7');
  });

  it('ignores a timed-out response that arrives after a newer successful poll', async () => {
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const wrapper = panel(); await flushPromises();
    const newer = sample(); newer.usage.ai = { attempts: 8, succeeded: 8, failed: 0, pending: 0, interrupted: 0 };
    vi.mocked(fetch).mockResolvedValueOnce(response(newer));
    await vi.advanceTimersByTimeAsync(12_000); await flushPromises();
    finish(response(sample())); await flushPromises();
    expect(wrapper.get(field('ai-attempts')).text()).toBe('8');
  });

  it('aborts requests and removes all polling and deadlines on unmount', async () => {
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(() => {}));
    const wrapper = panel(); await flushPromises();
    const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
    wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1);
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
