import { effectScope, nextTick, shallowRef, type EffectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '@rpg/contracts';
import { heldStage, useDiceMoment } from './use-dice-moment';

const NOW = Date.parse('2026-11-11T20:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function roll(id: string, actor: string) {
  return { id, contractId: 'k', contractVersion: 1, actorCharacterId: actor, faces: [3, 4], trait: 'force', traitModifier: 0, edge: 0, total: 7, band: 'costly' };
}
function beat(id: string, rolls: unknown[], publishedAt = iso(Date.now())) {
  return { id, kind: 'action', beatNumber: 1, actionRoundNumber: 1, stateRevision: 1, publishedAt, textOnly: true, segments: [], rolls, outcomes: [] };
}
function snap(history: unknown[], status = 'live'): SessionSnapshot {
  return {
    schemaVersion: 1, role: 'stage', eventSeq: 1,
    session: { id: 's1', title: 'T', status, mode: 'conversation', stateRevision: 1, beatNumber: 1, actionRoundNumber: 0, inputEpoch: 0, scene: { id: 'sc', title: 'S', description: '', locationId: 'l' } },
    characters: [{ id: 'c1', displayName: 'Mara' }, { id: 'c2', displayName: 'Tom' }],
    npcs: [], tracks: [], facts: [], corrections: [], history, activeBeat: null,
  } as unknown as SessionSnapshot;
}

let scope: EffectScope | null = null;
function start(first: SessionSnapshot | null, options: { reducedMotion?: () => boolean } = { reducedMotion: () => false }) {
  const snapshot = shallowRef<SessionSnapshot | null>(first);
  scope = effectScope();
  const result = scope.run(() => useDiceMoment(snapshot, options))!;
  const show = async (next: SessionSnapshot | null) => { snapshot.value = next; await nextTick(); };
  return { ...result, show };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  scope?.stop();
  scope = null;
  vi.useRealTimers();
});

describe('useDiceMoment', () => {
  it('treats the first snapshot as already seen', async () => {
    const page = start(snap([beat('b1', [roll('r1', 'c1')])]));
    await nextTick();
    expect(page.moment.value).toBeNull();
  });

  it('treats the first snapshot as seen even when it arrives after the page opens', async () => {
    const page = start(null);
    await page.show(snap([beat('b1', [roll('r1', 'c1')])]));
    expect(page.moment.value).toBeNull();
  });

  it('starts a moment for a new fresh beat with rolls, in stage order', async () => {
    const page = start(snap([beat('b1', [])]));
    await page.show(snap([beat('b1', []), beat('b2', [roll('late', 'c2'), roll('early', 'c1')])]));
    const moment = page.moment.value!;
    expect(moment.beatId).toBe('b2');
    expect(moment.startedAt).toBe(NOW);
    expect(moment.schedule.rolls.map(entry => entry.roll.id)).toEqual(['early', 'late']);
    expect(page.elapsed.value).toBe(0);
  });

  it('remembers the stage as it was before the beat', async () => {
    const before = snap([beat('b1', [])]);
    const page = start(before);
    await page.show(snap([beat('b1', []), beat('b2', [roll('r2', 'c1')])]));
    expect(page.moment.value!.before).toBe(before);
  });

  it('does not restart or reshuffle when the same beat arrives again', async () => {
    const page = start(snap([beat('b1', [])]));
    const fresh = beat('b2', [roll('r2', 'c1')]);
    await page.show(snap([fresh]));
    const first = page.moment.value;
    vi.advanceTimersByTime(600);
    await page.show(snap([{ ...fresh }]));
    expect(page.moment.value).toBe(first);
    expect(page.elapsed.value).toBe(600);
  });

  it('switches to a newer beat that arrives during a moment', async () => {
    const page = start(snap([beat('b1', [])]));
    await page.show(snap([beat('b2', [roll('r2', 'c1')])]));
    vi.advanceTimersByTime(300);
    await page.show(snap([beat('b3', [roll('r3', 'c2')])]));
    expect(page.moment.value?.beatId).toBe('b3');
    expect(page.elapsed.value).toBe(0);
  });

  it('skips a beat published more than 10 s ago, and a beat with no rolls', async () => {
    const page = start(snap([beat('b1', [])]));
    await page.show(snap([beat('b2', [roll('r2', 'c1')], iso(NOW - 11_000))]));
    expect(page.moment.value).toBeNull();
    await page.show(snap([beat('b3', [])]));
    expect(page.moment.value).toBeNull();
  });

  it('advances elapsed every 60 ms and clears at the end', async () => {
    const page = start(snap([beat('b1', [])]));
    await page.show(snap([beat('b2', [roll('r2', 'c1')])]));
    const end = page.moment.value!.schedule.endAt;
    vi.advanceTimersByTime(120);
    expect(page.elapsed.value).toBe(120);
    // The clock ticks every 60 ms, so the moment clears on the first tick at or after its end.
    const lastTick = Math.ceil(end / 60) * 60 - 60;
    vi.advanceTimersByTime(lastTick - 120);
    expect(page.moment.value).not.toBeNull();
    vi.advanceTimersByTime(60);
    expect(page.moment.value).toBeNull();
  });

  it('ends at once when the clock catches up after a long gap', async () => {
    const page = start(snap([beat('b1', [])]));
    await page.show(snap([beat('b2', [roll('r2', 'c1')])]));
    vi.setSystemTime(NOW + 10_000);
    vi.advanceTimersByTime(60);
    expect(page.moment.value).toBeNull();
  });

  it('clears when a slate appears and does not replay after it', async () => {
    const page = start(snap([beat('b1', [])]));
    const fresh = beat('b2', [roll('r2', 'c1')]);
    await page.show(snap([fresh]));
    await page.show(snap([fresh], 'paused'));
    expect(page.moment.value).toBeNull();
    await page.show(snap([fresh], 'live'));
    expect(page.moment.value).toBeNull();
  });

  it('never plays when the page asks for reduced motion', async () => {
    const page = start(snap([beat('b1', [])]), { reducedMotion: () => true });
    await page.show(snap([beat('b2', [roll('r2', 'c1')])]));
    expect(page.moment.value).toBeNull();
  });
});

describe('heldStage', () => {
  it('keeps the stage as it was before the publish, except the new rolls the dice need', () => {
    const before = {
      ...snap([beat('b1', [])]),
      characters: [{ id: 'c1', displayName: 'Mara', strain: 7 }],
      npcs: [{ id: 'n1', displayName: 'Old Brann', condition: undefined }],
      tracks: [{ id: 't1', label: 'Alarm', current: 1, max: 4 }],
      facts: [{ id: 'f1', text: 'The door is locked.' }],
      corrections: [],
      picturesEnabled: true,
      scenePicture: { imageId: 'old-picture', kind: 'beat' },
    } as unknown as SessionSnapshot;
    (before.history[0] as { segments: unknown[] }).segments = [{ id: 'g-old', text: 'The cellar is dark.' }];
    (before.session as { scene: unknown }).scene = { id: 'sc', title: 'The Cellar', description: '', locationId: 'l' };
    const published = { ...beat('b2', [roll('r2', 'c1')]), segments: [{ id: 'g-new', text: 'Mara falls and does not get up.' }] };
    const current = {
      ...snap([beat('b1', []), published], 'live'),
      characters: [{ id: 'c1', displayName: 'Mara', strain: 8, condition: 'dead' }],
      npcs: [{ id: 'n1', displayName: 'Old Brann', condition: 'dead' }],
      tracks: [{ id: 't1', label: 'Alarm', current: 4, max: 4 }],
      facts: [{ id: 'f1', text: 'The door is locked.' }, { id: 'f2', text: 'Mara is gone.' }],
      corrections: [{ id: 'x' }],
      picturesEnabled: true,
      scenePicture: { imageId: 'new-picture', kind: 'beat' },
      activeBeat: null,
    } as unknown as SessionSnapshot;
    (current.session as { scene: unknown }).scene = { id: 'sc2', title: 'The River', description: '', locationId: 'l2' };
    const held = heldStage(current, before);
    expect(held.characters).toBe(before.characters);
    expect(held.npcs).toBe(before.npcs);
    expect(held.tracks).toBe(before.tracks);
    expect(held.facts).toBe(before.facts);
    expect(held.corrections).toBe(before.corrections);
    expect(held.scenePicture).toBe(before.scenePicture);
    expect(held.session.scene.title).toBe('The Cellar');
    expect(held.session.status).toBe('live');
    expect(held.activeBeat).toBeNull();
    const latest = held.history.at(-1)!;
    expect([latest.id, latest.rolls.map(item => item.id)]).toEqual(['b2', ['r2']]);
    expect(latest.segments.map(segment => segment.id)).toEqual(['g-old']);
    expect(held.history).toHaveLength(2);
  });

  it('keeps the current show status, so a pause still shows its slate', () => {
    const before = snap([beat('b1', [])], 'live');
    const current = snap([beat('b1', []), beat('b2', [roll('r2', 'c1')])], 'paused');
    expect(heldStage(current, before).session.status).toBe('paused');
  });
});

