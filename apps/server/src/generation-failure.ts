import { ProviderError } from '@rpg/providers';

export class RequestBudgetError extends Error {
  constructor() {
    super('The generation request ran out of time.');
    this.name = 'RequestBudgetError';
  }
}

const CUT_OFF_DETAIL = 'reply cut off at the length limit';
const REASSURANCE = ' Your accepted inputs and dice are safe. Retry or write a manual script.';

function reason(error: unknown, elapsedMs: number): string {
  if (error instanceof RequestBudgetError || (error instanceof ProviderError && error.code === 'timeout')) {
    return `The AI took too long to answer, so the app stopped waiting after ${Math.round(elapsedMs / 1000)} seconds.`;
  }
  if (error instanceof ProviderError) {
    if (error.code === 'http_error') return error.status === 429 ? 'ClewdR is rate limited (HTTP 429). Check its accounts.' : `ClewdR answered with an error (HTTP ${error.status ?? 'unknown'}).`;
    if (error.code === 'network_error') return 'The app could not reach ClewdR at home.';
    if (error.code === 'invalid_response') return error.detail === CUT_OFF_DETAIL ? "The AI's reply was cut off at the length limit." : "The AI's reply failed the app's checks.";
  }
  return 'Generation failed.';
}

// Fixed sentences only: provider text can carry story content or account details, so it is never copied here.
export function failureSentence(error: unknown, elapsedMs: number): string {
  return `${reason(error, elapsedMs)}${REASSURANCE}`;
}
