// @vitest-environment jsdom
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '@rpg/contracts';
import StreamView from './StreamView.vue';

const mocks = vi.hoisted(() => ({
  streamAccess: vi.fn(),
  snapshot: vi.fn(),
  subscriptions: [] as Array<{ refresh: () => void; connection: (value: boolean) => void }>,
  status: { presenting: false, listening: true, error: '' },
  emitStatus: null as null | ((value: { presenting: boolean; listening: boolean; error: string }) => void),
  play: vi.fn(),
  stop: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('./api', () => ({
  api: { streamAccess: mocks.streamAccess, snapshot: mocks.snapshot },
  subscribeToSession: vi.fn((_sessionId: string, refresh: () => void, connection: (value: boolean) => void) => {
    mocks.subscriptions.push({ refresh, connection });
    return vi.fn();
  }),
}));

vi.mock('./BroadcastAudio.vue', async () => {
  const { defineComponent, h, onMounted } = await import('vue');
  return {
    default: defineComponent({
      name: 'BroadcastAudio',
      props: { sessionId: { type: String, required: true }, beatId: String, mode: { type: String, required: true } },
      emits: ['segment', 'status'],
      setup(props, { emit }) {
        onMounted(() => {
          mocks.emitStatus = value => emit('status', value);
          emit('status', props.mode === 'follow' ? { presenting: false, listening: false, error: '' } : mocks.status);
        });
        return () => h('div', { hidden: true, 'data-mode': props.mode });
      },
    }),
  };
});

vi.mock('./dice-sounds', async () => {
  const actual = await vi.importActual<typeof import('./dice-sounds')>('./dice-sounds');
  return { ...actual, createDiceSounds: () => ({ play: mocks.play, stop: mocks.stop, dispose: mocks.dispose }) };
});

const NOW = Date.parse('2026-11-11T20:00:00.000Z');

function access() {
  return {
    identityId: 'a'.repeat(32), sessionId: 's1',
    link: { id: 'l1', label: 'Main show', subject: 'show', characterId: null, canPresent: true },
    expiresAt: new Date(NOW + 12 * 60 * 60 * 1000).toISOString(),
  };
}
function beat(id: string, rolls: unknown[]) {
  return { id, kind: 'action', beatNumber: 1, actionRoundNumber: 1, stateRevision: 1, publishedAt: new Date(Date.now()).toISOString(), textOnly: true, segments: [], rolls, outcomes: [] };
}
function snapshot(latest: unknown, status = 'live'): SessionSnapshot {
  return {
    schemaVersion: 1, role: 'stage', eventSeq: 4,
    session: { id: 's1', title: 'The Ledger Job', status, mode: 'conversation', stateRevision: 1, beatNumber: 2, actionRoundNumber: 0, inputEpoch: 0, scene: { id: 'sc', title: 'The Salt Bar', description: 'A quiet bar.', locationId: 'bar' } },
    characters: [{ id: 'c1', displayName: 'Mara Vale', traits: { force: 0, finesse: 1, wits: 2, presence: 1 }, strain: 1, appearance: '', approved: true, ready: true }],
    npcs: [], tracks: [], facts: [], corrections: [], history: [latest], activeBeat: null,
  } as unknown as SessionSnapshot;
}
const ROLL = { id: 'r9', contractId: 'k', contractVersion: 1, actorCharacterId: 'c1', faces: [3, 4], trait: 'wits', traitModifier: 2, edge: 0, total: 9, band: 'costly' };

let wrapper: VueWrapper | null = null;
const settle = () => vi.advanceTimersByTimeAsync(0);
async function open(path: string) {
  window.history.replaceState({}, '', path);
  wrapper = mount(StreamView, { attachTo: document.body });
  await settle();
  return wrapper;
}
// The director publishes a round with a roll: the page refreshes and sees the new beat.
async function publish(next = snapshot(beat('b2', [ROLL]))) {
  mocks.snapshot.mockImplementation(async () => next);
  mocks.subscriptions[0]!.refresh();
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.streamAccess.mockReset().mockImplementation(async () => access());
  mocks.snapshot.mockReset().mockImplementation(async () => snapshot(beat('b1', [])));
  mocks.subscriptions.length = 0;
  mocks.status = { presenting: false, listening: true, error: '' };
  mocks.emitStatus = null;
  mocks.play.mockReset();
  mocks.stop.mockReset();
  mocks.dispose.mockReset();
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.useRealTimers();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
});

describe('the dice moment on the stream page', () => {
  it('passes the moment to the overlay and the scene', async () => {
    for (const layout of ['overlay', 'scene']) {
      const view = await open(`/stream?layout=${layout}#token=t`);
      const name = layout === 'overlay' ? 'StageOverlay' : 'StageScene';
      expect(view.findComponent({ name }).props('diceMoment')).toBeNull();
      await publish();
      expect(view.findComponent({ name }).props('diceMoment')).toMatchObject({ beatId: 'b2' });
      view.unmount();
      wrapper = null;
      mocks.snapshot.mockImplementation(async () => snapshot(beat('b1', [])));
      mocks.subscriptions.length = 0;
    }
  });

  it('passes the moment to the Dice piece only among pieces', async () => {
    const dice = await open('/stream?view=dice#token=t');
    await publish();
    expect(dice.findComponent({ name: 'StageDice' }).props('moment')).toMatchObject({ beatId: 'b2' });
    dice.unmount();
    wrapper = null;
    mocks.snapshot.mockImplementation(async () => snapshot(beat('b1', [])));
    mocks.subscriptions.length = 0;
    const captions = await open('/stream?view=captions#token=t');
    await publish();
    expect(captions.findComponent({ name: 'StageCaptions' }).attributes()).not.toHaveProperty('moment');
    expect(captions.html()).not.toContain('[object Object]');
  });

  it('holds the rest of the stage as it was until the dice land', async () => {
    const view = await open('/stream?layout=overlay#token=t');
    const published = snapshot(beat('b2', [ROLL]));
    (published.characters[0] as { strain: number }).strain = 6;
    await publish(published);
    const overlay = () => view.findComponent({ name: 'StageOverlay' });
    const shown = () => overlay().props('snapshot') as SessionSnapshot;
    expect(shown().characters[0]!.strain).toBe(1);
    expect(shown().history.at(-1)!.id).toBe('b2');
    const reveal = overlay().props('diceMoment').schedule.revealAt as number;
    await vi.advanceTimersByTimeAsync(reveal + 60);
    expect(shown().characters[0]!.strain).toBe(6);
  });

  it('holds the Party piece too until the dice land', async () => {
    const view = await open('/stream?view=party#token=t');
    const published = snapshot(beat('b2', [ROLL]));
    (published.characters[0] as { strain: number }).strain = 6;
    await publish(published);
    const party = () => view.findComponent({ name: 'StageParty' }).props('snapshot') as SessionSnapshot;
    expect(party().characters[0]!.strain).toBe(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(party().characters[0]!.strain).toBe(6);
  });

  it('plays the sounds once per moment on a listening page', async () => {
    await open('/stream?layout=overlay#token=t');
    await publish();
    expect(mocks.play).toHaveBeenCalledTimes(1);
    const [events, elapsed, volume] = mocks.play.mock.calls[0]!;
    expect(events.map((event: { kind: string }) => event.kind)).toContain('clack');
    expect([elapsed, volume]).toEqual([0, 1]);
    await publish();
    expect(mocks.play).toHaveBeenCalledTimes(1);
  });

  it('plays the sounds on a presenting page', async () => {
    mocks.status = { presenting: true, listening: false, error: '' };
    await open('/stream?layout=audio#token=t');
    await publish();
    expect(mocks.play).toHaveBeenCalledTimes(1);
  });

  it('stays silent on a follow piece, an off page and a page whose narration is not playing', async () => {
    await open('/stream?view=captions#token=t');
    await publish();
    wrapper!.unmount();
    wrapper = null;
    mocks.subscriptions.length = 0;
    mocks.snapshot.mockImplementation(async () => snapshot(beat('b1', [])));
    await open('/stream?layout=overlay&audio=off#token=t');
    await publish();
    wrapper!.unmount();
    wrapper = null;
    mocks.subscriptions.length = 0;
    mocks.snapshot.mockImplementation(async () => snapshot(beat('b1', [])));
    mocks.status = { presenting: false, listening: false, error: '' };
    await open('/stream?layout=overlay#token=t');
    await publish();
    expect(mocks.play).not.toHaveBeenCalled();
  });

  it('stops the sounds when a slate appears or the narration audio drops', async () => {
    await open('/stream?layout=overlay#token=t');
    await publish();
    expect(mocks.play).toHaveBeenCalledTimes(1);
    mocks.stop.mockClear();
    mocks.emitStatus!({ presenting: false, listening: false, error: '' });
    await settle();
    expect(mocks.stop).toHaveBeenCalled();
    mocks.stop.mockClear();
    await publish(snapshot(beat('b2', [ROLL]), 'paused'));
    expect(mocks.stop).toHaveBeenCalled();
  });

  it('lets go of the audio when the page closes', async () => {
    const view = await open('/stream?layout=overlay#token=t');
    view.unmount();
    wrapper = null;
    expect(mocks.dispose).toHaveBeenCalled();
  });
});
