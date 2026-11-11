import { describe, expect, it } from 'vitest';
import { diePose, pipGrid, restX, type Tray } from './dice-pose';
import type { DieTiming } from './dice-moment';

const timing: DieTiming = { throwAt: 1000, landAt: 1780, teeterMs: 0 };
const teetering: DieTiming = { throwAt: 1000, landAt: 2380, teeterMs: 600 };
const flicker = [2, 5, 1, 6, 3, 4, 2, 6, 1, 5, 3, 2, 4, 6, 1, 3, 5, 2, 6, 4, 1, 3, 2, 5];
const tray: Tray = { width: 400, height: 140, die: 80 };
const at = (frame: number, die: DieTiming = timing, slot: 0 | 1 = 0, box: Tray = tray) => diePose(die, 5, flicker, box, slot, die.throwAt + frame * 60);

describe('diePose', () => {
  it('is hidden before its throw and enters from the left of the tray', () => {
    expect(diePose(timing, 5, flicker, tray, 0, 999).visible).toBe(false);
    const first = at(0);
    expect(first.visible).toBe(true);
    expect(first.x).toBe(-80);
    expect(first.y).toBeLessThan(0);
  });

  it('keeps every position on the 4 px grid', () => {
    for (const die of [128, 112, 80, 64, 48, 40, 32]) {
      const box: Tray = { width: die * 4 + 12, height: Math.round(die * 1.75 / 4) * 4, die };
      for (let frame = 0; frame <= 30; frame++) {
        for (const slot of [0, 1] as const) {
          for (const kind of [timing, teetering]) {
            const pose = at(frame, kind, slot, box);
            expect(Math.abs(pose.x) % 4, `x at die ${die}, frame ${frame}`).toBe(0);
            expect(Math.abs(pose.y) % 4, `y at die ${die}, frame ${frame}`).toBe(0);
          }
        }
      }
    }
  });

  it('squashes and kicks dust at contacts and the landing', () => {
    expect([at(6).squash, at(6).dust]).toEqual([true, 0]);
    expect([at(7).squash, at(7).dust]).toEqual([false, 1]);
    expect([at(10).squash, at(10).dust]).toEqual([true, 0]);
    expect(at(12).dust).toBeNull();
    const landing = at(13);
    expect([landing.squash, landing.landed, landing.face, landing.dust]).toEqual([true, true, 5, 0]);
    expect(at(14).dust).toBe(1);
    expect(at(15).dust).toBeNull();
  });

  it('flickers until it lands, then shows the real face at rest', () => {
    for (let frame = 0; frame < 13; frame++) {
      expect(at(frame).face).toBe(flicker[frame]);
      expect(at(frame).landed).toBe(false);
    }
    const rest = at(20);
    expect(rest).toEqual({ visible: true, x: restX(tray, 0), y: tray.height - tray.die, sprite: 'face', squash: false, face: 5, landed: true, dust: null });
    expect(at(20, timing, 1).x).toBe(restX(tray, 1));
  });

  it('touches the floor at each contact and hops lower each time', () => {
    const floor = tray.height - tray.die;
    expect(at(6).y).toBe(floor);
    expect(at(10).y).toBe(floor);
    const firstHop = Math.min(...[7, 8, 9].map(frame => at(frame).y));
    const secondHop = Math.min(...[11, 12].map(frame => at(frame).y));
    expect(firstHop).toBeLessThan(floor);
    expect(secondHop).toBeLessThan(floor);
    expect(secondHop).toBeGreaterThan(firstHop);
  });

  it('spins through the sprite frames while airborne', () => {
    const sprites = [1, 2, 3, 4, 5].map(frame => at(frame).sprite);
    expect(new Set(sprites)).toEqual(new Set(['face', 'edge', 'corner', 'edge2']));
  });

  it('teeters on its corner before a last-chance landing', () => {
    const rest = restX(tray, 1);
    for (let frame = 13; frame <= 22; frame++) {
      const pose = at(frame, teetering, 1);
      expect(pose.sprite).toBe('corner');
      expect(pose.landed).toBe(false);
      expect(Math.abs(pose.x - rest)).toBe(4);
      expect(pose.y).toBe(tray.height - tray.die);
    }
    expect(at(13, teetering, 1).x).not.toBe(at(15, teetering, 1).x);
    const landing = at(23, teetering, 1);
    expect([landing.sprite, landing.squash, landing.landed, landing.face, landing.x]).toEqual(['face', true, true, 5, rest]);
  });
});

describe('restX', () => {
  it('centers the pair with a gap of a quarter die, on the dot grid', () => {
    // Two 80 px dice and a 20 px gap are 180 px; centered in 400 px they start at 110, rounded to the 4 px grid.
    expect(restX(tray, 0)).toBe(112);
    expect(restX(tray, 1)).toBe(212);
  });
});

describe('pipGrid', () => {
  it('lays pips on the dot grid for every size', () => {
    for (const size of [128, 112, 80, 64, 48, 40]) {
      const { pip, columns } = pipGrid(size);
      expect(columns[1]).toBe((size - pip) / 2);
      expect(columns[2] + pip + columns[0]).toBe(size);
      for (const value of [pip, ...columns]) expect(value % 4, `size ${size}`).toBe(0);
    }
    // Big dice get chunky pips; every face, six included, keeps at least a dot between pip rows.
    expect([128, 112, 80, 64, 48, 40].map(size => pipGrid(size).pip)).toEqual([24, 24, 16, 8, 8, 8]);
    for (const size of [128, 112, 80, 64, 48, 40]) {
      const { pip, columns } = pipGrid(size);
      expect(columns[1] - (columns[0] + pip), `size ${size}`).toBeGreaterThanOrEqual(4);
    }
  });
});
