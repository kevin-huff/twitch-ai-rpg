import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LineAssistInput } from '@rpg/contracts';
import { ClewdrAiProvider, ProviderError } from './index.js';

const input: LineAssistInput = {
  idea: 'tell the guard we mean no harm',
  character: {
    displayName: 'Mira', pronouns: 'she/her', appearance: 'A tall courier.', personality: 'Dry and careful.', backstory: 'Raised on the docks.',
    specialty: 'Knots', flaw: 'Stubborn', connection: 'Knows the captain', secret: 'Owes a debt', possessions: ['rope'],
  },
  talkingTo: [{ displayName: 'Guard Odo', role: 'Gate guard', appearance: 'Heavy coat.', mood: 'wary', personality: ['stern'] }],
  present: { npcs: [{ displayName: 'Guard Odo', role: 'Gate guard' }], characters: [] },
  scene: { title: 'The Gate', description: 'A locked gate in the rain.' },
  story: { premise: 'A flooded town.', genre: 'Mystery', tone: 'Quiet' },
  facts: [],
  recentRounds: [],
  boundaries: [],
};

const TEN_MINUTES = 600_000;

// Answers like ClewdR after the given wait, or rejects as soon as the request is aborted.
function answeringAfter(waitMs: number) {
  return vi.fn<typeof fetch>((_url, init) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal as AbortSignal;
    const timer = setTimeout(() => resolve(Response.json({
      type: 'message', role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ text: 'We mean no harm.' }) }], stop_reason: 'end_turn',
    })), waitMs);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
  }));
}

const provider = (fetchFn: typeof fetch, timeoutMs: number | null) =>
  new ClewdrAiProvider({ baseUrl: 'http://clewdr.test:8484/code/v1', apiKey: 'test-key', model: 'test-model', fetch: fetchFn, timeoutMs });

describe('ClewdR with no time limit', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('waits as long as ClewdR takes to answer', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const outcome = provider(answeringAfter(TEN_MINUTES), null).suggestLine(input).then(value => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(await outcome).toEqual({ value: { text: 'We mean no harm.' } });
  });

  it('keeps a numeric limit when one is given', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outcome = provider(answeringAfter(TEN_MINUTES), 1000).suggestLine(input).then(value => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toMatchObject({ error: { code: 'timeout' } });
  });

  it('refuses a zero limit rather than reading it as no limit', () => {
    expect(() => provider(answeringAfter(1), 0)).toThrow(ProviderError);
  });
});
