import { describe, expect, it, vi } from 'vitest';
import { ClewdrAiProvider } from './index.js';
import { BeatSchema, SubmissionSchema, type ProviderContext } from '@rpg/contracts';
import { createLedgerState } from '@rpg/test-fixtures';

function context(): ProviderContext {
  let sequence = 0;
  const state = createLedgerState('session', () => `entity-${++sequence}`);
  state.session.beatNumber = 2;
  state.session.status = 'live';
  const submission = SubmissionSchema.parse({
    id: 'submission', sessionId: state.session.id, characterId: state.characters[0].id,
    contextBeatId: 'beat', inputEpoch: 1, revision: 1, kind: 'say', text: 'What happened to the owner?',
    recipientNpcIds: [state.npcs[0].id], status: 'locked',
  });
  const beat = BeatSchema.parse({
    id: 'beat', sessionId: state.session.id, kind: 'conversation', phase: 'locked', revision: 4,
    inputEpoch: 1, sourceStateRevision: state.session.stateRevision,
    selectedSubmissionIds: [submission.id], lockedSubmissions: [submission], contracts: [],
    stakesApproved: true, classification: 'ordinary', inputSnapshotHash: 'saved-input', resolution: { rolls: [], outcomes: [], effects: [] },
    draft: null, draftRevision: 0, approvedContinuity: [], generation: 1, lastError: null,
  });
  return { state, beat, submissions: [submission], history: [] };
}

function hangingFetch() {
  const seen: AbortSignal[] = [];
  const fetchFn = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal as AbortSignal;
    seen.push(signal);
    if (signal.aborted) { reject(new Error('aborted')); return; }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  return { fetchFn, seen };
}

function provider(fetchFn: unknown) {
  return new ClewdrAiProvider({ baseUrl: 'http://clewdr.test:8484/code/v1', apiKey: 'test-key', model: 'test-model', timeoutMs: 30_000, fetch: fetchFn as typeof fetch });
}

describe.each(['plan', 'render'] as const)('%s stop signal', (task) => {
  it('aborts the fetch and rejects quickly when the caller aborts mid-call', async () => {
    const { fetchFn, seen } = hangingFetch();
    const controller = new AbortController();
    const call = provider(fetchFn)[task](context(), { signal: controller.signal });
    const outcome = call.then(() => 'resolved', () => 'rejected');
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const started = Date.now();
    controller.abort();
    expect(await outcome).toBe('rejected');
    expect(Date.now() - started).toBeLessThan(100);
    expect(seen[0].aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('still aborts the fetch when the call has no time limit', async () => {
    const { fetchFn, seen } = hangingFetch();
    const controller = new AbortController();
    const unlimited = new ClewdrAiProvider({ baseUrl: 'http://clewdr.test:8484/code/v1', apiKey: 'test-key', model: 'test-model', timeoutMs: null, fetch: fetchFn as typeof fetch });
    const outcome = unlimited[task](context(), { signal: controller.signal }).then(() => 'resolved', () => 'rejected');
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(await outcome).toBe('rejected');
    expect(seen[0].aborted).toBe(true);
  });

  it('sends no request for an already-aborted signal', async () => {
    const { fetchFn } = hangingFetch();
    const controller = new AbortController();
    controller.abort();
    await expect(provider(fetchFn)[task](context(), { signal: controller.signal })).rejects.toBeTruthy();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('behaves as before without a signal', async () => {
    const fetchFn = vi.fn(async () => new Response('not json', { status: 200 }));
    await expect(provider(fetchFn)[task](context())).rejects.toBeTruthy();
    expect(fetchFn).toHaveBeenCalled();
  });
});
