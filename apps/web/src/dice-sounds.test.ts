import { describe, expect, it, vi } from 'vitest';
import type { Roll } from '@rpg/contracts';
import { diceSchedule } from './dice-moment';
import { createDiceSounds, diceSoundEvents, momentVolume, renderSound, type SoundEvent, type SoundKind } from './dice-sounds';

function roll(over: Partial<Roll> = {}): Roll {
  return { id: 'r1', contractId: 'k', contractVersion: 1, actorCharacterId: 'c1', faces: [3, 4], trait: 'force', traitModifier: 0, edge: 0, total: 7, band: 'costly', ...over } as Roll;
}
const plan = (events: SoundEvent[]) => events.map(event => `${event.at} ${event.kind}`);

class FakeParam {
  value = 0;
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}
function fakeContext(state: 'running' | 'suspended' = 'running') {
  const started: number[] = [];
  const stopped: number[] = [];
  const node = () => ({ connect: vi.fn((target: unknown) => target), disconnect: vi.fn() });
  const source = () => ({ ...node(), start: vi.fn((when: number) => started.push(when)), stop: vi.fn((when: number) => stopped.push(when)) });
  const gains: { disconnect: ReturnType<typeof vi.fn> }[] = [];
  const context = {
    currentTime: 10, state, sampleRate: 48000, destination: node(),
    createGain: () => { const gain = { ...node(), gain: new FakeParam() }; gains.push(gain); return gain; },
    createOscillator: () => ({ ...source(), type: 'square', frequency: new FakeParam() }),
    createBufferSource: () => ({ ...source(), buffer: null }),
    createBiquadFilter: () => ({ ...node(), type: 'lowpass', frequency: new FakeParam(), Q: new FakeParam() }),
    createBuffer: (_channels: number, length: number, sampleRate: number) => ({ length, sampleRate, getChannelData: () => new Float32Array(length) }),
    createDynamicsCompressor: () => ({ ...node(), threshold: new FakeParam(), knee: new FakeParam(), ratio: new FakeParam(), attack: new FakeParam(), release: new FakeParam() }),
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  return { context: context as unknown as AudioContext, started, stopped, gains };
}

describe('diceSoundEvents', () => {
  it('lists rattles, bounces, clacks, count blips, the verdict jingle and the settle for one roll', () => {
    expect(plan(diceSoundEvents(diceSchedule([roll()])))).toEqual([
      '160 rattle', '280 rattle', '400 rattle', '520 bounce', '640 bounce', '760 bounce', '880 bounce',
      '940 clack', '1060 clack', '1180 count', '1420 costly', '2920 settle',
    ]);
  });

  it('blips once per count step, rising', () => {
    const events = diceSoundEvents(diceSchedule([roll({ faces: [4, 5], traitModifier: 2, edge: 1, total: 12, band: 'clean' })]));
    expect(events.filter(event => event.kind === 'count').map(event => event.step)).toEqual([0, 1, 2, 3]);
    expect(events.at(-2)?.kind).toBe('clean');
  });

  it('drops the rattle above four rolls', () => {
    const five = Array.from({ length: 5 }, (_, i) => roll({ id: `r${i}` }));
    const events = diceSoundEvents(diceSchedule(five));
    expect(events.some(event => event.kind === 'rattle')).toBe(false);
    expect(events.filter(event => event.kind === 'clack')).toHaveLength(10);
  });

  it('adds heartbeats while a last chance teeters and picks its fanfare or bell', () => {
    const through = diceSoundEvents(diceSchedule([roll({ faces: [4, 5], total: 9, band: 'costly', lastChance: true })]));
    expect(plan(through.filter(event => event.kind === 'heartbeat'))).toEqual(['1060 heartbeat', '1360 heartbeat']);
    expect(through.some(event => event.kind === 'pulls-through')).toBe(true);
    const dies = diceSoundEvents(diceSchedule([roll({ faces: [1, 3], total: 4, band: 'setback', lastChance: true })]));
    expect(dies.some(event => event.kind === 'dies')).toBe(true);
  });

  it('gives each band its own jingle', () => {
    const kind = (band: Roll['band'], faces: [number, number]) => diceSoundEvents(diceSchedule([roll({ band, faces })])).at(-2)?.kind;
    expect([kind('clean', [6, 6]), kind('costly', [4, 4]), kind('setback', [2, 2]), kind('critical', [1, 1])]).toEqual(['clean', 'costly', 'setback', 'critical']);
  });
});

describe('momentVolume', () => {
  it('keeps up to four rolls at full volume and softens crowded rounds so they do not pile up', () => {
    expect([1, 2, 4].map(momentVolume)).toEqual([1, 1, 1]);
    expect(momentVolume(9)).toBeCloseTo(2 / 3);
    expect(momentVolume(12)).toBeCloseTo(Math.sqrt(4 / 12));
  });
});

describe('renderSound', () => {
  it('renders every kind of sound on the audio graph, starting at its time', () => {
    const kinds: SoundKind[] = ['rattle', 'bounce', 'clack', 'count', 'clean', 'costly', 'setback', 'critical', 'heartbeat', 'pulls-through', 'dies', 'settle'];
    for (const kind of kinds) {
      const { context, started, stopped } = fakeContext();
      const noise = context.createBuffer(1, 48000, 48000);
      renderSound(context, context.destination, { at: 0, kind, step: 1, seed: 0.5 }, 12, noise);
      expect(started.length, kind).toBeGreaterThan(0);
      expect(Math.min(...started), kind).toBeCloseTo(12);
      expect(Math.min(...stopped), kind).toBeGreaterThan(12);
    }
  });
});

describe('createDiceSounds', () => {
  const events: SoundEvent[] = [{ at: 160, kind: 'rattle', seed: 0.1 }, { at: 520, kind: 'bounce' }, { at: 940, kind: 'clack' }];

  it('schedules each event on the audio clock from the moment start, skipping ones already past', () => {
    const { context } = fakeContext();
    const render = vi.fn();
    const sounds = createDiceSounds({ makeContext: () => context, render });
    sounds.play(events, 500);
    expect(render.mock.calls.map(call => [(call[2] as SoundEvent).kind, call[3]])).toEqual([['bounce', 10.02], ['clack', 10.44]]);
  });

  it('stops everything scheduled at once', () => {
    const { context, gains } = fakeContext();
    const sounds = createDiceSounds({ makeContext: () => context, render: vi.fn() });
    sounds.play(events, 0);
    const master = gains[0]!;
    sounds.stop();
    expect(master.disconnect).toHaveBeenCalled();
  });

  it('lets go of each round\'s limiter, so a long show does not pile up audio nodes', () => {
    const { context } = fakeContext();
    const limiters: { disconnect: ReturnType<typeof vi.fn> }[] = [];
    const make = context.createDynamicsCompressor.bind(context);
    (context as unknown as { createDynamicsCompressor: () => unknown }).createDynamicsCompressor = () => {
      const node = make() as unknown as { disconnect: ReturnType<typeof vi.fn> };
      limiters.push(node);
      return node;
    };
    const sounds = createDiceSounds({ makeContext: () => context, render: vi.fn() });
    sounds.play(events, 0);
    sounds.play(events, 0);
    expect(limiters).toHaveLength(2);
    expect(limiters[0]!.disconnect).toHaveBeenCalled();
    sounds.stop();
    expect(limiters[1]!.disconnect).toHaveBeenCalled();
  });

  it('stays silent, without throwing, when the context is suspended or creating it fails', () => {
    const suspended = fakeContext('suspended');
    const render = vi.fn();
    const sleepy = createDiceSounds({ makeContext: () => suspended.context, render });
    expect(() => sleepy.play(events, 0)).not.toThrow();
    expect(render).not.toHaveBeenCalled();
    expect((suspended.context as unknown as { resume: ReturnType<typeof vi.fn> }).resume).toHaveBeenCalled();
    const broken = createDiceSounds({ makeContext: () => { throw new Error('no audio'); }, render });
    expect(() => broken.play(events, 0)).not.toThrow();
    expect(() => broken.stop()).not.toThrow();
    expect(render).not.toHaveBeenCalled();
  });

  it('scales the master level with the volume', () => {
    const { context, gains } = fakeContext();
    createDiceSounds({ makeContext: () => context, render: vi.fn() }).play(events, 0, 0.5);
    // The master level (0.9, set by measuring against narration clips) times the page's volume.
    expect((gains[0] as unknown as { gain: FakeParam }).gain.value).toBeCloseTo(0.45);
  });
});
