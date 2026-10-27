interface Lane {
  tail: Promise<void>;
  waiting: Promise<void> | null;
}

export class GalleryQueue {
  private readonly lanes = new Map<string, Lane>();

  run(key: string, task: () => Promise<unknown>): Promise<void> {
    return this.enqueue(key, task, false);
  }

  coalesce(key: string, task: () => Promise<unknown>): Promise<void> {
    const waiting = this.lanes.get(key)?.waiting;
    if (waiting) return waiting;
    return this.enqueue(key, task, true);
  }

  idle(): Promise<void> {
    return Promise.all([...this.lanes.values()].map(lane => lane.tail)).then(() => undefined);
  }

  get size(): number {
    return this.lanes.size;
  }

  private enqueue(key: string, task: () => Promise<unknown>, coalescable: boolean): Promise<void> {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { tail: Promise.resolve(), waiting: null };
      this.lanes.set(key, lane);
    }
    const current = lane;
    const promise: Promise<void> = current.tail
      .then(() => {
        if (current.waiting === promise) current.waiting = null;
        return task();
      })
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (current.tail === promise && this.lanes.get(key) === current) this.lanes.delete(key);
      });
    current.tail = promise;
    current.waiting = coalescable ? promise : null;
    return promise;
  }
}
