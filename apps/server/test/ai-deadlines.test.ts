import { describe, expect, it } from 'vitest';
import { ClewdrAiProvider } from '@rpg/providers';
import { AI_CALL_TIMEOUT_MS, AI_REQUEST_BUDGET_MS } from '../src/ai-deadlines';

describe('AI deadlines', () => {
  it('sets no time limit on a single AI call', () => {
    expect(AI_CALL_TIMEOUT_MS).toBeNull();
  });

  it('sets no time limit on a whole plan, script or other AI request', () => {
    expect(AI_REQUEST_BUDGET_MS).toBeNull();
  });

  it('builds the provider with no call limit', () => {
    expect(() => new ClewdrAiProvider({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'm', timeoutMs: AI_CALL_TIMEOUT_MS })).not.toThrow();
  });
});
