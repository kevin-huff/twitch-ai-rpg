import { describe, expect, it } from 'vitest';
import { ClewdrAiProvider } from '@rpg/providers';
import { AI_CALL_TIMEOUT_MS, AI_REQUEST_BUDGET_MS } from '../src/ai-deadlines';

describe('AI deadlines', () => {
  it('keeps each call within the provider timeout limit', () => {
    expect(AI_CALL_TIMEOUT_MS).toBeLessThanOrEqual(120000);
  });

  it('leaves room for two full attempts and the save inside one request budget', () => {
    expect(AI_REQUEST_BUDGET_MS).toBeGreaterThanOrEqual(2 * AI_CALL_TIMEOUT_MS + 5000);
  });

  it('stays under the five-minute public request limit', () => {
    expect(AI_REQUEST_BUDGET_MS).toBeLessThanOrEqual(290000);
  });

  it('builds the provider with the call timeout', () => {
    expect(() => new ClewdrAiProvider({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'm', timeoutMs: AI_CALL_TIMEOUT_MS })).not.toThrow();
  });
});
