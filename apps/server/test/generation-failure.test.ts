import { describe, expect, it } from 'vitest';
import { ProviderError } from '@rpg/providers';
import { RequestBudgetError, failureSentence } from '../src/generation-failure';

const SAFE = ' Your accepted inputs and dice are safe. Retry or write a manual script.';

describe('failureSentence', () => {
  it('reports a provider timeout with the seconds waited', () => {
    expect(failureSentence(new ProviderError('timeout', 'ClewdR'), 120_400)).toBe(`The AI took too long to answer, so the app stopped waiting after 120 seconds.${SAFE}`);
  });

  it('reports the request budget running out the same way', () => {
    expect(failureSentence(new RequestBudgetError(), 250_000)).toBe(`The AI took too long to answer, so the app stopped waiting after 250 seconds.${SAFE}`);
  });

  it('names rate limiting for HTTP 429', () => {
    expect(failureSentence(new ProviderError('http_error', 'ClewdR', 429), 1000)).toBe(`ClewdR is rate limited (HTTP 429). Check its accounts.${SAFE}`);
  });

  it('gives the status for any other HTTP error', () => {
    expect(failureSentence(new ProviderError('http_error', 'ClewdR', 502), 1000)).toBe(`ClewdR answered with an error (HTTP 502).${SAFE}`);
  });

  it('says the home server could not be reached for a network error', () => {
    expect(failureSentence(new ProviderError('network_error', 'ClewdR'), 1000)).toBe(`The app could not reach ClewdR at home.${SAFE}`);
  });

  it('says a cut-off reply hit the length limit', () => {
    const error = new ProviderError('invalid_response', 'ClewdR', undefined, undefined, 'reply cut off at the length limit');
    expect(failureSentence(error, 1000)).toBe(`The AI's reply was cut off at the length limit.${SAFE}`);
  });

  it('says any other invalid reply failed the checks', () => {
    expect(failureSentence(new ProviderError('invalid_response', 'ClewdR', undefined, undefined, 'missing field'), 1000)).toBe(`The AI's reply failed the app's checks.${SAFE}`);
    expect(failureSentence(new ProviderError('invalid_response', 'ClewdR'), 1000)).toBe(`The AI's reply failed the app's checks.${SAFE}`);
  });

  it('falls back to a plain sentence for anything else', () => {
    expect(failureSentence(new Error('boom'), 1000)).toBe(`Generation failed.${SAFE}`);
    expect(failureSentence('nope', 1000)).toBe(`Generation failed.${SAFE}`);
    expect(failureSentence(new ProviderError('configuration', 'ClewdR'), 1000)).toBe(`Generation failed.${SAFE}`);
  });

  it('never copies provider text into the sentence', () => {
    const secret = 'SECRET-STORY-TEXT-Mrs-Hargrove';
    const withDetail = new ProviderError('invalid_response', 'ClewdR', undefined, undefined, secret);
    const plain = Object.assign(new Error(secret), { detail: secret });
    for (const error of [withDetail, plain, new RequestBudgetError()]) {
      const sentence = failureSentence(error, 5000);
      expect(sentence).not.toContain(secret);
      expect(sentence).not.toContain(error.message);
    }
  });
});
