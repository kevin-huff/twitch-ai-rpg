import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageSlots } from '../src/image-slots';

describe('ImageSlots', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('hands out at most size slots at once', async () => {
    const slots = new ImageSlots(2);
    const first = await slots.acquire('normal');
    await slots.acquire('normal');
    let third = false;
    void slots.acquire('normal').then(() => { third = true; });
    await vi.advanceTimersByTimeAsync(10);
    expect(third).toBe(false);
    first();
    await vi.advanceTimersByTimeAsync(0);
    expect(third).toBe(true);
  });

  it('serves waiters first in, first out within a priority', async () => {
    const slots = new ImageSlots(1);
    const release = await slots.acquire('normal');
    const order: string[] = [];
    const releases: Array<() => void> = [];
    for (const name of ['a', 'b', 'c']) {
      void slots.acquire('normal').then((done) => { order.push(name); releases.push(done); });
    }
    release();
    await vi.advanceTimersByTimeAsync(0);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('serves every waiting scene request before any normal one', async () => {
    const slots = new ImageSlots(1);
    const release = await slots.acquire('normal');
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const wait = (name: string, priority: 'scene' | 'normal') =>
      void slots.acquire(priority).then((done) => { order.push(name); releases.push(done); });
    wait('normal-1', 'normal');
    wait('scene-1', 'scene');
    wait('normal-2', 'normal');
    wait('scene-2', 'scene');
    release();
    for (let step = 0; step < 4; step += 1) {
      await vi.advanceTimersByTimeAsync(0);
      releases.shift()?.();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['scene-1', 'scene-2', 'normal-1', 'normal-2']);
  });

  it('keeps a waiter without a signal waiting however long it takes, then grants it when a slot frees', async () => {
    const slots = new ImageSlots(1);
    const release = await slots.acquire('normal');
    let granted = false;
    void slots.acquire('normal').then(() => { granted = true; });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(granted).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(granted).toBe(true);
  });

  it('rejects an already aborted signal without taking a slot', async () => {
    const slots = new ImageSlots(1);
    const controller = new AbortController();
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(slots.acquire('normal', controller.signal)).rejects.toBe(reason);
    const release = await slots.acquire('normal');
    expect(typeof release).toBe('function');
  });

  it('rejects when the signal aborts during the wait and leaves the queue', async () => {
    const slots = new ImageSlots(1);
    const release = await slots.acquire('normal');
    const controller = new AbortController();
    const waiting = slots.acquire('normal', controller.signal).catch((error) => error);
    let next = false;
    void slots.acquire('normal').then(() => { next = true; });
    controller.abort();
    const error = await waiting;
    expect((error as Error).name).toBe('AbortError');
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(next).toBe(true);
  });

  it('makes release idempotent', async () => {
    const slots = new ImageSlots(1);
    const release = await slots.acquire('normal');
    let second = false;
    void slots.acquire('normal').then(() => { second = true; });
    let third = false;
    void slots.acquire('normal').then(() => { third = true; });
    release();
    release();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toBe(true);
    expect(third).toBe(false);
  });

  it('passes a slot on past a waiter that aborted', async () => {
    const slots = new ImageSlots(1);
    const release = await slots.acquire('normal');
    const controller = new AbortController();
    const doomed = slots.acquire('normal', controller.signal).catch((error) => error);
    let survivor = false;
    void slots.acquire('normal').then(() => { survivor = true; });
    controller.abort();
    expect(((await doomed) as Error).name).toBe('AbortError');
    expect(survivor).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(survivor).toBe(true);
  });

  it('never sets a timer for waiters', async () => {
    const slots = new ImageSlots(1);
    const release = await slots.acquire('normal');
    const waiting = slots.acquire('normal', new AbortController().signal);
    expect(vi.getTimerCount()).toBe(0);
    release();
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
  });
});
