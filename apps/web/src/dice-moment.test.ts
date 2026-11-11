import { describe, expect, it } from 'vitest';
import type { Roll } from '@rpg/contracts';
import { diceSchedule, flickerFaces, momentLengthMs, momentSize, momentWindow, shouldPlayMoment, staggerMs } from './dice-moment';

function roll(over: Partial<Roll> = {}): Roll {
  return { id: 'r1', contractId: 'k1', contractVersion: 1, actorCharacterId: 'c1', faces: [3, 4], trait: 'force', traitModifier: 0, edge: 0, total: 7, band: 'costly', ...over } as Roll;
}

describe('diceSchedule', () => {
  it('times one plain roll from throw to end', () => {
    const s = diceSchedule([roll({ faces: [3, 4], traitModifier: 0, edge: 0, total: 7, band: 'costly' })]);
    const r = s.rolls[0]!;
    expect(r.start).toBe(160);
    expect(r.dice[0]).toEqual({ throwAt: 160, landAt: 940, teeterMs: 0 });
    expect(r.dice[1]).toEqual({ throwAt: 280, landAt: 1060, teeterMs: 0 });
    expect(r.countAt).toBe(1180);
    expect(r.steps).toEqual([{ at: 1180, value: 7, chip: null }]);
    expect(r.verdictAt).toBe(1420);
    expect(s.settleAt).toBe(2920);
    expect(s.revealAt).toBe(3280);
    expect(s.endAt).toBe(3320);
  });

  it('ticks the trait points, then the Edge point, up to the total', () => {
    const r = diceSchedule([roll({ faces: [4, 5], traitModifier: 2, edge: 1, total: 12, band: 'clean' })]).rolls[0]!;
    expect(r.steps.map(step => [step.value, step.chip])).toEqual([[9, null], [10, 'trait'], [11, null], [12, 'edge']]);
    expect(r.steps.map(step => step.at - r.countAt)).toEqual([0, 120, 240, 360]);
    expect(r.verdictAt).toBe(r.countAt + 600);
  });

  it('shows the Edge chip on the first tick when there is no trait bonus', () => {
    const r = diceSchedule([roll({ faces: [2, 5], traitModifier: 0, edge: 1, total: 8, band: 'costly' })]).rolls[0]!;
    expect(r.steps.map(step => [step.value, step.chip])).toEqual([[7, null], [8, 'edge']]);
  });

  it('teeters the second die of a last chance and adds no ticks', () => {
    const r = diceSchedule([roll({ faces: [5, 4], traitModifier: 2, edge: 1, total: 9, band: 'costly', lastChance: true })]).rolls[0]!;
    expect(r.dice[1]).toEqual({ throwAt: 280, landAt: 1660, teeterMs: 600 });
    expect(r.steps).toEqual([{ at: 1780, value: 9, chip: null }]);
    expect([r.verdict, r.flourish]).toEqual(['Pulls through', 'sparkle']);
  });

  it('names each verdict and flourish', () => {
    const read = (over: Partial<Roll>) => {
      const r = diceSchedule([roll(over)]).rolls[0]!;
      return [r.verdict, r.flourish];
    };
    expect(read({ band: 'clean', total: 11, faces: [5, 6] })).toEqual(['Clean success', 'sparkle']);
    expect(read({ band: 'costly' })).toEqual(['Success with a cost', 'flash']);
    expect(read({ band: 'setback', faces: [1, 3], total: 4 })).toEqual(['Setback', 'jolt']);
    expect(read({ band: 'critical', faces: [1, 1], total: 2 })).toEqual(['Critical failure', 'crack']);
    expect(read({ band: 'clean', faces: [6, 6], total: 12, lastChance: true })).toEqual(['Pulls through', 'sparkle']);
    expect(read({ band: 'setback', faces: [2, 3], total: 5, lastChance: true })).toEqual(['Dies', 'dark']);
    expect(read({ band: 'critical', faces: [1, 1], total: 2, lastChance: true })).toEqual(['Dies', 'dark']);
  });

  it('starts each roll one stagger after the one before it', () => {
    const s = diceSchedule([roll({ id: 'a' }), roll({ id: 'b' }), roll({ id: 'c' })]);
    expect(s.rolls.map(r => r.start)).toEqual([160, 310, 460]);
    expect(s.rolls.map(r => r.roll.id)).toEqual(['a', 'b', 'c']);
  });

  it('settles after the latest verdict, even when an earlier roll finishes last', () => {
    const s = diceSchedule([roll({ id: 'a', lastChance: true, band: 'setback', faces: [2, 2], total: 4 }), roll({ id: 'b' })]);
    const [first, second] = s.rolls;
    expect(first!.verdictAt).toBeGreaterThan(second!.verdictAt);
    expect(s.settleAt).toBe(first!.verdictAt + 1500);
    expect(s.endAt).toBe(s.settleAt + 400);
  });

  it('staggers rolls by count', () => {
    expect([1, 6, 7, 8, 9, 10, 12].map(staggerMs)).toEqual([150, 150, 140, 130, 120, 110, 110]);
  });

  it('sizes the grid by count', () => {
    expect([1, 2, 4, 6, 9, 12].map(momentSize)).toEqual([
      { columns: 1, rows: 1, die: 128 }, { columns: 2, rows: 1, die: 112 }, { columns: 2, rows: 2, die: 80 },
      { columns: 3, rows: 2, die: 64 }, { columns: 3, rows: 3, die: 48 }, { columns: 4, rows: 3, die: 48 },
    ]);
    expect(momentSize(3)).toEqual({ columns: 2, rows: 2, die: 80 });
    expect(momentSize(5)).toEqual({ columns: 3, rows: 2, die: 64 });
    expect(momentSize(7)).toEqual({ columns: 3, rows: 3, die: 48 });
    expect(momentSize(10)).toEqual({ columns: 4, rows: 3, die: 48 });
  });

  it('ends twelve rolls with every bonus by about five seconds', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => roll({ id: `r${i}`, faces: [4, 4], traitModifier: 2, edge: 1, total: 11, band: 'clean' }));
    expect(momentLengthMs(twelve)).toBe(4890);
  });

  it('gives no moment for no rolls', () => {
    expect(momentLengthMs([])).toBe(0);
    expect(diceSchedule([])).toEqual({ rolls: [], settleAt: 0, revealAt: 0, endAt: 0, size: momentSize(0) });
  });
});

describe('flickerFaces', () => {
  it('repeats the same seeded flicker and never shows a face twice in a row', () => {
    const a = flickerFaces('roll-7', 0, 20);
    expect(a).toEqual(flickerFaces('roll-7', 0, 20));
    expect(a).toHaveLength(20);
    expect(a.every(face => Number.isInteger(face) && face >= 1 && face <= 6)).toBe(true);
    expect(a.every((face, i) => i === 0 || face !== a[i - 1])).toBe(true);
    expect(flickerFaces('roll-7', 1, 20)).not.toEqual(a);
    expect(flickerFaces('roll-8', 0, 20)).not.toEqual(a);
  });
});

describe('shouldPlayMoment', () => {
  const now = Date.parse('2026-11-11T20:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();

  it('plays a fresh beat with rolls, including a server clock up to 10 s ahead', () => {
    expect(shouldPlayMoment({ rolls: [{}], publishedAt: iso(now - 9000) }, now)).toBe(true);
    expect(shouldPlayMoment({ rolls: [{}], publishedAt: iso(now + 5000) }, now)).toBe(true);
    expect(shouldPlayMoment({ rolls: [{}], publishedAt: iso(now - 11000) }, now)).toBe(false);
    expect(shouldPlayMoment({ rolls: [{}], publishedAt: iso(now + 11000) }, now)).toBe(false);
    expect(shouldPlayMoment({ rolls: [], publishedAt: iso(now) }, now)).toBe(false);
    expect(shouldPlayMoment({ rolls: [{}], publishedAt: 'not a date' }, now)).toBe(false);
  });
});

describe('momentWindow', () => {
  it('places the window for each layout', () => {
    expect(momentWindow('overlay')).toEqual({ left: 480, top: 140, width: 960, height: 612 });
    expect(momentWindow('scene')).toEqual({ left: 96, top: 170, width: 1204, height: 630 });
  });
});
