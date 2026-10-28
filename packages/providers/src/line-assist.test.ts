import { describe, expect, it, vi } from 'vitest';
import type { LineAssistInput } from '@rpg/contracts';
import { ClewdrAiProvider, ProviderError } from './index.js';

function nativeText(text: string) {
  return Response.json({ type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' });
}
const nativeResponse = (value: unknown) => nativeText(JSON.stringify(value));

function ai(fetchMock: typeof fetch) {
  return new ClewdrAiProvider({ baseUrl: 'http://clewdr.test:8484/code/v1', apiKey: 'private-api-key', model: 'configured-model', fetch: fetchMock, timeoutMs: 1000 });
}

const input: LineAssistInput = {
  idea: 'tell the guard we mean no harm',
  character: {
    displayName: 'Mira', pronouns: 'she/her', appearance: 'A tall courier.', personality: 'Dry and careful.', backstory: 'Raised on the docks.',
    specialty: 'Knots', flaw: 'Stubborn', connection: 'Knows the captain', secret: 'SECRET-MARKER owes a debt', possessions: ['rope'],
  },
  talkingTo: [{ displayName: 'Guard Odo', role: 'Gate guard', appearance: 'Heavy coat.', mood: 'wary', personality: ['stern'] }],
  present: { npcs: [{ displayName: 'Guard Odo', role: 'Gate guard' }], characters: [{ displayName: 'Ines', appearance: 'Short hair.' }] },
  scene: { title: 'The Gate', description: 'A locked gate in the rain.' },
  story: { premise: 'A flooded town.', genre: 'Mystery', tone: 'Quiet' },
  facts: ['The gate is locked.'],
  recentRounds: [{ beatNumber: 2, lines: [{ speaker: 'Guard Odo', text: 'Halt.' }] }],
  boundaries: ['BOUNDARY-MARKER no harm to animals'],
};

describe('ClewdR line assist', () => {
  it('sends the rules with a bounded request and returns the suggestion', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => nativeResponse({ text: '[calmly] We mean no harm, friend. We only want to pass.' }));
    const result = await ai(fetchMock).suggestLine(input);
    expect(result).toEqual({ text: '[calmly] We mean no harm, friend. We only want to pass.' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init?.body));
    expect(body.system).toContain('one to three sentences');
    expect(body.system).toContain('in their character\'s voice and personality');
    expect(body.system).toContain('no new decisions, actions or promises');
    expect(body.system).toContain('no lines for anyone else');
    expect(body.system).toContain('Settle no outcome');
    expect(body.system).toContain('Respect the content boundaries');
    expect(body.system).toContain('Never reveal the character\'s secret unless the idea itself does');
    expect(body.system).toContain('Eleven v4 audio tags');
    expect(body.system).toContain('No sound effects and no accent tags');
    expect(body.system).toContain('untrusted');
    expect(body.system).toContain('Return only one JSON object');
    expect(body.system).toContain('single quotes');
    expect(body.system).toContain('"text"');
    expect(JSON.parse(body.messages[0].content)).toEqual(input);
    expect(JSON.stringify(body.system)).not.toContain('SECRET-MARKER');
    expect(JSON.stringify(body.system)).not.toContain('BOUNDARY-MARKER');
  });

  it('rejects a blank reply as an invalid response', async () => {
    for (const text of ['', '   ']) {
      const fetchMock = vi.fn<typeof fetch>(async () => nativeResponse({ text }));
      await expect(ai(fetchMock).suggestLine(input)).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it('rejects a reply over 4000 characters, and accepts exactly 4000', async () => {
    await expect(ai(vi.fn<typeof fetch>(async () => nativeResponse({ text: 'a'.repeat(4001) }))).suggestLine(input)).rejects.toMatchObject({ code: 'invalid_response' });
    const ok = await ai(vi.fn<typeof fetch>(async () => nativeResponse({ text: 'a'.repeat(4000) }))).suggestLine(input);
    expect(ok.text).toHaveLength(4000);
  });

  it('rejects a reply that is not the one JSON object', async () => {
    for (const reply of [nativeText('Sure, here you go'), nativeResponse({ text: 'Hi', extra: 1 }), nativeResponse({ line: 'Hi' })]) {
      await expect(ai(vi.fn<typeof fetch>(async () => reply)).suggestLine(input)).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it('rejects invalid input without a call', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => nativeResponse({ text: 'Hi' }));
    const error = await ai(fetchMock).suggestLine({ ...input, idea: 5 } as unknown as LineAssistInput).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('invalid_input');
    await expect(ai(fetchMock).suggestLine({ ...input, extra: true } as unknown as LineAssistInput)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
