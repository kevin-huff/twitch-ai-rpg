// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { boot } from './boot';

const Probe = defineComponent({ render: () => h('p', { 'data-testid': 'probe' }, 'mounted') });

const okResponse = { ok: true } as Response;
const badResponse = { ok: false } as Response;

describe('boot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    document.body.innerHTML = '<div id="app"></div>';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('mounts when the first load succeeds', async () => {
    const reload = vi.fn();
    const fetchMock = vi.fn();
    const load = vi.fn().mockResolvedValue({ default: Probe });
    await boot(load, { reload, fetch: fetchMock as unknown as typeof fetch });
    expect(load).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="probe"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reload).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('polls health after a failed load and reloads once after an ok answer', async () => {
    const reload = vi.fn();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(badResponse)
      .mockResolvedValue(okResponse);
    const load = vi.fn().mockRejectedValue(new Error('chunk'));
    void boot(load, { reload, fetch: fetchMock as unknown as typeof fetch, pollMs: 2000, timeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/health');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#app')?.innerHTML).toBe('');
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('aborts a hung health request after the timeout and polls again on schedule', async () => {
    const reload = vi.fn();
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init!.signal!);
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const load = vi.fn().mockRejectedValue(new Error('chunk'));
    void boot(load, { reload, fetch: fetchMock as unknown as typeof fetch, pollMs: 2000, timeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2999);
    expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(reload).not.toHaveBeenCalled();
  });

  it('stops polling after the reload', async () => {
    const reload = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(okResponse);
    const load = vi.fn().mockRejectedValue(new Error('chunk'));
    const done = boot(load, { reload, fetch: fetchMock as unknown as typeof fetch, pollMs: 2000, timeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(reload).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
