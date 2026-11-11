import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNarrationWait } from './narration-wait';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createNarrationWait', () => {
  it('starts at once when there is no dice moment', () => {
    const start = vi.fn();
    createNarrationWait(start).published('beat-1', true, 0);
    expect(start).toHaveBeenCalledWith('beat-1');
  });

  it('waits for the dice moment before starting', () => {
    const start = vi.fn();
    createNarrationWait(start).published('beat-1', true, 3320);
    vi.advanceTimersByTime(3319);
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(start).toHaveBeenCalledWith('beat-1');
  });

  it('starts nothing for a text-only publish', () => {
    const start = vi.fn();
    createNarrationWait(start).published('beat-1', false, 3320);
    vi.advanceTimersByTime(10_000);
    expect(start).not.toHaveBeenCalled();
  });

  it('lets a newer publish replace a wait still running', () => {
    const start = vi.fn();
    const wait = createNarrationWait(start);
    wait.published('beat-1', true, 3000);
    vi.advanceTimersByTime(1000);
    wait.published('beat-2', true, 0);
    vi.advanceTimersByTime(5000);
    expect(start.mock.calls).toEqual([['beat-2']]);
  });

  it('cancels a wait when the page closes', () => {
    const start = vi.fn();
    const wait = createNarrationWait(start);
    wait.published('beat-1', true, 3000);
    wait.dispose();
    vi.advanceTimersByTime(5000);
    expect(start).not.toHaveBeenCalled();
  });
});
