interface Waiter {
  grant: () => void;
  fail: (error: unknown) => void;
}

function abortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error('The picture job was cancelled.');
  error.name = 'AbortError';
  return error;
}

// A counting gate for Sogni jobs: at most `size` holders, scene pictures ahead of everything else, first in first out within each priority.
export class ImageSlots {
  private held = 0;
  private readonly scene: Waiter[] = [];
  private readonly normal: Waiter[] = [];

  constructor(private readonly size: number) {}

  acquire(priority: 'scene' | 'normal', signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.held < this.size) return Promise.resolve(this.take());
    const queue = priority === 'scene' ? this.scene : this.normal;
    return new Promise((resolve, reject) => {
      const onAbort = () => leave(abortError(signal!));
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
      };
      const waiter: Waiter = {
        grant: () => { cleanup(); resolve(this.releaser()); },
        fail: (error) => { cleanup(); reject(error); },
      };
      const leave = (error: unknown) => {
        const index = queue.indexOf(waiter);
        if (index < 0) return;
        queue.splice(index, 1);
        waiter.fail(error);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(waiter);
    });
  }

  private take(): () => void {
    this.held += 1;
    return this.releaser();
  }

  // A granted waiter inherits the slot that was just freed, so `held` does not change when a slot is handed on.
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.scene.shift() ?? this.normal.shift();
      if (next) next.grant();
      else this.held -= 1;
    };
  }
}
