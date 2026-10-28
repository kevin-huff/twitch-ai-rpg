// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBeatAudio, type BeatClip } from './beat-audio';

const asset = (digit: string) => `/api/sessions/s1/audio/assets/${digit.repeat(64)}`;
const manifest = (beatId: string) => ({ beatId, segments: [
  { id: 'n1', text: 'The bell rings.', speaker: 'Narrator', voiceProfileId: 'voice_narrator', url: asset('a') },
  { id: 'n2', text: 'Nobody moves.', speaker: 'Narrator', voiceProfileId: 'voice_narrator', url: asset('b') },
] });

class FakeClip {
  src = ''; onended: (() => void) | null = null; onerror: (() => void) | null = null;
  played: string[] = []; pauses = 0; blockNext = false;
  play() { if (this.blockNext) { this.blockNext = false; return Promise.reject(new Error('NotAllowedError')); } this.played.push(this.src); return Promise.resolve(); }
  pause() { this.pauses++; }
}

function serve(body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('createBeatAudio', () => {
  it('plays every clip of a part in order, then stops by itself', async () => {
    serve({ status: 'ready', manifest: manifest('b1') });
    const clip = new FakeClip();
    const sound = createBeatAudio('s1', () => clip as unknown as BeatClip);
    await sound.play('b1');
    expect(sound.state.beatId).toBe('b1');
    expect(clip.played).toEqual([asset('a')]);
    clip.onended!();
    expect(clip.played).toEqual([asset('a'), asset('b')]);
    clip.onended!();
    expect(sound.state.beatId).toBeNull();
  });

  it('skips a clip that cannot load and plays the rest', async () => {
    serve({ status: 'ready', manifest: manifest('b1') });
    const clip = new FakeClip();
    const sound = createBeatAudio('s1', () => clip as unknown as BeatClip);
    await sound.play('b1');
    clip.onerror!();
    expect(clip.played).toEqual([asset('a'), asset('b')]);
  });

  it('stops on request and plays again from the start without loading twice', async () => {
    const fetchMock = serve({ status: 'ready', manifest: manifest('b1') });
    const clip = new FakeClip();
    const sound = createBeatAudio('s1', () => clip as unknown as BeatClip);
    await sound.play('b1');
    clip.onended!();
    sound.stop();
    expect(sound.state.beatId).toBeNull();
    expect(clip.pauses).toBe(1);
    expect(clip.onended).toBeNull();
    await sound.play('b1');
    expect(clip.played).toEqual([asset('a'), asset('b'), asset('a')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('says so when a part has no voices, and when the browser blocks the sound', async () => {
    serve({ status: 'missing' });
    const silent = createBeatAudio('s1', () => new FakeClip() as unknown as BeatClip);
    await silent.play('b2');
    expect(silent.state).toMatchObject({ beatId: null, errorBeatId: 'b2', error: 'This part has no voices yet.' });
    serve({ status: 'ready', manifest: manifest('b1') });
    const clip = new FakeClip();
    clip.blockNext = true;
    const blocked = createBeatAudio('s1', () => clip as unknown as BeatClip);
    await blocked.play('b1');
    await Promise.resolve();
    expect(blocked.state).toMatchObject({ beatId: null, errorBeatId: 'b1', error: 'This browser blocked the sound. Press Play again.' });
    await blocked.play('b1');
    expect(blocked.state.beatId).toBe('b1');
    expect(clip.played).toEqual([asset('a')]);
  });
});
