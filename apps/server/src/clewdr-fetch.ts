import { Agent, fetch as undiciFetch } from 'undici';

// ClewdR sends nothing until the whole reply is written, and Node's built-in fetch gives up on a reply with no
// headers after five minutes. This fetch, used only for ClewdR, waits as long as the AI takes; an abort still stops it.
export const CLEWDR_WAIT = { headersTimeout: 0, bodyTimeout: 0 };

type UndiciInput = Parameters<typeof undiciFetch>[0];
type UndiciInit = NonNullable<Parameters<typeof undiciFetch>[1]>;

export function createClewdrFetch(wait: { headersTimeout: number; bodyTimeout: number } = CLEWDR_WAIT): typeof globalThis.fetch {
  const dispatcher = new Agent(wait);
  const clewdrFetch = (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    undiciFetch(input as UndiciInput, { ...(init as UndiciInit), dispatcher }) as unknown as Promise<Response>;
  return clewdrFetch as typeof globalThis.fetch;
}
