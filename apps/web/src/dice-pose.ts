import { CONTACT_FRAMES, FLIGHT_FRAMES, FRAME_MS, type DieTiming } from './dice-moment';

export type Sprite = 'face' | 'edge' | 'corner' | 'edge2';
export type Tray = { width: number; height: number; die: number };
export type DiePose = { visible: boolean; x: number; y: number; sprite: Sprite; squash: boolean; face: number; landed: boolean; dust: 0 | 1 | null };

// The nine pip cells of a face, numbered left to right and top to bottom.
export const PIPS: Record<number, number[]> = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
};

const SPRITES: Sprite[] = ['face', 'edge', 'corner', 'edge2'];
const GRIDS: Record<number, { pip: number; pad: number }> = {
  128: { pip: 24, pad: 16 }, 112: { pip: 24, pad: 12 }, 80: { pip: 16, pad: 12 }, 64: { pip: 8, pad: 12 }, 48: { pip: 8, pad: 8 }, 40: { pip: 8, pad: 4 },
};

const dot = (value: number) => Math.round(value / 4) * 4;

// Pip size and the three pip columns (and rows) of a die face, all on the 4 px grid.
export function pipGrid(size: number): { pip: number; columns: [number, number, number] } {
  const { pip, pad } = GRIDS[size] ?? { pip: 8, pad: Math.max(4, dot(size / 8)) };
  return { pip, columns: [pad, (size - pip) / 2, size - pad - pip] };
}

// Where each die of a pair comes to rest: centered together, a quarter die apart.
export function restX(tray: Tray, slot: 0 | 1): number {
  const gap = dot(tray.die / 4);
  const left = dot((tray.width - (2 * tray.die + gap)) / 2);
  return slot === 0 ? left : left + tray.die + gap;
}

function between(from: number, to: number, share: number): number {
  return from + (to - from) * share;
}

// x along the throw: fast across the first fall, slower over the two hops.
function flightX(frame: number, start: number, rest: number): number {
  if (frame <= 6) return between(start, between(start, rest, 0.7), frame / 6);
  if (frame <= 10) return between(between(start, rest, 0.7), between(start, rest, 0.92), (frame - 6) / 4);
  return between(between(start, rest, 0.92), rest, (frame - 10) / 3);
}

// y along the throw: a fall from above the tray to its floor, then two hops, each lower.
function flightY(frame: number, top: number, floor: number): number {
  const drop = floor - top;
  if (frame <= 6) return floor - drop * (1 - (frame / 6) ** 2);
  const hop = (height: number, share: number) => floor - height * 4 * share * (1 - share);
  if (frame <= 10) return hop(dot(drop * 0.4), (frame - 6) / 4);
  return hop(dot(drop * 0.15), (frame - 10) / 3);
}

export function diePose(timing: DieTiming, finalFace: number, flicker: readonly number[], tray: Tray, slot: 0 | 1, elapsed: number): DiePose {
  const start = -tray.die;
  const floor = tray.height - tray.die;
  const flick = (frame: number) => flicker.length ? flicker[frame % flicker.length]! : finalFace;
  if (elapsed < timing.throwAt) return { visible: false, x: start, y: 0, sprite: 'face', squash: false, face: flick(0), landed: false, dust: null };

  const frame = Math.floor((elapsed - timing.throwAt) / FRAME_MS);
  const rest = restX(tray, slot);
  const landFrame = FLIGHT_FRAMES + Math.round(timing.teeterMs / FRAME_MS);

  if (frame < FLIGHT_FRAMES) {
    const contact = (CONTACT_FRAMES as readonly number[]).includes(frame);
    const afterContact = (CONTACT_FRAMES as readonly number[]).includes(frame - 1);
    return {
      visible: true,
      x: dot(flightX(frame, start, rest)),
      y: dot(flightY(frame, -dot(tray.die / 2), floor)),
      sprite: contact ? 'face' : SPRITES[frame % SPRITES.length]!,
      squash: contact,
      face: flick(frame),
      landed: false,
      dust: contact ? 0 : afterContact ? 1 : null,
    };
  }
  if (frame < landFrame) {
    // A last chance: the die stands on its corner and rocks before it falls.
    const rock = Math.floor((frame - FLIGHT_FRAMES) / 2) % 2 === 0 ? -4 : 4;
    const dust = frame === FLIGHT_FRAMES ? 0 : frame === FLIGHT_FRAMES + 1 ? 1 : null;
    return { visible: true, x: rest + rock, y: floor, sprite: 'corner', squash: false, face: flick(frame), landed: false, dust };
  }
  const landing = frame === landFrame;
  return { visible: true, x: rest, y: floor, sprite: 'face', squash: landing, face: finalFace, landed: true, dust: landing ? 0 : frame === landFrame + 1 ? 1 : null };
}
