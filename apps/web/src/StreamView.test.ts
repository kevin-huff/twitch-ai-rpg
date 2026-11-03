// @vitest-environment jsdom
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '@rpg/contracts';
import StreamView from './StreamView.vue';
import StageScene from './StageScene.vue';

const mocks = vi.hoisted(() => ({
  streamAccess: vi.fn(),
  snapshot: vi.fn(),
  subscriptions: [] as Array<{ sessionId: string; refresh: () => void; connection: (value: boolean) => void; unsubscribe: ReturnType<typeof vi.fn> }>,
  audioMounts: [] as Array<{ sessionId: string; mode: string; identity: string | null }>,
}));

vi.mock('./api', () => ({
  api: { streamAccess: mocks.streamAccess, snapshot: mocks.snapshot },
  subscribeToSession: vi.fn((sessionId: string, refresh: () => void, connection: (value: boolean) => void) => {
    const entry = { sessionId, refresh, connection, unsubscribe: vi.fn(() => connection(false)) };
    mocks.subscriptions.push(entry);
    return entry.unsubscribe;
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
        onMounted(() => mocks.audioMounts.push({ sessionId: props.sessionId, mode: props.mode, identity: new URLSearchParams(window.location.search).get('identity') }));
        return () => h('div', { hidden: true, 'data-testid': 'broadcast-audio-stub', 'data-mode': props.mode, onClick: () => emit('segment', 'g2') });
      },
    }),
  };
});

const IDENTITY = 'a'.repeat(32);
const unauthorized = () => Object.assign(new Error('Sign in again.'), { status: 401 });

function access(overrides: { canPresent?: boolean; expiresInMs?: number } = {}) {
  return {
    identityId: IDENTITY,
    sessionId: 's1',
    link: { id: 'l1', label: 'Main show', subject: overrides.canPresent === false ? 'character' : 'show', characterId: null, canPresent: overrides.canPresent ?? true },
    expiresAt: new Date(Date.now() + (overrides.expiresInMs ?? 12 * 60 * 60 * 1000)).toISOString(),
  };
}

function snapshot(text = 'Rain taps the glass.'): SessionSnapshot {
  return {
    schemaVersion: 1, role: 'stage', eventSeq: 4,
    session: {
      id: 's1', title: 'The Ledger Job', status: 'live', mode: 'conversation', stateRevision: 1, beatNumber: 2, actionRoundNumber: 0,
      inputEpoch: 0, scene: { id: 'sc', title: 'The Salt Bar', description: 'A quiet bar by the dock.', locationId: 'bar' },
    },
    characters: [{ id: 'c1', displayName: 'Mara Vale', traits: { force: 0, finesse: 1, wits: 2, presence: 1 }, strain: 4, appearance: '', approved: true, ready: true }],
    npcs: [], tracks: [], facts: [{ id: 'f1', text: 'The ledger is missing.' }], corrections: [],
    history: [{
      id: 'b1', kind: 'action', beatNumber: 1, actionRoundNumber: 1, stateRevision: 1, publishedAt: '2026-10-20T10:00:00.000Z', textOnly: true,
      segments: [
        { id: 'g1', kind: 'narration', text, speaker: null, recipientCharacterIds: [], delivery: 'public', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false },
        { id: 'g2', kind: 'npc_dialogue', text: 'You are late.', speaker: { entityId: 'n1', displayName: 'Old Brann' }, recipientCharacterIds: [], delivery: 'public', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false },
      ],
      rolls: [], outcomes: [],
    }],
    activeBeat: null,
  } as unknown as SessionSnapshot;
}

let wrapper: VueWrapper | null = null;
const settle = () => vi.advanceTimersByTimeAsync(0);

async function open(path: string) {
  window.history.replaceState({}, '', path);
  wrapper = mount(StreamView, { attachTo: document.body });
  await settle();
  return wrapper;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-28T19:00:00.000Z'));
  mocks.streamAccess.mockReset();
  mocks.snapshot.mockReset();
  mocks.subscriptions.length = 0;
  mocks.audioMounts.length = 0;
  mocks.streamAccess.mockImplementation(async () => access());
  mocks.snapshot.mockImplementation(async () => snapshot());
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.useRealTimers();
  document.body.innerHTML = '';
  document.title = '';
  window.history.replaceState({}, '', '/');
});

describe('StreamView', () => {
  it('exchanges the hash token, selects the identity and loads the stage snapshot', async () => {
    const view = await open('/stream?layout=scene#token=secret%2Btoken');
    expect(mocks.streamAccess).toHaveBeenCalledTimes(1);
    expect(mocks.streamAccess).toHaveBeenCalledWith('secret+token');
    expect(new URLSearchParams(window.location.search).get('identity')).toBe(IDENTITY);
    expect(window.location.hash).toBe('#token=secret%2Btoken');
    expect(mocks.snapshot).toHaveBeenCalledWith('s1', 'stage');
    expect(mocks.subscriptions).toHaveLength(1);
    expect(mocks.subscriptions[0]!.sessionId).toBe('s1');
    expect(view.findAll('.stage')).toHaveLength(1);
    expect(view.find('.stage-story').text()).toContain('Rain taps the glass.');
    expect(view.findComponent({ name: 'StageScene' }).exists()).toBe(true);
    expect(view.findComponent({ name: 'StageOverlay' }).exists()).toBe(false);
    expect(document.title).toBe('Stage · The Ledger Job');
  });

  it('renders the transparent overlay when the link asks for it', async () => {
    const view = await open('/stream?layout=overlay&audio=off#token=t');
    expect(view.findComponent({ name: 'StageOverlay' }).exists()).toBe(true);
    expect(view.findComponent({ name: 'StageScene' }).exists()).toBe(false);
  });

  it('shows the offline slate and calls nothing without a token', async () => {
    const view = await open('/stream');
    expect(mocks.streamAccess).not.toHaveBeenCalled();
    expect(view.find('[data-kind="offline"]').exists()).toBe(true);
    expect(view.text()).toContain('The story continues shortly');
  });

  it('shows the offline slate when the link is turned off and retries every minute', async () => {
    mocks.streamAccess.mockRejectedValue(unauthorized());
    const view = await open('/stream#token=t');
    expect(view.text()).toContain('The story continues shortly');
    expect(view.text()).not.toContain('Sign in again');
    expect(view.find('.stage-story').exists()).toBe(false);
    expect(mocks.snapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(2);
    mocks.streamAccess.mockImplementation(async () => access());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(3);
    expect(view.find('.stage-story').text()).toContain('Rain taps the glass.');
    expect(view.find('[data-kind="offline"]').exists()).toBe(false);
  });

  it('turns the picture off when a renewal finds the link turned off', async () => {
    const view = await open('/stream#token=t');
    expect(view.find('.stage-story').exists()).toBe(true);
    mocks.streamAccess.mockRejectedValue(unauthorized());
    await vi.advanceTimersByTimeAsync(11.5 * 60 * 60 * 1000 + 1);
    await settle();
    expect(mocks.streamAccess).toHaveBeenCalledTimes(2);
    expect(view.find('.stage-story').exists()).toBe(false);
    expect(view.text()).toContain('The story continues shortly');
    expect(mocks.subscriptions[0]!.unsubscribe).toHaveBeenCalled();
    expect(view.find('[data-testid="broadcast-audio-stub"]').exists()).toBe(false);
  });

  it('re-exchanges once after 401s during refresh and keeps the picture', async () => {
    const view = await open('/stream#token=t');
    expect(mocks.streamAccess).toHaveBeenCalledTimes(1);
    mocks.snapshot.mockRejectedValueOnce(unauthorized()).mockRejectedValueOnce(unauthorized());
    const first = mocks.subscriptions[0]!;
    first.refresh();
    first.refresh();
    await settle();
    expect(view.find('.stage-story').text()).toContain('Rain taps the glass.');
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(2);
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.subscriptions).toHaveLength(2);
    expect(view.find('.stage-story').text()).toContain('Rain taps the glass.');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(2);
  });

  it('spaces repeated 401 exchanges with the backoff instead of a fixed gap', async () => {
    mocks.snapshot.mockRejectedValue(unauthorized());
    await open('/stream#token=t');
    expect(mocks.streamAccess).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4999);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(4);
  });

  it('re-subscribes after a disconnect without a new exchange and ignores the old socket', async () => {
    await open('/stream#token=t');
    const first = mocks.subscriptions[0]!;
    first.connection(true);
    first.connection(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(1);
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.subscriptions).toHaveLength(2);
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
    first.connection(false);
    first.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(1);
    expect(mocks.subscriptions).toHaveLength(2);
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
  });

  it('retries a dropped socket at 2, 5, 15 and then every 60 seconds with no new exchange', async () => {
    await open('/stream#token=t');
    mocks.subscriptions[0]!.connection(false);
    mocks.subscriptions[0]!.connection(false);
    const counts: number[] = [];
    for (const step of [2000, 5000, 15_000, 60_000, 60_000]) {
      await vi.advanceTimersByTimeAsync(step - 1);
      counts.push(mocks.subscriptions.length);
      await vi.advanceTimersByTimeAsync(1);
      counts.push(mocks.subscriptions.length);
      mocks.subscriptions[mocks.subscriptions.length - 1]!.connection(false);
    }
    expect(counts).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5, 6]);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(1);
  });

  it('starts the backoff over once the socket connects', async () => {
    await open('/stream#token=t');
    mocks.subscriptions[0]!.connection(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.subscriptions).toHaveLength(2);
    mocks.subscriptions[1]!.connection(false);
    await vi.advanceTimersByTimeAsync(4999);
    expect(mocks.subscriptions).toHaveLength(2);
    mocks.subscriptions[1]!.connection(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.subscriptions).toHaveLength(2);
    mocks.subscriptions[1]!.connection(false);
    await vi.advanceTimersByTimeAsync(1999);
    expect(mocks.subscriptions).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.subscriptions).toHaveLength(3);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(1);
  });

  it('exchanges again, with the backoff, when a disconnect finds the access about to expire', async () => {
    mocks.streamAccess.mockImplementation(async () => access({ expiresInMs: 10 * 60 * 1000 }));
    await open('/stream#token=t');
    mocks.subscriptions[0]!.connection(false);
    await vi.advanceTimersByTimeAsync(1999);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(2);
    expect(mocks.subscriptions).toHaveLength(2);
  });

  it('backs off after network failures and keeps the last good picture', async () => {
    const view = await open('/stream#token=t');
    mocks.streamAccess.mockRejectedValue(new Error('Failed to fetch'));
    await vi.advanceTimersByTimeAsync(11.5 * 60 * 60 * 1000 + 1);
    await settle();
    expect(mocks.streamAccess).toHaveBeenCalledTimes(2);
    const counts: number[] = [];
    for (const step of [2000, 5000, 15_000, 60_000, 60_000]) {
      await vi.advanceTimersByTimeAsync(step - 1);
      counts.push(mocks.streamAccess.mock.calls.length);
      await vi.advanceTimersByTimeAsync(1);
      counts.push(mocks.streamAccess.mock.calls.length);
    }
    expect(counts).toEqual([2, 3, 3, 4, 4, 5, 5, 6, 6, 7]);
    expect(view.find('.stage-story').text()).toContain('Rain taps the glass.');
    expect(view.text()).not.toContain('Failed to fetch');
  });

  it('renews silently 30 minutes before the credential expires', async () => {
    await open('/stream#token=t');
    await vi.advanceTimersByTimeAsync(11.5 * 60 * 60 * 1000 - 1000);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(2);
    expect(mocks.subscriptions).toHaveLength(2);
  });

  it('presents audio for the show link by default, only after the identity is selected', async () => {
    (window as unknown as { obsstudio: object }).obsstudio = {};
    try {
      const view = await open('/stream#token=t');
      expect(mocks.audioMounts).toEqual([{ sessionId: 's1', mode: 'present', identity: IDENTITY }]);
      await view.find('[data-testid="broadcast-audio-stub"]').trigger('click');
      expect(view.find('.speaking').exists()).toBe(true);
    } finally {
      delete (window as unknown as { obsstudio?: object }).obsstudio;
    }
  });

  it('clears the active segment after the page goes offline and recovers', async () => {
    (window as unknown as { obsstudio: object }).obsstudio = {};
    try {
      const view = await open('/stream#token=t');
      view.findComponent({ name: 'BroadcastAudio' }).vm.$emit('segment', 'g2');
      await settle();
      expect(view.findComponent(StageScene).props('activeSegmentId')).toBe('g2');
      mocks.streamAccess.mockRejectedValue(unauthorized());
      await vi.advanceTimersByTimeAsync(11.5 * 60 * 60 * 1000 + 1);
      await settle();
      expect(view.find('.stage-story').exists()).toBe(false);
      mocks.streamAccess.mockImplementation(async () => access());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(view.find('.stage-story').exists()).toBe(true);
      expect(view.findComponent(StageScene).props('activeSegmentId')).toBeNull();
    } finally {
      delete (window as unknown as { obsstudio?: object }).obsstudio;
    }
  });

  it('removes the audio component when the link is turned off', async () => {
    const view = await open('/stream#token=t');
    view.findComponent({ name: 'BroadcastAudio' }).vm.$emit('segment', 'g2');
    await settle();
    expect(view.findComponent(StageScene).props('activeSegmentId')).toBe('g2');
    mocks.streamAccess.mockRejectedValue(unauthorized());
    await vi.advanceTimersByTimeAsync(11.5 * 60 * 60 * 1000 + 1);
    await settle();
    expect(view.findComponent({ name: 'BroadcastAudio' }).exists()).toBe(false);
  });

  it('listens on the show link outside OBS, even when audio=present is requested', async () => {
    delete (window as unknown as { obsstudio?: object }).obsstudio;
    const view = await open('/stream?audio=present#token=t');
    expect(mocks.audioMounts.map(item => item.mode)).toEqual(['listen']);
    view.unmount();
    wrapper = null;
    mocks.audioMounts.length = 0;
    await open('/stream#token=t');
    expect(mocks.audioMounts.map(item => item.mode)).toEqual(['listen']);
  });

  it('falls back to listening for a personal link that asks to present', async () => {
    mocks.streamAccess.mockImplementation(async () => access({ canPresent: false }));
    await open('/stream?audio=present#token=t');
    expect(mocks.audioMounts.map(item => item.mode)).toEqual(['listen']);
  });

  it('listens by default on a personal link and adds no audio when it is off', async () => {
    mocks.streamAccess.mockImplementation(async () => access({ canPresent: false }));
    const view = await open('/stream#token=t');
    expect(mocks.audioMounts.map(item => item.mode)).toEqual(['listen']);
    view.unmount();
    wrapper = null;
    mocks.audioMounts.length = 0;
    const silent = await open('/stream?audio=off#token=t');
    expect(mocks.audioMounts).toEqual([]);
    expect(silent.find('[data-testid="broadcast-audio-stub"]').exists()).toBe(false);
  });

  it('renders no interactive elements, images or error text', async () => {
    const view = await open('/stream?layout=scene#token=t');
    expect(view.findAll('button, input, select, textarea, a, img')).toHaveLength(0);
    view.unmount();
    wrapper = null;
    mocks.streamAccess.mockRejectedValue(unauthorized());
    const offline = await open('/stream?layout=overlay#token=t');
    expect(offline.findAll('button, input, select, textarea, a, img')).toHaveLength(0);
    expect(offline.find('[role="alert"]').exists()).toBe(false);
  });

  it('clears every timer and the subscription on unmount', async () => {
    const view = await open('/stream#token=t');
    view.unmount();
    wrapper = null;
    expect(mocks.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(mocks.streamAccess).toHaveBeenCalledTimes(1);
  });
});

describe('StreamView pieces and the sound link', () => {
  const VIEWS = [
    ['captions', 'StageCaptions', { x: 240, y: 836, width: 1440, height: 184 }],
    ['dice', 'StageDice', { x: 240, y: 686, width: 1440, height: 144 }],
    ['stakes', 'StageStakes', { x: 480, y: 140, width: 960, height: 612 }],
    ['party', 'StageParty', { x: 96, y: 60, width: 1344, height: 76 }],
    ['tracks', 'StageTracks', { x: 1472, y: 240, width: 352, height: 304 }],
    ['picture', 'StagePictureCorner', { x: 96, y: 184, width: 336, height: 192 }],
    ['badge', 'StageBadge', { x: 1488, y: 60, width: 336, height: 164 }],
    ['facts', 'StageFacts', { x: 0, y: 0, width: 464, height: 345 }],
    ['corrections', 'StageCorrections', { x: 0, y: 0, width: 1728, height: 88 }],
  ] as const;
  const NAMES = VIEWS.map(item => item[1]);

  function withObs<T>(run: () => Promise<T>): Promise<T> {
    (window as unknown as { obsstudio: object }).obsstudio = {};
    return run().finally(() => { delete (window as unknown as { obsstudio?: object }).obsstudio; });
  }

  it.each(VIEWS)('view=%s mounts only its piece inside a box-sized canvas', async (view, name, box) => {
    const page = await open(`/stream?view=${view}&who=c1#token=t`);
    for (const other of NAMES) expect(page.findComponent({ name: other }).exists()).toBe(other === name);
    expect(page.findComponent({ name: 'StageScene' }).exists()).toBe(false);
    expect(page.findComponent({ name: 'StageOverlay' }).exists()).toBe(false);
    const piece = page.findComponent({ name });
    expect(piece.props('snapshot')).toMatchObject({ session: { id: 's1' } });
    expect(piece.props('connected')).toBe(false);
    expect(piece.props('characterId')).toBe('c1');
    expect(page.attributes('data-layout')).toBe('piece');
    expect(page.attributes('data-view')).toBe(view);
    const canvas = page.get('.stage-canvas').attributes('style') ?? '';
    expect(canvas).toContain(`width: ${box.width}px`);
    expect(canvas).toContain(`height: ${box.height}px`);
    expect(canvas).toContain('left: 0px');
    expect(canvas).toContain('top: 0px');
    const origin = page.get('.stage-piece-origin').attributes('style') ?? '';
    expect(origin).toContain(`left: ${-box.x}px`);
    expect(origin).toContain(`top: ${-box.y}px`);
    expect(document.documentElement.classList.contains('stage-transparent')).toBe(true);
  });

  it('gives the piece no character when who is missing', async () => {
    const page = await open('/stream?view=dice#token=t');
    expect(page.findComponent({ name: 'StageDice' }).props('characterId')).toBeNull();
  });

  it('follows the spoken line on a captions page and passes the active segment', async () => {
    const page = await open('/stream?view=captions#token=t');
    expect(mocks.audioMounts).toEqual([{ sessionId: 's1', mode: 'follow', identity: IDENTITY }]);
    await page.find('[data-testid="broadcast-audio-stub"]').trigger('click');
    expect(page.findComponent({ name: 'StageCaptions' }).props('activeSegmentId')).toBe('g2');
  });

  it('mounts no audio on the other pieces by default', async () => {
    for (const [view] of VIEWS.filter(item => item[0] !== 'captions')) {
      const page = await open(`/stream?view=${view}#token=t`);
      expect(page.find('[data-testid="broadcast-audio-stub"]').exists()).toBe(false);
      page.unmount();
      wrapper = null;
    }
    expect(mocks.audioMounts).toEqual([]);
  });

  it('listens on a piece that asks to listen', async () => {
    await open('/stream?view=dice&audio=listen#token=t');
    expect(mocks.audioMounts.map(item => item.mode)).toEqual(['listen']);
  });

  it('presents on a piece only for a link that can present inside OBS', async () => {
    await withObs(async () => {
      const page = await open('/stream?view=dice&audio=present#token=t');
      expect(mocks.audioMounts.map(item => item.mode)).toEqual(['present']);
      page.unmount();
      wrapper = null;
      mocks.audioMounts.length = 0;
      mocks.streamAccess.mockImplementation(async () => access({ canPresent: false }));
      await open('/stream?view=dice&audio=present#token=t');
      expect(mocks.audioMounts.map(item => item.mode)).toEqual(['listen']);
    });
    mocks.audioMounts.length = 0;
    mocks.streamAccess.mockImplementation(async () => access());
    wrapper?.unmount();
    wrapper = null;
    await open('/stream?view=dice&audio=present#token=t');
    expect(mocks.audioMounts.map(item => item.mode)).toEqual(['listen']);
  });

  it('honours audio=off on a captions page', async () => {
    await open('/stream?view=captions&audio=off#token=t');
    expect(mocks.audioMounts).toEqual([]);
  });

  it('presents the sound link on the show link inside OBS and draws nothing', async () => {
    await withObs(async () => {
      const page = await open('/stream?layout=audio#token=t');
      expect(mocks.audioMounts.map(item => item.mode)).toEqual(['present']);
      expect(page.attributes('data-layout')).toBe('audio');
      expect(page.find('.stage-canvas').exists()).toBe(false);
      expect(page.find('.stage-story').exists()).toBe(false);
      expect(page.find('[data-kind]').exists()).toBe(false);
      expect(page.get('.stage-frame').attributes('data-layout')).toBe('blank');
      expect(document.documentElement.classList.contains('stage-transparent')).toBe(true);
    });
  });

  it('only listens on the sound link outside OBS and on a cast link', async () => {
    const page = await open('/stream?layout=audio#token=t');
    expect(mocks.audioMounts.map(item => item.mode)).toEqual(['listen']);
    page.unmount();
    wrapper = null;
    mocks.audioMounts.length = 0;
    await withObs(async () => {
      mocks.streamAccess.mockImplementation(async () => access({ canPresent: false }));
      await open('/stream?layout=audio#token=t');
      expect(mocks.audioMounts.map(item => item.mode)).toEqual(['listen']);
    });
  });

  it('ignores audio=off on the sound link', async () => {
    await open('/stream?layout=audio&audio=off#token=t');
    expect(mocks.audioMounts.map(item => item.mode)).toEqual(['listen']);
  });

  it('follows on a full layout that asks to follow', async () => {
    await withObs(async () => {
      const page = await open('/stream?layout=overlay&audio=follow#token=t');
      expect(mocks.audioMounts.map(item => item.mode)).toEqual(['follow']);
      expect(page.findComponent({ name: 'StageOverlay' }).exists()).toBe(true);
    });
  });

  it('makes no request, draws nothing and plays nothing for an unknown view', async () => {
    const page = await open('/stream?view=nonsense&audio=listen#token=t');
    expect(mocks.streamAccess).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.subscriptions).toHaveLength(0);
    expect(page.find('.stage-canvas').exists()).toBe(false);
    expect(page.text()).toBe('');
    expect(page.find('[data-testid="broadcast-audio-stub"]').exists()).toBe(false);
    expect(page.get('.stage-frame').attributes('data-layout')).toBe('blank');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(mocks.streamAccess).not.toHaveBeenCalled();
  });

  it('draws nothing on a piece page when its link is turned off', async () => {
    mocks.streamAccess.mockRejectedValue(unauthorized());
    const page = await open('/stream?view=captions#token=t');
    for (const name of NAMES) expect(page.findComponent({ name }).exists()).toBe(false);
    expect(page.text()).toBe('');
    expect(page.find('[data-testid="broadcast-audio-stub"]').exists()).toBe(false);
  });

  it('draws nothing on a captions page while the show is paused', async () => {
    mocks.snapshot.mockImplementation(async () => {
      const paused = snapshot();
      paused.session.status = 'paused';
      return paused;
    });
    const page = await open('/stream?view=captions#token=t');
    expect(page.findComponent({ name: 'StageCaptions' }).exists()).toBe(true);
    expect(page.find('.stage-story').exists()).toBe(false);
    expect(page.text()).toBe('');
  });
});

describe('main entry', () => {
  afterEach(() => {
    vi.doUnmock('./App.vue');
    vi.doUnmock('./StreamView.vue');
    vi.resetModules();
  });

  async function boot(path: string) {
    window.history.replaceState({}, '', path);
    document.body.innerHTML = '<div id="app"></div>';
    vi.resetModules();
    const { defineComponent, h } = await import('vue');
    vi.doMock('./App.vue', () => ({ default: defineComponent({ render: () => h('p', 'app shell') }) }));
    vi.doMock('./StreamView.vue', () => ({ default: defineComponent({ render: () => h('p', 'stream page') }) }));
    await import('./main');
    await vi.waitFor(() => expect(document.getElementById('app')!.textContent).not.toBe(''));
    return document.getElementById('app')!.textContent;
  }

  it('mounts the stream page only for /stream', async () => {
    expect(await boot('/stream?layout=overlay#token=t')).toBe('stream page');
    expect(await boot('/stream/')).toBe('stream page');
  });

  it('mounts the app for every other path', async () => {
    expect(await boot('/')).toBe('app shell');
    expect(await boot('/streams')).toBe('app shell');
    expect(await boot('/sessions/s1/stage')).toBe('app shell');
  });
});
