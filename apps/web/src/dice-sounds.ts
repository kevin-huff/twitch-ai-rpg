import { CONTACT_FRAMES, FLIGHT_FRAMES, FRAME_MS, seededRandom, type DiceSchedule } from './dice-moment';

// The dice moment's sounds, made on the page with the Web Audio API: square, triangle and sawtooth notes and
// filtered noise, like a 16-bit console's sound chip. No audio files. Every sound is scheduled from the moment's timeline.
export type SoundKind = 'rattle' | 'bounce' | 'clack' | 'count' | 'clean' | 'costly' | 'setback' | 'critical' | 'heartbeat' | 'pulls-through' | 'dies' | 'settle';
export type SoundEvent = { at: number; kind: SoundKind; step?: number; seed?: number };

const RATTLE_ROLLS = 4;
const RATTLE_GAP_MS = 120;
const HEARTBEAT_GAP_MS = 300;
const MASTER_LEVEL = 0.9;

// Up to four rolls play at full volume; a crowded round is softened so its many clacks and jingles do not pile up.
export function momentVolume(rollCount: number): number {
  return Math.min(1, Math.sqrt(4 / Math.max(1, rollCount)));
}

export function diceSoundEvents(schedule: DiceSchedule): SoundEvent[] {
  const events: SoundEvent[] = [];
  const rattle = schedule.rolls.length <= RATTLE_ROLLS;
  for (const entry of schedule.rolls) {
    if (rattle) {
      const random = seededRandom(`${entry.roll.id}:rattle`);
      for (let k = 0; k < 3; k++) events.push({ at: entry.dice[0].throwAt + k * RATTLE_GAP_MS, kind: 'rattle', seed: random() });
    }
    for (const die of entry.dice) {
      for (const frame of CONTACT_FRAMES) events.push({ at: die.throwAt + frame * FRAME_MS, kind: 'bounce' });
      if (die.teeterMs) {
        const teeter = die.throwAt + FLIGHT_FRAMES * FRAME_MS;
        events.push({ at: teeter, kind: 'heartbeat' }, { at: teeter + HEARTBEAT_GAP_MS, kind: 'heartbeat' });
      }
      events.push({ at: die.landAt, kind: 'clack' });
    }
    entry.steps.forEach((step, index) => events.push({ at: step.at, kind: 'count', step: index }));
    const verdict: SoundKind = entry.roll.lastChance
      ? (entry.flourish === 'dark' ? 'dies' : 'pulls-through')
      : entry.roll.band === 'clean' ? 'clean' : entry.roll.band === 'costly' ? 'costly' : entry.roll.band === 'critical' ? 'critical' : 'setback';
    events.push({ at: entry.verdictAt, kind: verdict });
  }
  if (schedule.rolls.length) events.push({ at: schedule.settleAt, kind: 'settle' });
  return events.map((event, order) => ({ event, order })).sort((a, b) => a.event.at - b.event.at || a.order - b.order).map(item => item.event);
}

type Shape = OscillatorType;

function note(context: BaseAudioContext, out: AudioNode, when: number, shape: Shape, frequency: number, length: number, level: number, slideTo?: number) {
  const osc = context.createOscillator();
  osc.type = shape;
  osc.frequency.setValueAtTime(frequency, when);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, when + length);
  const amp = context.createGain();
  amp.gain.setValueAtTime(0.0001, when);
  amp.gain.exponentialRampToValueAtTime(level, when + 0.003);
  amp.gain.exponentialRampToValueAtTime(0.0001, when + length);
  osc.connect(amp);
  amp.connect(out);
  osc.start(when);
  osc.stop(when + length + 0.02);
}

function hiss(context: BaseAudioContext, out: AudioNode, noise: AudioBuffer, when: number, filter: BiquadFilterType, frequency: number, length: number, level: number) {
  const source = context.createBufferSource();
  source.buffer = noise;
  const shape = context.createBiquadFilter();
  shape.type = filter;
  shape.frequency.setValueAtTime(frequency, when);
  shape.Q.setValueAtTime(1.2, when);
  const amp = context.createGain();
  amp.gain.setValueAtTime(0.0001, when);
  amp.gain.exponentialRampToValueAtTime(level, when + 0.002);
  amp.gain.exponentialRampToValueAtTime(0.0001, when + length);
  source.connect(shape);
  shape.connect(amp);
  amp.connect(out);
  source.start(when);
  source.stop(when + length + 0.02);
}

function melody(context: BaseAudioContext, out: AudioNode, when: number, shape: Shape, notes: number[], gap: number, length: number, level: number, last = length) {
  notes.forEach((frequency, i) => note(context, out, when + i * gap, shape, frequency, i === notes.length - 1 ? last : length, level));
}

// Draws one sound into the audio graph, starting at `when` on the context's clock.
export function renderSound(context: BaseAudioContext, out: AudioNode, event: SoundEvent, when: number, noise: AudioBuffer): void {
  switch (event.kind) {
    case 'rattle':
      note(context, out, when, 'square', 700 + (event.seed ?? 0.5) * 600, 0.025, 0.11);
      return;
    case 'bounce':
      hiss(context, out, noise, when, 'highpass', 3000, 0.02, 0.1);
      note(context, out, when, 'square', 240, 0.015, 0.04);
      return;
    case 'clack':
      hiss(context, out, noise, when, 'bandpass', 2400, 0.035, 0.6);
      note(context, out, when, 'square', 170, 0.04, 0.28, 120);
      return;
    case 'count':
      note(context, out, when, 'square', 880 * 2 ** (((event.step ?? 0) * 2) / 12), 0.045, 0.14);
      return;
    case 'clean':
      melody(context, out, when, 'square', [1047, 1319, 1568, 2093], 0.055, 0.07, 0.2, 0.14);
      return;
    case 'costly':
      melody(context, out, when, 'triangle', [784, 659], 0.09, 0.1, 0.45);
      return;
    case 'setback':
      note(context, out, when, 'square', 659, 0.11, 0.2, 620);
      note(context, out, when + 0.11, 'square', 494, 0.14, 0.2, 440);
      return;
    case 'critical':
      hiss(context, out, noise, when, 'lowpass', 1200, 0.18, 0.5);
      note(context, out, when, 'sawtooth', 110, 0.26, 0.26, 55);
      return;
    case 'heartbeat':
      note(context, out, when, 'triangle', 80, 0.08, 0.4);
      note(context, out, when + 0.14, 'triangle', 70, 0.08, 0.32);
      return;
    case 'pulls-through':
      melody(context, out, when, 'square', [523, 659, 784, 1047, 1319], 0.06, 0.07, 0.2, 0.22);
      return;
    case 'dies':
      note(context, out, when, 'triangle', 98, 0.9, 0.3);
      note(context, out, when, 'sine', 196, 0.6, 0.12);
      return;
    case 'settle':
      note(context, out, when, 'square', 880, 0.12, 0.06, 440);
      return;
  }
}

export function diceNoise(context: BaseAudioContext): AudioBuffer {
  const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const data = buffer.getChannelData(0);
  const random = seededRandom('dice-noise');
  for (let i = 0; i < data.length; i++) data[i] = random() * 2 - 1;
  return buffer;
}

// The output every dice sound goes through: a master level into a compressor used as a limiter, so many rolls at once
// cannot clip. close() unplugs both, which silences everything scheduled into it and leaves no node behind.
export function diceOutput(context: BaseAudioContext, volume = 1): { input: GainNode; close(): void } {
  const level = context.createGain();
  level.gain.value = MASTER_LEVEL * volume;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;
  level.connect(limiter);
  limiter.connect(context.destination);
  return {
    input: level,
    close() {
      for (const node of [level, limiter]) {
        try { node.disconnect(); } catch { /* Already unplugged. */ }
      }
    },
  };
}

// One player per page. It plays a moment's sounds from wherever the moment has reached, and stops them all at once.
export function createDiceSounds(options: { makeContext?: () => AudioContext; render?: typeof renderSound } = {}) {
  const makeContext = options.makeContext ?? (() => new AudioContext());
  const render = options.render ?? renderSound;
  let context: AudioContext | null = null;
  let output: { input: GainNode; close(): void } | null = null;
  let noise: AudioBuffer | null = null;
  let unavailable = false;

  function audio(): AudioContext | null {
    if (unavailable) return null;
    if (!context) {
      try { context = makeContext(); } catch { unavailable = true; return null; }
    }
    return context;
  }

  function stop() {
    output?.close();
    output = null;
  }

  function play(events: SoundEvent[], elapsedMs: number, volume = 1) {
    const ctx = audio();
    if (!ctx) return;
    try {
      // A browser that has not allowed sound yet stays silent for this moment rather than playing it late.
      if (ctx.state !== 'running') { void ctx.resume?.().catch(() => {}); return; }
      stop();
      output = diceOutput(ctx, volume);
      noise ??= diceNoise(ctx);
      for (const event of events) {
        if (event.at < elapsedMs - 20) continue;
        render(ctx, output.input, event, ctx.currentTime + (event.at - elapsedMs) / 1000, noise);
      }
    } catch {
      // A failing audio graph must never break the stream page.
      stop();
    }
  }

  function dispose() {
    stop();
    try { void context?.close?.(); } catch { /* Closing is best effort. */ }
    context = null;
  }

  return { play, stop, dispose };
}
