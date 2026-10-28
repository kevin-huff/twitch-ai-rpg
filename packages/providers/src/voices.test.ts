import { describe, expect, it, vi } from 'vitest';
import { VoiceListSchema } from '@rpg/contracts';
import { ElevenLabsSpeechProvider, speechCacheKey } from './index.js';

const options = { apiKey: 'private-speech-key', model: 'eleven_v4', voiceId: 'narrator-id', voices: { voice_mara: 'mara-voice' } };
const audio = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
const voice = (id: string, extra: Record<string, unknown> = {}) => ({ voice_id: id, name: `Name ${id}`, category: 'premade', labels: {}, preview_url: null, high_quality_base_model_ids: [], ...extra });

describe('ElevenLabs voice list', () => {
  it('follows pages and sends the key without following redirects', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ voices: [voice('one')], has_more: true, next_page_token: 'tok 2' }))
      .mockResolvedValueOnce(Response.json({ voices: [voice('two')], has_more: false, next_page_token: null }));
    const list = await new ElevenLabsSpeechProvider({ ...options, fetch: fetchMock }).listVoices();
    expect(list.voices.map((entry) => entry.id)).toEqual(['eleven:one', 'eleven:two']);
    expect(list.reason).toBeUndefined();
    expect(VoiceListSchema.safeParse(list).success).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.elevenlabs.io/v2/voices?page_size=100');
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://api.elevenlabs.io/v2/voices?page_size=100&next_page_token=tok%202');
    const init = fetchMock.mock.calls[0][1];
    expect(new Headers(init?.headers).get('xi-api-key')).toBe('private-speech-key');
    expect(init?.redirect).toBe('error');
  });

  it('maps groups, summaries, previews and the tuned flag', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ voices: [
      voice('c', { category: 'cloned', labels: { gender: 'female', age: 'middle_aged', accent: 'american', descriptive: 'warm_and_low' }, preview_url: 'https://example.invalid/c.mp3', high_quality_base_model_ids: ['eleven_v4'] }),
      voice('p', { category: 'professional', labels: { accent: 'irish', gender: 'male' }, preview_url: 'not a url' }),
      voice('g', { category: 'generated', labels: null, preview_url: undefined, high_quality_base_model_ids: ['other'] }),
      voice('s', { category: 'premade', labels: { use_case: 'ignored' } }),
      voice('bad id!'),
    ], has_more: false }));
    const list = await new ElevenLabsSpeechProvider({ ...options, fetch: fetchMock }).listVoices();
    expect(list.voices).toEqual([
      { id: 'eleven:c', name: 'Name c', group: 'clone', summary: 'female · middle aged · american · warm and low', previewUrl: 'https://example.invalid/c.mp3', tuned: true },
      { id: 'eleven:p', name: 'Name p', group: 'added', summary: 'male · irish', previewUrl: null, tuned: false },
      { id: 'eleven:g', name: 'Name g', group: 'added', summary: '', previewUrl: null, tuned: false },
      { id: 'eleven:s', name: 'Name s', group: 'standard', summary: '', previewUrl: null, tuned: false },
    ]);
  });

  it('leaves out the narrator voice', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ voices: [voice('narrator-id'), voice('other')], has_more: false }));
    const list = await new ElevenLabsSpeechProvider({ ...options, fetch: fetchMock }).listVoices();
    expect(list.voices.map((entry) => entry.id)).toEqual(['eleven:other']);
  });

  it('turns a refusal, a network failure, a bad body and a looping token into an empty list with a reason', async () => {
    const refused = await new ElevenLabsSpeechProvider({ ...options, fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('private-speech-key', { status: 401 })) }).listVoices();
    expect(refused).toEqual({ voices: [], reason: 'ElevenLabs refused the voice list (HTTP 401). Everyone keeps the narrator.' });
    const down = await new ElevenLabsSpeechProvider({ ...options, fetch: vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')) }).listVoices();
    expect(down.voices).toEqual([]);
    expect(down.reason).toContain('could not be reached');
    const bad = await new ElevenLabsSpeechProvider({ ...options, fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ nothing: true })) }).listVoices();
    expect(bad.voices).toEqual([]);
    expect(bad.reason).toContain('could not read');
    const text = await new ElevenLabsSpeechProvider({ ...options, fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('not json')) }).listVoices();
    expect(text.voices).toEqual([]);
    expect(text.reason).toContain('could not read');
    const loop = await new ElevenLabsSpeechProvider({ ...options, fetch: vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ voices: [voice('x')], has_more: true, next_page_token: 'same' })) }).listVoices();
    expect(loop.voices).toEqual([]);
    expect(loop.reason).toContain('never ends');
    for (const result of [refused, down, bad, text, loop]) expect(result.reason).not.toContain('private-speech-key');
  });

  it('gives up with a reason when the request times out', async () => {
    const list = await new ElevenLabsSpeechProvider({ ...options, timeoutMs: 15, fetch: vi.fn<typeof fetch>().mockImplementation(async () => new Promise<Response>(() => {})) }).listVoices();
    expect(list.voices).toEqual([]);
    expect(list.reason).toContain('too long');
  });
});

describe('ElevenLabs eleven: references', () => {
  it('speaks an eleven: reference with that voice directly', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => audio());
    const provider = new ElevenLabsSpeechProvider({ ...options, fetch: fetchMock });
    await provider.synthesize({ text: '[quietly] Hello.', voiceProfileId: 'eleven:abc_DEF-1' });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.elevenlabs.io/v1/text-to-speech/abc_DEF-1?output_format=mp3_44100_128');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ text: '[quietly] Hello.', model_id: 'eleven_v4' });
  });

  it('keeps the mapping and the narrator fallback for logical values', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => audio());
    const provider = new ElevenLabsSpeechProvider({ ...options, fetch: fetchMock });
    await provider.synthesize({ text: 'Hello.', voiceProfileId: 'voice_mara' });
    await provider.synthesize({ text: 'Hello.', voiceProfileId: 'voice_unmapped' });
    await provider.synthesize({ text: 'Hello.', voiceProfileId: 'eleven:' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/mara-voice?');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/narrator-id?');
    expect(String(fetchMock.mock.calls[2][0])).toContain('/narrator-id?');
  });

  it('keys cached audio differently for different voices', () => {
    const key = { sessionId: 'one', text: 'Hello.', provider: 'elevenlabs', model: 'eleven_v4', voiceId: 'abc', delivery: 'neutral' };
    expect(speechCacheKey({ ...key, voiceId: 'abd' })).not.toBe(speechCacheKey(key));
  });
});
