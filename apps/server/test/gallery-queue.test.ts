import { describe, expect, it } from 'vitest';
import { GalleryQueue } from '../src/gallery-queue';

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

function track(promise: Promise<void>): { done: boolean } {
  const state = { done: false };
  void promise.then(() => {
    state.done = true;
  });
  return state;
}

describe('GalleryQueue', () => {
  it('runs tasks with the same key one at a time, in call order', async () => {
    const queue = new GalleryQueue();
    const log: string[] = [];
    const gates = [deferred(), deferred(), deferred()];
    let running = 0;
    let most = 0;
    const promises = gates.map((gate, index) =>
      queue.run('show', async () => {
        running += 1;
        most = Math.max(most, running);
        log.push(`start ${index}`);
        await gate.promise;
        log.push(`end ${index}`);
        running -= 1;
      }),
    );
    await flush();
    expect(log).toEqual(['start 0']);
    gates[2].resolve();
    await flush();
    expect(log).toEqual(['start 0']);
    gates[0].resolve();
    await flush();
    expect(log).toEqual(['start 0', 'end 0', 'start 1']);
    gates[1].resolve();
    await Promise.all(promises);
    expect(log).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
    expect(most).toBe(1);
  });

  it('lets tasks with different keys overlap', async () => {
    const queue = new GalleryQueue();
    const log: string[] = [];
    const a = deferred();
    const b = deferred();
    const first = queue.run('a', async () => {
      log.push('start a');
      await a.promise;
      log.push('end a');
    });
    const second = queue.run('b', async () => {
      log.push('start b');
      await b.promise;
      log.push('end b');
    });
    await flush();
    expect(log).toEqual(['start a', 'start b']);
    expect(queue.size).toBe(2);
    b.resolve();
    await second;
    expect(log).toEqual(['start a', 'start b', 'end b']);
    expect(queue.size).toBe(1);
    a.resolve();
    await first;
    expect(queue.size).toBe(0);
  });

  it('folds coalesce calls made while a coalesced task runs into exactly one more run', async () => {
    const queue = new GalleryQueue();
    const gates = [deferred(), deferred()];
    let runs = 0;
    const job = async () => {
      const gate = gates[runs];
      runs += 1;
      await gate.promise;
    };
    const first = track(queue.coalesce('show', job));
    await flush();
    expect(runs).toBe(1);
    const secondPromise = queue.coalesce('show', job);
    const thirdPromise = queue.coalesce('show', job);
    expect(thirdPromise).toBe(secondPromise);
    const second = track(secondPromise);
    const third = track(thirdPromise);
    gates[0].resolve();
    await flush();
    expect(first.done).toBe(true);
    expect(runs).toBe(2);
    expect(second.done).toBe(false);
    expect(third.done).toBe(false);
    gates[1].resolve();
    await Promise.all([secondPromise, thirdPromise]);
    expect(runs).toBe(2);
    expect(queue.size).toBe(0);
  });

  it('queues a new coalesced task after a run that was queued behind a waiting one', async () => {
    const queue = new GalleryQueue();
    const log: string[] = [];
    const gate = deferred();
    const blocker = queue.run('show', async () => {
      log.push('blocker');
      await gate.promise;
    });
    const waiting = queue.coalesce('show', async () => {
      log.push('refresh 1');
    });
    const remove = queue.run('show', async () => {
      log.push('remove');
    });
    const later = queue.coalesce('show', async () => {
      log.push('refresh 2');
    });
    expect(later).not.toBe(waiting);
    gate.resolve();
    await Promise.all([blocker, waiting, remove, later]);
    expect(log).toEqual(['blocker', 'refresh 1', 'remove', 'refresh 2']);
  });

  it('joins a waiting coalesced task only while it is last in line', async () => {
    const queue = new GalleryQueue();
    const gate = deferred();
    void queue.run('show', () => gate.promise);
    const waiting = queue.coalesce('show', async () => {});
    expect(queue.coalesce('show', async () => {})).toBe(waiting);
    void queue.run('show', async () => {});
    expect(queue.coalesce('show', async () => {})).not.toBe(waiting);
    gate.resolve();
    await queue.idle();
    expect(queue.size).toBe(0);
  });

  it('resolves the promise of a task that throws or rejects and still runs the next task', async () => {
    const queue = new GalleryQueue();
    const log: string[] = [];
    const thrown = queue.run('show', () => {
      throw new Error('thrown');
    });
    const rejected = queue.coalesce('show', async () => {
      throw new Error('rejected');
    });
    const next = queue.run('show', async () => {
      log.push('next');
    });
    await expect(thrown).resolves.toBeUndefined();
    await expect(rejected).resolves.toBeUndefined();
    await expect(next).resolves.toBeUndefined();
    expect(log).toEqual(['next']);
    expect(queue.size).toBe(0);
  });

  it('resolves idle() only after everything queued before the call', async () => {
    const queue = new GalleryQueue();
    const a = deferred();
    const b = deferred();
    const finished: string[] = [];
    void queue.run('a', async () => {
      await a.promise;
      finished.push('a');
    });
    void queue.coalesce('b', async () => {
      await b.promise;
      finished.push('b');
    });
    const idle = track(queue.idle());
    const late = deferred();
    void queue.run('c', () => late.promise);
    a.resolve();
    await flush();
    expect(idle.done).toBe(false);
    b.resolve();
    await flush();
    expect(finished).toEqual(['a', 'b']);
    expect(idle.done).toBe(true);
    expect(queue.size).toBe(1);
    late.resolve();
    await queue.idle();
    expect(queue.size).toBe(0);
  });

  it('resolves idle() at once and reports size 0 when nothing is queued', async () => {
    const queue = new GalleryQueue();
    expect(queue.size).toBe(0);
    await expect(queue.idle()).resolves.toBeUndefined();
    await queue.run('show', async () => {});
    await queue.coalesce('*list', async () => {});
    expect(queue.size).toBe(0);
  });
});
