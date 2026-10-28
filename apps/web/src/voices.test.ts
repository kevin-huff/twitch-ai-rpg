import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_VOICES } from '@rpg/contracts';

const voicesMock = vi.hoisted(() => ({ fn: vi.fn() as ReturnType<typeof vi.fn> | undefined }));
vi.mock('./api', () => ({ api: { get voices() { return voicesMock.fn; } } }));

const REASON = 'The voice list could not be loaded. The narrator reads every line.';

async function fresh() {
  vi.resetModules();
  return import('./voices');
}

beforeEach(() => { voicesMock.fn = vi.fn(); });

describe('loadVoices', () => {
  it('shares one request and keeps a success', async () => {
    voicesMock.fn!.mockResolvedValue({ voices: FAKE_VOICES });
    const { loadVoices } = await fresh();
    const [a, b] = await Promise.all([loadVoices(), loadVoices()]);
    expect(a).toEqual({ voices: FAKE_VOICES });
    expect(b).toBe(a);
    expect(await loadVoices()).toBe(a);
    expect(voicesMock.fn).toHaveBeenCalledTimes(1);
  });

  it('returns the reason on a failure and asks again next time', async () => {
    voicesMock.fn!.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ voices: FAKE_VOICES });
    const { loadVoices } = await fresh();
    expect(await loadVoices()).toEqual({ voices: [], reason: REASON });
    expect(await loadVoices()).toEqual({ voices: FAKE_VOICES });
    expect(voicesMock.fn).toHaveBeenCalledTimes(2);
  });

  it('never keeps a list that came with a reason and asks again', async () => {
    const refused = { voices: [], reason: 'ElevenLabs refused the voice list (HTTP 503). Everyone keeps the narrator.' };
    voicesMock.fn!.mockResolvedValueOnce(refused).mockResolvedValueOnce({ voices: FAKE_VOICES });
    const { loadVoices } = await fresh();
    expect(await loadVoices()).toEqual(refused);
    expect(await loadVoices()).toEqual({ voices: FAKE_VOICES });
    expect(await loadVoices()).toEqual({ voices: FAKE_VOICES });
    expect(voicesMock.fn).toHaveBeenCalledTimes(2);
  });

  it('returns the reason when api.voices is missing or throws synchronously', async () => {
    voicesMock.fn = undefined;
    const { loadVoices } = await fresh();
    expect(await loadVoices()).toEqual({ voices: [], reason: REASON });
    voicesMock.fn = vi.fn(() => { throw new Error('sync'); });
    expect(await loadVoices()).toEqual({ voices: [], reason: REASON });
    expect(voicesMock.fn).toHaveBeenCalledTimes(1);
  });
});

describe('npcVoicePick', () => {
  it('returns only eleven: references', async () => {
    const { npcVoicePick } = await fresh();
    expect(npcVoicePick('eleven:fake-ada')).toBe('eleven:fake-ada');
    expect(npcVoicePick('voice_mara')).toBeNull();
    expect(npcVoicePick('narrator')).toBeNull();
  });
});

describe('npcVoiceValue', () => {
  it('keeps an untouched logical value, resets an eleven: value on narrator, returns a pick', async () => {
    const { npcVoiceValue } = await fresh();
    expect(npcVoiceValue(null, 'voice_mara')).toBe('voice_mara');
    expect(npcVoiceValue(null, 'eleven:fake-ada')).toBe('narrator');
    expect(npcVoiceValue('eleven:fake-bram', 'voice_mara')).toBe('eleven:fake-bram');
  });
});

describe('voiceName', () => {
  it('names listed, narrator, logical and unlisted voices', async () => {
    const { voiceName } = await fresh();
    expect(voiceName('eleven:fake-ada', FAKE_VOICES, 'Narrator')).toBe('Ada');
    expect(voiceName(null, FAKE_VOICES, 'Narrator')).toBe('Narrator');
    expect(voiceName('voice_mara', FAKE_VOICES, 'Narrator')).toBe('Narrator');
    expect(voiceName('eleven:gone', FAKE_VOICES, 'Narrator')).toBe('Unlisted voice');
  });
});
