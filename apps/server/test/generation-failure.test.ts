import { describe, expect, it } from 'vitest';
import { ProviderError } from '@rpg/providers';
import { RequestBudgetError, failureSentence, reassurance, type FailureRound } from '../src/generation-failure';

const PLAN: FailureRound = { task: 'plan', lines: true, dice: false };
const SCRIPT_DICE: FailureRound = { task: 'render', lines: true, dice: true };
const SCRIPT_LINES: FailureRound = { task: 'render', lines: true, dice: false };
const SCRIPT_BARE: FailureRound = { task: 'render', lines: false, dice: false };
const SAFE = ' Your lines are safe. Plan again, or write the stakes yourself.';

describe('failureSentence', () => {
  it('reports a provider timeout with the seconds waited', () => {
    expect(failureSentence(new ProviderError('timeout', 'ClewdR'), 120_400, PLAN)).toBe(`The AI took too long to answer, so the app stopped waiting after 120 seconds.${SAFE}`);
  });

  it('reports the request budget running out the same way', () => {
    expect(failureSentence(new RequestBudgetError(), 250_000, PLAN)).toBe(`The AI took too long to answer, so the app stopped waiting after 250 seconds.${SAFE}`);
  });

  it('names rate limiting for HTTP 429', () => {
    expect(failureSentence(new ProviderError('http_error', 'ClewdR', 429), 1000, PLAN)).toBe(`ClewdR is rate limited (HTTP 429). Check its accounts.${SAFE}`);
  });

  it('gives the status for any other HTTP error', () => {
    expect(failureSentence(new ProviderError('http_error', 'ClewdR', 502), 1000, PLAN)).toBe(`ClewdR answered with an error (HTTP 502).${SAFE}`);
  });

  it('says the home server could not be reached for a network error', () => {
    expect(failureSentence(new ProviderError('network_error', 'ClewdR'), 1000, PLAN)).toBe(`The app could not reach ClewdR at home.${SAFE}`);
  });

  it('says a cut-off reply hit the length limit', () => {
    const error = new ProviderError('invalid_response', 'ClewdR', undefined, undefined, 'reply cut off at the length limit');
    expect(failureSentence(error, 1000, PLAN)).toBe(`The AI's reply was cut off at the length limit.${SAFE}`);
  });

  it('says any other invalid reply failed the checks', () => {
    expect(failureSentence(new ProviderError('invalid_response', 'ClewdR', undefined, undefined, 'missing field'), 1000, PLAN)).toBe(`The AI's reply failed the app's checks.${SAFE}`);
    expect(failureSentence(new ProviderError('invalid_response', 'ClewdR'), 1000, PLAN)).toBe(`The AI's reply failed the app's checks.${SAFE}`);
  });

  it('falls back to a plain sentence for anything else', () => {
    expect(failureSentence(new Error('boom'), 1000, PLAN)).toBe(`The AI request failed.${SAFE}`);
    expect(failureSentence('nope', 1000, PLAN)).toBe(`The AI request failed.${SAFE}`);
    expect(failureSentence(new ProviderError('configuration', 'ClewdR'), 1000, PLAN)).toBe(`The AI request failed.${SAFE}`);
  });

  it('never copies provider text into the sentence', () => {
    const secret = 'SECRET-STORY-TEXT-Mrs-Hargrove';
    const withDetail = new ProviderError('invalid_response', 'ClewdR', undefined, undefined, secret);
    const plain = Object.assign(new Error(secret), { detail: secret });
    for (const error of [withDetail, plain, new RequestBudgetError()]) {
      const sentence = failureSentence(error, 5000, PLAN);
      expect(sentence).not.toContain(secret);
      expect(sentence).not.toContain(error.message);
    }
  });
});

describe('reassurance', () => {
  it('names only what exists at the step', () => {
    expect(reassurance(PLAN)).toBe(' Your lines are safe. Plan again, or write the stakes yourself.');
    expect(reassurance(SCRIPT_DICE)).toBe(' Your lines and dice are safe. Try again, or write the script yourself.');
    expect(reassurance(SCRIPT_LINES)).toBe(' Your lines are safe. Try again, or write the script yourself.');
    expect(reassurance(SCRIPT_BARE)).toBe(' Try again, or write the script yourself.');
  });

  it('never mentions dice for a plan, even if the round says it has some', () => {
    expect(reassurance({ task: 'plan', lines: true, dice: true })).not.toMatch(/dice/);
    expect(reassurance({ task: 'plan', lines: false, dice: false })).not.toMatch(/dice/);
  });

  it('is attached to every reason for every round shape, with no internal words', () => {
    const errors = [new ProviderError('timeout', 'ClewdR'), new RequestBudgetError(), new ProviderError('http_error', 'ClewdR', 429), new ProviderError('http_error', 'ClewdR', 500),
      new ProviderError('network_error', 'ClewdR'), new ProviderError('invalid_response', 'ClewdR'), new ProviderError('invalid_response', 'ClewdR', undefined, undefined, 'reply cut off at the length limit'), new Error('boom')];
    for (const error of errors) for (const round of [PLAN, SCRIPT_DICE, SCRIPT_LINES, SCRIPT_BARE]) {
      const sentence = failureSentence(error, 1000, round);
      expect(sentence.endsWith(reassurance(round))).toBe(true);
      expect(sentence).not.toMatch(/generation|validation|manual|accepted inputs/i);
      if (round.task === 'plan') expect(sentence).not.toMatch(/dice|script/i);
      if (!round.dice && round.task === 'render') expect(sentence).not.toMatch(/dice/);
      if (!round.lines && round.task === 'render') expect(sentence).not.toMatch(/lines/);
    }
  });
});
