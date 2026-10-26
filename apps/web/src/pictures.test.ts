// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '@rpg/contracts';
import { BATCH_PORTRAIT_CONCURRENCY, pictureUrl, portraitAlt, portraitIdFor, runPool, shownScenePicture } from './pictures';

afterEach(() => window.history.replaceState({}, '', '/'));

const identity = 'b'.repeat(32);
const imageId = '123e4567-e89b-42d3-a456-426614174000';

function snapshot(extra: Record<string, unknown> = {}): SessionSnapshot {
  return {
    session: { scene: { id: 'scene-1', title: 'Harbor' } },
    characters: [{ id: 'same', portraitId: 'char-pic' }, { id: 'pc-2' }],
    npcs: [{ id: 'same', portraitId: 'npc-pic' }, { id: 'npc-2', portraitId: 'npc-2-pic' }, { id: 'npc-3' }],
    picturesEnabled: true,
    scenePicture: { imageId, sceneId: 'scene-1' },
    ...extra,
  } as unknown as SessionSnapshot;
}

describe('pictureUrl', () => {
  it('builds the three scopes without an identity', () => {
    expect(pictureUrl({ kind: 'session', sessionId: 'show' }, imageId)).toBe(`/api/sessions/show/images/${imageId}`);
    expect(pictureUrl({ kind: 'library' }, imageId)).toBe(`/api/library/images/${imageId}`);
    expect(pictureUrl({ kind: 'builder' }, imageId)).toBe(`/api/character-builder/images/${imageId}`);
  });

  it('carries the tab identity', () => {
    window.history.replaceState({}, '', `/sessions/show/play?identity=${identity}`);
    expect(pictureUrl({ kind: 'session', sessionId: 'show' }, imageId)).toBe(`/api/sessions/show/images/${imageId}?identity=${identity}`);
    expect(pictureUrl({ kind: 'library' }, imageId)).toBe(`/api/library/images/${imageId}?identity=${identity}`);
    expect(pictureUrl({ kind: 'builder' }, imageId)).toBe(`/api/character-builder/images/${imageId}?identity=${identity}`);
  });

  it('encodes the session id and image id', () => {
    expect(pictureUrl({ kind: 'session', sessionId: 'a b/c?d' }, 'x y')).toBe('/api/sessions/a%20b%2Fc%3Fd/images/x%20y');
  });
});

describe('portraitAlt', () => {
  it('names the character or falls back', () => {
    expect(portraitAlt('Mara')).toBe('Portrait of Mara');
    expect(portraitAlt('  Mara  ')).toBe('Portrait of Mara');
    expect(portraitAlt('   ')).toBe('Portrait of this character');
    expect(BATCH_PORTRAIT_CONCURRENCY).toBe(3);
  });
});

describe('runPool', () => {
  it('never exceeds its limit and processes every item in order', async () => {
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    await runPool(Array.from({ length: 10 }, (_, index) => index), 3, async (item) => {
      started.push(item);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    });
    expect(peak).toBe(3);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('keeps going and resolves when a worker fails', async () => {
    const done: number[] = [];
    await expect(runPool([1, 2, 3, 4], 2, async (item) => {
      if (item === 2) throw new Error('boom');
      done.push(item);
    })).resolves.toBeUndefined();
    expect(done.sort()).toEqual([1, 3, 4]);
  });

  it('handles an empty list', async () => {
    await expect(runPool([], 3, async () => undefined)).resolves.toBeUndefined();
  });
});

describe('portraitIdFor', () => {
  it('prefers characters to NPCs and finds NPCs', () => {
    expect(portraitIdFor(snapshot(), 'same')).toBe('char-pic');
    expect(portraitIdFor(snapshot(), 'npc-2')).toBe('npc-2-pic');
  });

  it('returns null without a portrait, for unknown ids and when pictures are off', () => {
    expect(portraitIdFor(snapshot(), 'pc-2')).toBeNull();
    expect(portraitIdFor(snapshot(), 'npc-3')).toBeNull();
    expect(portraitIdFor(snapshot(), 'nobody')).toBeNull();
    expect(portraitIdFor(snapshot({ picturesEnabled: false }), 'same')).toBeNull();
  });
});

describe('shownScenePicture', () => {
  it('returns the picture for the current scene', () => {
    expect(shownScenePicture(snapshot())).toEqual({ imageId, sceneId: 'scene-1' });
  });

  it('returns null when pictures are off, there is no picture, or it is another scene', () => {
    expect(shownScenePicture(snapshot({ picturesEnabled: false }))).toBeNull();
    expect(shownScenePicture(snapshot({ scenePicture: null }))).toBeNull();
    expect(shownScenePicture(snapshot({ scenePicture: undefined }))).toBeNull();
    expect(shownScenePicture(snapshot({ scenePicture: { imageId, sceneId: 'scene-0' } }))).toBeNull();
  });
});
