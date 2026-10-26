import { describe, expect, it, vi } from 'vitest';
import type { PictureDescriptionRequest } from '@rpg/contracts';
import { ClewdrAiProvider } from './index.js';

function nativeResponse(value: unknown) {
  return Response.json({ type: 'message', role: 'assistant', content: [{ type: 'text', text: JSON.stringify(value) }], stop_reason: 'end_turn' });
}

function ai(fetchMock: typeof fetch) {
  return new ClewdrAiProvider({ baseUrl: 'http://clewdr.test:8484/code/v1', apiKey: 'private-api-key', model: 'configured-model', fetch: fetchMock, timeoutMs: 1000 });
}

const input: PictureDescriptionRequest = {
  style: 'Painterly digital illustration',
  scene: { title: 'The Harbor', description: 'Fog over the docks.', place: 'Harbor' },
  lines: [{ kind: 'narration', speaker: null, text: 'Mara steps off the boat.' }],
  cast: [{ name: 'Mara', appearance: 'tall, red coat', role: 'Captain', pronouns: 'she/her', imageNumber: 1 }],
  budget: 1234,
};

describe('ClewdR picture description', () => {
  it('posts the rules, the budget and the validated input, and returns the text', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse({ text: 'The person from image 1 stands in fog.' }));
    expect(await ai(fetchMock).describePicture(input)).toBe('The person from image 1 stands in fog.');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    for (const rule of ['untrusted story material', 'Never write any name.', 'the person from image N', 'Include every cast member', 'No visible lettering, signs or text.', 'Everyone fully clothed.', 'Do not restate the art style', 'At most 1234 characters.', 'Required JSON schema']) {
      expect(body.system).toContain(rule);
    }
    expect(body.system).toContain('single quotes');
    expect(JSON.parse(body.messages[0].content)).toEqual(input);
  });

  it('refuses invalid input without fetching', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(ai(fetchMock).describePicture({ ...input, budget: 0 })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(ai(fetchMock).describePicture({ ...input, extra: 1 } as PictureDescriptionRequest)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a reply that is not the expected JSON shape', async () => {
    for (const reply of [{ text: '   ' }, { picture: 'x' }, 'plain']) {
      await expect(ai(vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(reply))).describePicture(input)).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });
});
