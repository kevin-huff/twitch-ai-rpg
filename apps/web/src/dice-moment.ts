import type { Roll } from '@rpg/contracts';
import { bandLabel, lastChanceResult } from './stage-format';

// The dice moment's timeline. Every time is in milliseconds from the moment's start.
export const FRAME_MS = 60;
export const OPEN_MS = 160;
export const FLIGHT_FRAMES = 13;
export const CONTACT_FRAMES = [6, 10] as const;
export const SECOND_DIE_DELAY_MS = 120;
export const COUNT_DELAY_MS = 120;
export const TICK_MS = 120;
export const VERDICT_DELAY_MS = 240;
export const TEETER_MS = 600;
export const HOLD_MS = 1500;
export const SETTLE_MS = 400;
// Inside the settle: the window starts to close, then the totals land in the strip and the strip shows.
export const CLOSE_AFTER_MS = 240;
export const REVEAL_AFTER_MS = 360;
export const FRESH_MS = 10_000;

const FLIGHT_MS = FLIGHT_FRAMES * FRAME_MS;

export type Flourish = 'sparkle' | 'flash' | 'jolt' | 'crack' | 'dark';
export type DieTiming = { throwAt: number; landAt: number; teeterMs: number };
export type CountStep = { at: number; value: number; chip: 'trait' | 'edge' | null };
export type MomentRoll = {
  roll: Roll;
  start: number;
  dice: [DieTiming, DieTiming];
  countAt: number;
  steps: CountStep[];
  verdictAt: number;
  verdict: string;
  flourish: Flourish;
};
export type MomentSize = { columns: number; rows: number; die: number };
export type DiceSchedule = { rolls: MomentRoll[]; settleAt: number; revealAt: number; endAt: number; size: MomentSize };
export type MomentBox = { left: number; top: number; width: number; height: number };

export function staggerMs(count: number): number {
  return count <= 6 ? 150 : Math.max(110, 150 - 10 * (count - 6));
}

export function momentSize(count: number): MomentSize {
  if (count <= 1) return { columns: 1, rows: 1, die: 128 };
  if (count === 2) return { columns: 2, rows: 1, die: 112 };
  if (count <= 4) return { columns: 2, rows: 2, die: 80 };
  if (count <= 6) return { columns: 3, rows: 2, die: 64 };
  if (count <= 9) return { columns: 3, rows: 3, die: 48 };
  return { columns: 4, rows: 3, die: 48 };
}

// Where the center window sits on the 1920 by 1080 canvas: over the stakes window on the overlay, over the story panel on the scene.
export function momentWindow(layout: 'overlay' | 'scene'): MomentBox {
  if (layout === 'scene') return { left: 96, top: 170, width: 1204, height: 630 };
  return { left: 480, top: 140, width: 960, height: 612 };
}

function flourishOf(roll: Roll): Flourish {
  if (roll.lastChance) return roll.band === 'clean' || roll.band === 'costly' ? 'sparkle' : 'dark';
  if (roll.band === 'clean') return 'sparkle';
  if (roll.band === 'costly') return 'flash';
  if (roll.band === 'critical') return 'crack';
  return 'jolt';
}

function countSteps(roll: Roll, countAt: number): CountStep[] {
  const sum = roll.faces[0] + roll.faces[1];
  const steps: CountStep[] = [{ at: countAt, value: sum, chip: null }];
  if (!roll.lastChance) {
    for (let point = 1; point <= roll.traitModifier; point++) {
      steps.push({ at: countAt + point * TICK_MS, value: sum + point, chip: point === 1 ? 'trait' : null });
    }
    if (roll.edge === 1) steps.push({ at: countAt + (roll.traitModifier + 1) * TICK_MS, value: sum + roll.traitModifier + 1, chip: 'edge' });
  }
  // The server's total is the truth; the count always ends on it.
  steps[steps.length - 1]!.value = roll.total;
  return steps;
}

export function diceSchedule(rolls: readonly Roll[]): DiceSchedule {
  const stagger = staggerMs(rolls.length);
  const scheduled = rolls.map((roll, index): MomentRoll => {
    const start = OPEN_MS + index * stagger;
    const teeterMs = roll.lastChance ? TEETER_MS : 0;
    const secondThrow = start + SECOND_DIE_DELAY_MS;
    const dice: [DieTiming, DieTiming] = [
      { throwAt: start, landAt: start + FLIGHT_MS, teeterMs: 0 },
      { throwAt: secondThrow, landAt: secondThrow + FLIGHT_MS + teeterMs, teeterMs },
    ];
    const countAt = Math.max(dice[0].landAt, dice[1].landAt) + COUNT_DELAY_MS;
    const steps = countSteps(roll, countAt);
    const verdictAt = steps[steps.length - 1]!.at + VERDICT_DELAY_MS;
    const verdict = roll.lastChance ? lastChanceResult(roll.band) : bandLabel(roll.band);
    return { roll, start, dice, countAt, steps, verdictAt, verdict, flourish: flourishOf(roll) };
  });
  if (!scheduled.length) return { rolls: [], settleAt: 0, revealAt: 0, endAt: 0, size: momentSize(0) };
  const settleAt = Math.max(...scheduled.map(entry => entry.verdictAt)) + HOLD_MS;
  return { rolls: scheduled, settleAt, revealAt: settleAt + REVEAL_AFTER_MS, endAt: settleAt + SETTLE_MS, size: momentSize(scheduled.length) };
}

export function momentLengthMs(rolls: readonly Roll[]): number {
  return diceSchedule(rolls).endAt;
}

function hash(text: string): number {
  let value = 2166136261;
  for (const char of text) {
    value ^= char.codePointAt(0)!;
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

// A small seeded generator (mulberry32), so every page draws the same flicker and the same rattle for a roll.
export function seededRandom(seed: string): () => number {
  let state = hash(seed);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function flickerFaces(rollId: string, die: 0 | 1, count: number): number[] {
  const random = seededRandom(`${rollId}:${die}`);
  const faces: number[] = [];
  for (let i = 0; i < count; i++) {
    const previous = faces[i - 1];
    let face = 1 + Math.floor(random() * (previous ? 5 : 6));
    if (previous && face >= previous) face += 1;
    faces.push(face);
  }
  return faces;
}

export function shouldPlayMoment(beat: { rolls: readonly unknown[]; publishedAt: string }, now: number): boolean {
  const publishedAt = Date.parse(beat.publishedAt);
  return beat.rolls.length > 0 && Number.isFinite(publishedAt) && Math.abs(now - publishedAt) <= FRESH_MS;
}
