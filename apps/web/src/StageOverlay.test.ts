// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '@rpg/contracts';
import StageOverlay from './StageOverlay.vue';
import overlaySource from './StageOverlay.vue?raw';

const cssRule = (selector: string) => overlaySource.match(new RegExp('\\n' + selector.replace(/\./g, '\\.') + ' \\{([^}]*)\\}'))?.[1] ?? '';

function snapshot(overrides: Record<string, unknown> = {}, status: 'lobby' | 'live' | 'paused' | 'ended' = 'live'): SessionSnapshot {
  return {
    schemaVersion: 1, role: 'stage', eventSeq: 4,
    session: {
      id: 's1', title: 'The Story Table', status, mode: 'conversation', stateRevision: 1, beatNumber: 2, actionRoundNumber: 0,
      inputEpoch: 0, scene: { id: 'sc', title: 'The Salt Bar', description: 'A quiet bar by the dock.', locationId: 'bar' }
    },
    characters: [
      { id: 'c1', displayName: 'Mara Vale', traits: { force: 0, finesse: 1, wits: 2, presence: 1 }, strain: 4, appearance: '', approved: true, ready: true },
      { id: 'c2', displayName: 'Tom Reed', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, strain: 1, appearance: '', approved: true, ready: true }
    ],
    npcs: [],
    tracks: [
      { id: 't1', label: 'Signal', kind: 'progress', current: 1, max: 4, completionText: '', enabled: true },
      { id: 't2', label: 'Tide', kind: 'countdown', current: 2, max: 6, completionText: '', enabled: true },
      { id: 't3', label: 'Third', kind: 'danger', current: 0, max: 3, completionText: '', enabled: true },
      { id: 't4', label: 'Off', kind: 'danger', current: 0, max: 3, completionText: '', enabled: false }
    ],
    facts: [{ id: 'f1', text: 'The ledger is missing.' }],
    corrections: [{ id: 'k1', publishedBeatId: 'b1', beatNumber: 1, stateRevision: 1, recordedAt: '2026-10-20T10:00:00.000Z', publicText: 'Correction: it was Tuesday.' }],
    history: [{
      id: 'b1', kind: 'action', beatNumber: 1, actionRoundNumber: 1, stateRevision: 1, publishedAt: '2026-10-20T10:00:00.000Z', textOnly: true,
      segments: [
        { id: 'g1', kind: 'narration', text: 'Rain taps the glass.', speaker: null, recipientCharacterIds: [], delivery: 'public', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false },
        { id: 'g2', kind: 'npc_dialogue', text: 'You are late <b>again</b>.', speaker: { entityId: 'n1', displayName: 'Old Brann' }, recipientCharacterIds: [], delivery: 'public', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false }
      ],
      rolls: [
        { id: 'r1', contractId: 'x', contractVersion: 1, actorCharacterId: 'c2', faces: [3, 4], trait: 'force', traitModifier: 2, edge: 0, total: 9, band: 'costly' },
        { id: 'r2', contractId: 'y', contractVersion: 1, actorCharacterId: 'c1', faces: [6, 5], trait: 'wits', traitModifier: 2, edge: 1, total: 14, band: 'clean' }
      ],
      outcomes: []
    }],
    activeBeat: {
      id: 'b2', kind: 'action', phase: 'locked', revision: 1, locked: true,
      stakes: [{
        id: 'k', version: 1, actorCharacterId: 'c1', helperCharacterIds: ['c2'], intent: 'Pick the ledger lock', approach: 'Carefully', ruling: 'check',
        trait: 'wits', edge: 1, edgeReason: 'Help', risk: 'high', outcomes: { clean: 'It opens.', costly: 'It opens, loudly.', setback: 'It jams.' }
      }]
    },
    ...overrides
  } as unknown as SessionSnapshot;
}

describe('StageOverlay', () => {
  it('renders every line of the latest beat with speaker names inside one caption', () => {
    const wrapper = mount(StageOverlay, { props: { snapshot: snapshot(), connected: true } });
    const stories = wrapper.findAll('.stage-story');
    expect(stories).toHaveLength(1);
    const text = stories[0]!.text();
    expect(text).not.toContain('Narrator');
    expect(text).toContain('Rain taps the glass.');
    expect(text).toContain('Old Brann');
    expect(text).toContain('You are late <b>again</b>.');
    expect(wrapper.find('.stage-story b').exists()).toBe(false);
  });

  it('renders no .who for narration and system lines', () => {
    const base = snapshot();
    const line = (id: string, kind: string) => ({
      id, kind, text: `Line ${id}.`, speaker: null, recipientCharacterIds: [], delivery: 'public', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false
    });
    const history = [{ ...base.history[0]!, segments: [line('n1', 'narration'), line('s1', 'system')] }];
    const wrapper = mount(StageOverlay, { props: { snapshot: snapshot({ history }), connected: true } });
    expect(wrapper.findAll('.line')).toHaveLength(2);
    expect(wrapper.find('.stage-story .who').exists()).toBe(false);
    expect(wrapper.get('[data-segment-id="n1"]').text()).toBe('Line n1.');
  });

  it('shows an action line with its speaker, an Action tag and the words', () => {
    const base = snapshot();
    const history = [{
      ...base.history[0]!,
      segments: [{
        id: 'a1', kind: 'player_action', text: 'I climb the fire escape.', speaker: { entityId: 'c1', displayName: 'Mara Vale' },
        recipientCharacterIds: [], delivery: 'neutral', sourceSubmissionIds: ['sub1'], voiceProfileId: null, ttsEnabled: false
      }]
    }];
    const wrapper = mount(StageOverlay, { props: { snapshot: snapshot({ history }), connected: true } });
    const line = wrapper.get('[data-segment-id="a1"]');
    expect(line.classes()).toEqual(expect.arrayContaining(['line', 'player', 'action']));
    expect(line.get('.who').text()).toBe('Mara Vale');
    expect(line.get('.who').element.nextElementSibling?.className).toBe('line-tag');
    expect(line.get('.line-tag').text()).toBe('Action');
    expect(line.get('.said').text()).toBe('I climb the fire escape.');
    expect(cssRule('.line-tag')).toContain('var(--font-label)');
    expect(cssRule('.line-tag')).toContain('text-transform: uppercase');
    expect(cssRule('.line-tag')).toContain('var(--dust)');
  });

  it('clips the stakes text inside the frame', () => {
    const rule = cssRule('.wager-body');
    expect(rule).toContain('max-height: calc(612px - 32px)');
    expect(rule).toContain('overflow: hidden');
  });

  it('draws one roll per roll in cast order, and nowhere else', () => {
    const wrapper = mount(StageOverlay, { props: { snapshot: snapshot(), connected: true } });
    const rolls = wrapper.findAll('.roll');
    expect(rolls).toHaveLength(2);
    expect(rolls[0]!.text()).toContain('Mara Vale');
    expect(rolls[0]!.text()).toContain('Clean success');
    expect(rolls[0]!.text()).toContain('14');
    expect(rolls[1]!.text()).toContain('Tom Reed');
    expect(rolls[1]!.text()).toContain('Success with a cost');
  });

  it('shows the wager with goal, trait, helper credit and the three outcomes', () => {
    const text = mount(StageOverlay, { props: { snapshot: snapshot(), connected: true } }).get('.wager').text();
    expect(text).toContain('Mara Vale');
    expect(text).toContain('Pick the ledger lock');
    expect(text).toContain('Wits +2');
    expect(text).toContain('high risk');
    expect(text).toContain('With Tom Reed (+1 Edge)');
    expect(text).toContain('10+ Clean success');
    expect(text).toContain('It opens, loudly.');
    expect(text).toContain('6 or less Setback');
  });

  it('shows a blocked action as blocked, with its setback text and no dice bands', () => {
    const blocked = snapshot();
    const beat = blocked.activeBeat as unknown as { stakes: Array<Record<string, unknown>> };
    beat.stakes = [{ ...beat.stakes[0], ruling: 'blocked' }];
    const wrapper = mount(StageOverlay, { props: { snapshot: blocked, connected: true } });
    const text = wrapper.get('.wager').text();
    expect(text).toContain('Blocked');
    expect(text).toContain('It jams.');
    expect(text).toContain('With Tom Reed');
    expect(text).not.toContain('(+1 Edge)');
    expect(text).not.toContain('Wits +2');
    expect(text).not.toContain('10+ Clean success');
    expect(wrapper.findAll('.wager-outcomes p')).toHaveLength(1);
  });

  describe('wager spotlight', () => {
    const cast = [
      { id: 'c1', displayName: 'Mara Vale', traits: { force: 0, finesse: 1, wits: 2, presence: 1 }, strain: 0, appearance: '', approved: true, ready: true },
      { id: 'c2', displayName: 'Tom Reed', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, strain: 0, appearance: '', approved: true, ready: true },
      { id: 'c3', displayName: 'Ivy Holt', traits: { force: 1, finesse: 3, wits: 0, presence: 1 }, strain: 0, appearance: '', approved: true, ready: true },
      { id: 'c4', displayName: 'Bram Kettle', traits: { force: 1, finesse: 0, wits: 1, presence: 3 }, strain: 0, appearance: '', approved: true, ready: true }
    ];
    const long = (who: string, what: string) => `${who} ${what}, and the whole room turns to watch while the tide keeps rising under the pier.`;
    function stake(id: string, actor: string, name: string, helpers: string[] = []) {
      return {
        id, version: 1, actorCharacterId: actor, helperCharacterIds: helpers, intent: `${name} goal`, approach: 'Carefully', ruling: 'check',
        trait: 'presence', edge: helpers.length ? 1 : 0, edgeReason: helpers.length ? 'Help' : null, risk: 'medium',
        outcomes: { clean: long(name, 'wins clean'), costly: long(name, 'wins at a price'), setback: long(name, 'loses ground') }
      };
    }
    const fourStakes = () => snapshot({
      characters: cast,
      activeBeat: {
        id: 'b2', kind: 'action', phase: 'locked', revision: 1, locked: true,
        stakes: [stake('k4', 'c4', 'Bram Kettle'), stake('k2', 'c2', 'Tom Reed', ['c3']), stake('k1', 'c1', 'Mara Vale'), stake('k3', 'c3', 'Ivy Holt')]
      }
    });
    const order = ['Mara Vale', 'Tom Reed', 'Ivy Holt', 'Bram Kettle'];

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('shows one actor at a time in cast order every 8 seconds, with every outcome in full, and wraps', async () => {
      const wrapper = mount(StageOverlay, { props: { snapshot: fourStakes(), connected: true } });
      for (let turn = 0; turn < 6; turn++) {
        const name = order[turn % 4]!;
        const banner = wrapper.get('.wager');
        expect(banner.get('.wager-goal strong').text()).toBe(name);
        expect(banner.get('.wager-goal').text()).toContain(`${name} goal`);
        expect(banner.get('.wager-detail').text()).toContain('medium risk');
        expect(banner.get('.wager-marker').text()).toBe(`${(turn % 4) + 1} of 4`);
        const outcomes = banner.findAll('.wager-outcomes p');
        expect(outcomes.map(p => p.get('span').text())).toEqual(['10+ Clean success', '7-9 Success with a cost', '6 or less Setback']);
        expect(outcomes.map(p => p.get('em').text())).toEqual([long(name, 'wins clean'), long(name, 'wins at a price'), long(name, 'loses ground')]);
        for (const other of order.filter(each => each !== name)) expect(banner.get('.wager-goal').text()).not.toContain(other);
        expect(banner.text()).not.toMatch(/\+\d+ more/);
        if (name === 'Tom Reed') expect(banner.get('.wager-detail').text()).toBe('Presence +0 · medium risk · With Ivy Holt (+1 Edge)');
        vi.advanceTimersByTime(7999);
        await nextTick();
        expect(wrapper.get('.wager-goal strong').text()).toBe(name);
        vi.advanceTimersByTime(1);
        await nextTick();
      }
    });

    it('goes back to the first actor when the stakes change, and stops its timer on unmount', async () => {
      const wrapper = mount(StageOverlay, { props: { snapshot: fourStakes(), connected: true } });
      vi.advanceTimersByTime(16000);
      await nextTick();
      expect(wrapper.get('.wager-marker').text()).toBe('3 of 4');
      const next = fourStakes();
      const beat = next.activeBeat as unknown as { stakes: ReturnType<typeof stake>[] };
      beat.stakes = beat.stakes.filter(each => each.id !== 'k3');
      await wrapper.setProps({ snapshot: next });
      expect(wrapper.get('.wager-goal strong').text()).toBe('Mara Vale');
      expect(wrapper.get('.wager-marker').text()).toBe('1 of 3');
      expect(vi.getTimerCount()).toBe(1);
      wrapper.unmount();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('shows no marker and runs no timer for a single stake', () => {
      const wrapper = mount(StageOverlay, { props: { snapshot: snapshot({ history: [] }), connected: true } });
      expect(wrapper.find('.wager').exists()).toBe(true);
      expect(wrapper.find('.wager-marker').exists()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('holds back the previous dice while stakes are up, keeping every roll in the page', async () => {
    const wrapper = mount(StageOverlay, { props: { snapshot: snapshot(), connected: true } });
    expect(wrapper.get('.dice').classes()).toContain('dice-held');
    expect(wrapper.findAll('.roll')).toHaveLength(2);
    await wrapper.setProps({ snapshot: snapshot({ activeBeat: { id: 'b2', kind: 'action', phase: 'collecting', revision: 0, locked: false } }) });
    expect(wrapper.get('.dice').classes()).not.toContain('dice-held');
    expect(wrapper.findAll('.roll')).toHaveLength(2);
    expect(overlaySource).toMatch(/\.dice\.dice-held \{[^}]*visibility: hidden/);
  });

  it('lets the wager banner grow without crossing y 752, and wraps outcome text at 24px or more', () => {
    const wager = cssRule('.wager');
    expect(wager).toMatch(/left: 480px/);
    expect(wager).toMatch(/top: 140px/);
    expect(wager).toMatch(/width: 960px/);
    expect(wager).not.toMatch(/(?:^|[;\s])height: \d+px/);
    expect(140 + Number(wager.match(/max-height: (\d+)px/)?.[1])).toBeLessThanOrEqual(752);
    const em = cssRule('.wager-outcomes em');
    expect(em).not.toMatch(/nowrap|ellipsis/);
    expect(em).toMatch(/line-clamp: 3/);
    expect(Number(em.match(/font-size: (\d+)px/)?.[1])).toBeGreaterThanOrEqual(24);
    expect(overlaySource).not.toContain('more`');
    const animated = overlaySource.match(/animation:[^;]*/g) ?? [];
    expect(animated.length).toBeGreaterThan(0);
    const motion = overlaySource.slice(overlaySource.indexOf('@media (prefers-reduced-motion: no-preference)'));
    for (const each of animated) expect(motion).toContain(each);
  });

  it('gives each outcome its own full-width row, with the label above the text', () => {
    expect(cssRule('.wager-outcomes')).toMatch(/grid-template-columns: minmax\(0, 1fr\);/);
    const row = cssRule('.wager-outcomes p');
    expect(row).toMatch(/display: grid;/);
    expect(row).toMatch(/grid-template-columns: minmax\(0, 1fr\);/);
    const outcomes = mount(StageOverlay, { props: { snapshot: snapshot(), connected: true } }).findAll('.wager-outcomes p');
    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes) expect(Array.from(outcome.element.children).map(child => child.tagName)).toEqual(['SPAN', 'EM']);
  });

  it('treats a director-shaped snapshot as having no wager', () => {
    const director = snapshot({ role: 'director', activeBeat: { id: 'b2', phase: 'collecting', contracts: [] } });
    const wrapper = mount(StageOverlay, { props: { snapshot: director, connected: true } });
    expect(wrapper.find('.wager').exists()).toBe(false);
    const noStakes = snapshot({ activeBeat: { id: 'b2', kind: 'action', phase: 'collecting', revision: 0, locked: false } });
    expect(mount(StageOverlay, { props: { snapshot: noStakes, connected: true } }).find('.wager').exists()).toBe(false);
  });

  it('shows the badge, cast chips with Needs help at strain 4, and at most two enabled tracks', () => {
    const wrapper = mount(StageOverlay, { props: { snapshot: snapshot(), connected: true } });
    expect(wrapper.text()).toContain('AI-generated narration and character voices');
    expect(wrapper.text()).toContain('Live');
    const chips = wrapper.findAll('.chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]!.text()).toContain('Needs help');
    expect(chips[1]!.text()).not.toContain('Needs help');
    const rail = wrapper.get('.rail').text();
    expect(rail).toContain('Signal');
    expect(rail).toContain('Tide');
    expect(rail).not.toContain('Third');
    expect(rail).not.toContain('Off');
  });

  it('shows a compact slate when paused and hides the story, dice and wager', () => {
    const wrapper = mount(StageOverlay, { props: { snapshot: snapshot({}, 'paused'), connected: true } });
    const slate = wrapper.get('.stage-slate');
    expect(slate.classes()).toContain('compact');
    expect(slate.text()).toContain('We’ll be right back');
    expect(wrapper.text()).toContain('Paused');
    expect(wrapper.find('.stage-story').exists()).toBe(false);
    expect(wrapper.find('.roll').exists()).toBe(false);
    expect(wrapper.find('.wager').exists()).toBe(false);
  });

  describe('caption chunks', () => {
    const words = (count: number, word = 'tide') => Array.from({ length: count }, () => word).join(' ');
    function segment(id: string, text: string, speaker: string | null = null) {
      return {
        id, kind: speaker ? 'player_dialogue' : 'narration', text, speaker: speaker ? { entityId: `e-${id}`, displayName: speaker } : null,
        recipientCharacterIds: [], delivery: 'public', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false
      };
    }
    function beat(id: string, segments: ReturnType<typeof segment>[]) {
      return { id, kind: 'action', beatNumber: 1, actionRoundNumber: 1, stateRevision: 1, publishedAt: '2026-10-20T10:00:00.000Z', textOnly: true, segments, rolls: [], outcomes: [] };
    }
    const fiveLines = beat('b1', [
      segment('g1', 'Rain taps the glass.', 'Mara Vale'),
      segment('g2', 'Tom checks the door.', 'Tom Reed'),
      segment('g3', words(25)),
      segment('g4', words(5)),
      segment('g5', 'The lamp goes out.')
    ]);
    let heights: Record<string, number> = {};
    let spies: { mockRestore(): void }[] = [];
    const flush = async () => { for (let i = 0; i < 5; i++) await nextTick(); };
    const shown = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('.stage-story .line')
      .filter(line => !line.classes().includes('off-chunk')).map(line => line.attributes('data-segment-id'));

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      heights = { g1: 48, g2: 48, g3: 96, g4: 48, g5: 48 };
      spies = [
        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
          return heights[this.dataset.segmentId ?? ''] ?? 0;
        }),
        vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
          return this.classList.contains('caption-window') ? 144 : 0;
        })
      ];
    });
    afterEach(() => {
      spies.forEach(spy => spy.mockRestore());
      vi.useRealTimers();
    });

    it('opens on the first chunk, which starts with the first segment, and keeps every segment in the caption', async () => {
      const wrapper = mount(StageOverlay, { props: { snapshot: snapshot({ history: [fiveLines] }), connected: true } });
      await flush();
      expect(shown(wrapper)).toEqual(['g1', 'g2']);
      expect(wrapper.get('[data-segment-id="g1"]').classes()).toContain('chunk-start');
      const all = wrapper.findAll('.stage-story .line');
      expect(all.map(line => line.attributes('data-segment-id'))).toEqual(['g1', 'g2', 'g3', 'g4', 'g5']);
      expect(all.filter(line => line.classes().includes('off-chunk')).map(line => line.attributes('data-segment-id'))).toEqual(['g3', 'g4', 'g5']);
      const text = wrapper.get('.stage-story').text();
      for (const part of ['Mara Vale', 'Rain taps the glass.', 'Tom Reed', 'Tom checks the door.', 'The lamp goes out.']) expect(text).toContain(part);
    });

    it('advances by reading time, at least four seconds a chunk, and holds on the last chunk', async () => {
      const wrapper = mount(StageOverlay, { props: { snapshot: snapshot({ history: [fiveLines] }), connected: true } });
      await flush();
      vi.advanceTimersByTime(3999);
      await flush();
      expect(shown(wrapper)).toEqual(['g1', 'g2']);
      vi.advanceTimersByTime(1);
      await flush();
      expect(shown(wrapper)).toEqual(['g3', 'g4']);
      vi.advanceTimersByTime(11999);
      await flush();
      expect(shown(wrapper)).toEqual(['g3', 'g4']);
      vi.advanceTimersByTime(1);
      await flush();
      expect(shown(wrapper)).toEqual(['g5']);
      vi.advanceTimersByTime(120000);
      await flush();
      expect(shown(wrapper)).toEqual(['g5']);
      expect(wrapper.findAll('.stage-story .line')).toHaveLength(5);
    });

    it('follows the narrated segment and only moves on by itself once narration stops', async () => {
      const wrapper = mount(StageOverlay, { props: { snapshot: snapshot({ history: [fiveLines] }), connected: true } });
      await flush();
      await wrapper.setProps({ activeSegmentId: 'g4' });
      await flush();
      expect(shown(wrapper)).toEqual(['g3', 'g4']);
      vi.advanceTimersByTime(60000);
      await flush();
      expect(shown(wrapper)).toEqual(['g3', 'g4']);
      await wrapper.setProps({ activeSegmentId: 'g1' });
      await flush();
      expect(shown(wrapper)).toEqual(['g1', 'g2']);
      await wrapper.setProps({ activeSegmentId: 'g5' });
      await flush();
      expect(shown(wrapper)).toEqual(['g5']);
      await wrapper.setProps({ activeSegmentId: 'g2' });
      await flush();
      await wrapper.setProps({ activeSegmentId: null });
      await flush();
      expect(shown(wrapper)).toEqual(['g1', 'g2']);
      vi.advanceTimersByTime(4000);
      await flush();
      expect(shown(wrapper)).toEqual(['g5']);
    });

    it('shows the chunks narration skipped over once narration stops, then holds on the last chunk', async () => {
      const wrapper = mount(StageOverlay, { props: { snapshot: snapshot({ history: [fiveLines] }), connected: true } });
      await flush();
      const seen = new Set<string>();
      const record = () => shown(wrapper).forEach(id => seen.add(id!));
      record();
      for (const id of ['g5']) {
        await wrapper.setProps({ activeSegmentId: id });
        await flush();
        record();
        vi.advanceTimersByTime(10000);
        await flush();
        record();
      }
      await wrapper.setProps({ activeSegmentId: null });
      await flush();
      for (let elapsed = 0; elapsed < 60000; elapsed += 500) {
        vi.advanceTimersByTime(500);
        await flush();
        record();
      }
      expect([...seen].sort()).toEqual(['g1', 'g2', 'g3', 'g4', 'g5']);
      expect(shown(wrapper)).toEqual(['g5']);
    });

    it('goes back to the earliest unseen chunk when narration ends on the last chunk', async () => {
      const wrapper = mount(StageOverlay, { props: { snapshot: snapshot({ history: [fiveLines] }), connected: true } });
      await flush();
      await wrapper.setProps({ activeSegmentId: 'g5' });
      await flush();
      expect(shown(wrapper)).toEqual(['g5']);
      await wrapper.setProps({ activeSegmentId: null });
      await flush();
      expect(shown(wrapper)).toEqual(['g5']);
      vi.advanceTimersByTime(3999);
      await flush();
      expect(shown(wrapper)).toEqual(['g5']);
      vi.advanceTimersByTime(1);
      await flush();
      expect(shown(wrapper)).toEqual(['g1', 'g2']);
      vi.advanceTimersByTime(4000);
      await flush();
      expect(shown(wrapper)).toEqual(['g3', 'g4']);
      vi.advanceTimersByTime(12000);
      await flush();
      expect(shown(wrapper)).toEqual(['g5']);
      vi.advanceTimersByTime(120000);
      await flush();
      expect(shown(wrapper)).toEqual(['g5']);
    });

    it('shows a chunk cut short by narration again for its full reading time, then holds on the last chunk', async () => {
      const wrapper = mount(StageOverlay, { props: { snapshot: snapshot({ history: [fiveLines] }), connected: true } });
      await flush();
      vi.advanceTimersByTime(1000);
      await flush();
      expect(shown(wrapper)).toEqual(['g1', 'g2']);
      await wrapper.setProps({ activeSegmentId: 'g3' });
      await flush();
      expect(shown(wrapper)).toEqual(['g3', 'g4']);
      await wrapper.setProps({ activeSegmentId: 'g4' });
      await flush();
      await wrapper.setProps({ activeSegmentId: null });
      await flush();
      expect(shown(wrapper)).toEqual(['g3', 'g4']);
      vi.advanceTimersByTime(11999);
      await flush();
      expect(shown(wrapper)).toEqual(['g3', 'g4']);
      vi.advanceTimersByTime(1);
      await flush();
      expect(shown(wrapper)).toEqual(['g1', 'g2']);
      vi.advanceTimersByTime(3999);
      await flush();
      expect(shown(wrapper)).toEqual(['g1', 'g2']);
      vi.advanceTimersByTime(1);
      await flush();
      expect(shown(wrapper)).toEqual(['g5']);
      const replayed: string[][] = [];
      for (let elapsed = 0; elapsed < 120000; elapsed += 1000) {
        vi.advanceTimersByTime(1000);
        await flush();
        replayed.push(shown(wrapper) as string[]);
      }
      expect(replayed.every(ids => ids.join() === 'g5')).toBe(true);
    });

    it('brings back player lines that shared a chunk with a briefly narrated line, for their full reading time', async () => {
      heights = { p1: 48, p2: 48, n1: 48, n2: 96, n3: 48 };
      const mixed = beat('b1', [
        segment('p1', 'Mara, where did the old owner go?', 'Tom Reed'),
        segment('p2', 'And what about the ledger he kept?', 'Mara Vale'),
        segment('n1', 'She laughs.'),
        segment('n2', words(20)),
        segment('n3', words(5))
      ]);
      const wrapper = mount(StageOverlay, { props: { snapshot: snapshot({ history: [mixed] }), connected: true } });
      await flush();
      expect(shown(wrapper)).toEqual(['p1', 'p2', 'n1']);
      vi.advanceTimersByTime(1000);
      await wrapper.setProps({ activeSegmentId: 'n1' });
      await flush();
      expect(shown(wrapper)).toEqual(['p1', 'p2', 'n1']);
      vi.advanceTimersByTime(1000);
      await wrapper.setProps({ activeSegmentId: 'n2' });
      await flush();
      expect(shown(wrapper)).toEqual(['n2', 'n3']);
      vi.advanceTimersByTime(5000);
      await wrapper.setProps({ activeSegmentId: 'n3' });
      await flush();
      vi.advanceTimersByTime(3000);
      await wrapper.setProps({ activeSegmentId: null });
      await flush();
      expect(shown(wrapper)).toEqual(['n2', 'n3']);
      vi.advanceTimersByTime(9999);
      await flush();
      expect(shown(wrapper)).toEqual(['n2', 'n3']);
      vi.advanceTimersByTime(1);
      await flush();
      expect(shown(wrapper)).toEqual(['p1', 'p2', 'n1']);
      for (let elapsed = 0; elapsed < 6300; elapsed += 100) {
        vi.advanceTimersByTime(100);
        await flush();
        expect(shown(wrapper), `after ${elapsed + 100} ms`).toEqual(['p1', 'p2', 'n1']);
      }
      vi.advanceTimersByTime(100);
      await flush();
      expect(shown(wrapper)).toEqual(['n2', 'n3']);
      vi.advanceTimersByTime(60000);
      await flush();
      expect(shown(wrapper)).toEqual(['n2', 'n3']);
    });

    it('with no narration, steps chunk by chunk and holds on the last one', async () => {
      const wrapper = mount(StageOverlay, { props: { snapshot: snapshot({ history: [fiveLines] }), connected: true } });
      await flush();
      const order: string[] = [shown(wrapper).join()];
      for (let elapsed = 0; elapsed < 60000; elapsed += 500) {
        vi.advanceTimersByTime(500);
        await flush();
        const now = shown(wrapper).join();
        if (order[order.length - 1] !== now) order.push(now);
      }
      expect(order).toEqual(['g1,g2', 'g3,g4', 'g5']);
    });

    it('starts each new publication, and a caption rebuilt after a pause, at the first chunk', async () => {
      const first = snapshot({ history: [fiveLines] });
      const wrapper = mount(StageOverlay, { props: { snapshot: first, connected: true } });
      await flush();
      vi.advanceTimersByTime(4000);
      await flush();
      expect(shown(wrapper)).toEqual(['g3', 'g4']);
      Object.assign(heights, { h1: 96, h2: 96 });
      const next = beat('b9', [segment('h1', 'A bell rings.', 'Mara Vale'), segment('h2', 'Silence.')]);
      await wrapper.setProps({ snapshot: snapshot({ history: [fiveLines, next] }) });
      await flush();
      expect(shown(wrapper)).toEqual(['h1']);
      expect(wrapper.findAll('.stage-story .line').map(line => line.attributes('data-segment-id'))).toEqual(['h1', 'h2']);
      vi.advanceTimersByTime(4000);
      await flush();
      expect(shown(wrapper)).toEqual(['h2']);

      const paused = snapshot({ history: [fiveLines, next] }, 'paused');
      await wrapper.setProps({ snapshot: paused });
      await flush();
      expect(wrapper.find('.stage-story').exists()).toBe(false);
      await wrapper.setProps({ snapshot: { ...paused, session: { ...paused.session, status: 'live' } } as SessionSnapshot });
      await flush();
      expect(shown(wrapper)).toEqual(['h1']);
    });

    it('gives a segment taller than the caption its own chunk and steps it by whole lines', async () => {
      heights = { g1: 48, gt: 384, g3: 48 };
      const tall = beat('b1', [segment('g1', 'Rain taps the glass.'), segment('gt', words(40), 'Mara Vale'), segment('g3', 'The lamp goes out.')]);
      const wrapper = mount(StageOverlay, { props: { snapshot: snapshot({ history: [tall] }), connected: true } });
      await flush();
      const windowEl = wrapper.get('.caption-window').element;
      expect(shown(wrapper)).toEqual(['g1']);
      vi.advanceTimersByTime(4000);
      await flush();
      expect(shown(wrapper)).toEqual(['gt']);
      expect(windowEl.scrollTop).toBe(0);
      vi.advanceTimersByTime(6000);
      await flush();
      expect(windowEl.scrollTop).toBe(144);
      vi.advanceTimersByTime(6000);
      await flush();
      expect(windowEl.scrollTop).toBe(240);
      expect(windowEl.scrollTop % 48).toBe(0);
      vi.advanceTimersByTime(4000);
      await flush();
      expect(shown(wrapper)).toEqual(['g3']);
      expect(windowEl.scrollTop).toBe(0);
    });

    it('counts a chunk whose every segment was voiced as seen, even when it was on screen for far less than its reading time', async () => {
      heights = { a1: 96, a2: 96 };
      const pair = beat('b1', [segment('a1', 'The tide pulls at the pilings.'), segment('a2', 'A bell rings across the water.')]);
      const wrapper = mount(StageOverlay, { props: { snapshot: snapshot({ history: [pair] }), connected: true } });
      await flush();
      expect(shown(wrapper)).toEqual(['a1']);
      vi.advanceTimersByTime(1000);
      await wrapper.setProps({ activeSegmentId: 'a1' });
      await flush();
      vi.advanceTimersByTime(500);
      await wrapper.setProps({ activeSegmentId: 'a2' });
      await flush();
      expect(shown(wrapper)).toEqual(['a2']);
      await wrapper.setProps({ activeSegmentId: null });
      await flush();
      expect(shown(wrapper)).toEqual(['a2']);
      for (let elapsed = 0; elapsed < 60000; elapsed += 500) {
        vi.advanceTimersByTime(500);
        await flush();
        expect(shown(wrapper), `after ${elapsed + 500} ms`).toEqual(['a2']);
      }
    });

    it('clears its timer on unmount', async () => {
      const wrapper = mount(StageOverlay, { props: { snapshot: snapshot({ history: [fiveLines] }), connected: true } });
      await flush();
      expect(vi.getTimerCount()).toBe(1);
      wrapper.unmount();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('shows the waiting slate when nothing has been published yet', () => {
    const wrapper = mount(StageOverlay, { props: { snapshot: snapshot({ history: [], activeBeat: null }), connected: true } });
    expect(wrapper.get('.stage-slate').attributes('data-kind')).toBe('waiting');
  });

  it('shows the first wager instead of the waiting slate', () => {
    const wrapper = mount(StageOverlay, { props: { snapshot: snapshot({ history: [] }), connected: true } });
    expect(wrapper.find('.stage-slate').exists()).toBe(false);
    expect(wrapper.find('[aria-label="What is at stake"]').exists()).toBe(true);
  });

  it('marks the active line as speaking and dims narration and npc lines around it', async () => {
    const wrapper = mount(StageOverlay, { props: { snapshot: snapshot(), connected: true, activeSegmentId: 'g2' } });
    const lines = wrapper.findAll('.line');
    expect(lines[0]!.classes()).toContain('narration');
    expect(lines[0]!.classes()).toContain('dim');
    expect(lines[0]!.classes()).not.toContain('speaking');
    expect(lines[1]!.classes()).toContain('speaking');
    expect(lines[1]!.classes()).not.toContain('dim');
    await wrapper.setProps({ activeSegmentId: null });
    expect(wrapper.findAll('.speaking')).toHaveLength(0);
    expect(wrapper.findAll('.dim')).toHaveLength(0);
    await wrapper.setProps({ activeSegmentId: 'not-in-this-beat' });
    expect(wrapper.findAll('.dim')).toHaveLength(0);
  });

  it('never dims a player line, while narration and npc lines dim whenever another line is active', async () => {
    const line = (id: string, kind: string, speaker: string | null) => ({
      id, kind, text: `Line ${id}.`, speaker: speaker ? { entityId: `e-${id}`, displayName: speaker } : null,
      recipientCharacterIds: [], delivery: 'public', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false
    });
    const base = snapshot();
    const history = [{ ...base.history[0]!, segments: [line('n1', 'narration', null), line('p1', 'player_dialogue', 'Mara Vale'), line('a1', 'player_action', 'Mara Vale'), line('d1', 'npc_dialogue', 'Old Brann')] }];
    const wrapper = mount(StageOverlay, { props: { snapshot: snapshot({ history }), connected: true, activeSegmentId: 'n1' } });
    const byId = (id: string) => wrapper.get(`[data-segment-id="${id}"]`).classes();
    expect(byId('n1')).toContain('speaking');
    expect(byId('n1')).not.toContain('dim');
    expect(byId('p1')).not.toContain('dim');
    expect(byId('a1')).not.toContain('dim');
    expect(byId('d1')).toContain('dim');
    await wrapper.setProps({ activeSegmentId: 'p1' });
    expect(byId('p1')).toContain('speaking');
    expect(byId('p1')).not.toContain('dim');
    expect(byId('n1')).toContain('dim');
    expect(byId('d1')).toContain('dim');
    await wrapper.setProps({ activeSegmentId: 'd1' });
    expect(byId('p1')).not.toContain('dim');
    expect(byId('a1')).not.toContain('dim');
    expect(byId('n1')).toContain('dim');
  });

  it('puts the dice in two lines, with the name and breakdown cut first and the outcome never cut', () => {
    const roll = mount(StageOverlay, { props: { snapshot: snapshot(), connected: true } }).get('.roll');
    expect(Array.from(roll.element.children).map(child => child.className)).toEqual(['roll-total', 'roll-text']);
    const text = roll.get('.roll-text').element;
    expect(Array.from(text.children).map(child => child.className)).toEqual(['roll-head', 'roll-band']);
    expect(Array.from(text.children[0]!.children).map(child => child.className)).toEqual(['roll-who', 'roll-sum']);
    expect(Array.from(text.children[1]!.children).map(child => child.className)).toEqual(['roll-symbol', 'roll-result']);
    expect(roll.get('.roll-who').text()).toBe('Mara Vale');
    expect(roll.get('.roll-sum').text()).not.toBe('');
    expect(roll.get('.roll-result').text()).toBe('Clean success');
    for (const selector of ['.roll-band', '.roll-symbol', '.roll-result']) {
      expect(cssRule(selector)).not.toMatch(/ellipsis|overflow: hidden/);
    }
    expect(cssRule('.roll-who')).toMatch(/text-overflow: ellipsis/);
    expect(cssRule('.roll-sum')).toMatch(/text-overflow: ellipsis/);
    expect(Number(cssRule('.roll-sum').match(/flex: 0 (\d+) auto/)?.[1])).toBe(100000);
    expect(cssRule('.roll-who')).toMatch(/flex: 0 1 auto/);
    expect(cssRule('.roll')).toMatch(/flex: 1 1 0/);
    expect(cssRule('.roll')).toMatch(/min-width: 0/);
    expect(Number(cssRule('.roll-text').match(/font-size: (\d+)px/)?.[1])).toBeGreaterThanOrEqual(24);
    const dice = cssRule('.dice');
    for (const part of ['left: 240px', 'top: 762px', 'width: 1440px', 'height: 68px']) expect(dice).toContain(part);
  });

  it('marks five or more rolls as dense and keeps every outcome string in the page', () => {
    const base = snapshot();
    const rolls = Array.from({ length: 5 }, (_, index) => ({ ...base.history[0]!.rolls[index % 2]!, id: `r${index}` }));
    const history = [{ ...base.history[0]!, rolls }];
    const wrapper = mount(StageOverlay, { props: { snapshot: snapshot({ history }), connected: true } });
    expect(wrapper.get('.dice').classes()).toContain('dice-dense');
    expect(wrapper.findAll('.roll-result')).toHaveLength(5);
    expect(wrapper.findAll('.roll-sum')).toHaveLength(5);
    expect(mount(StageOverlay, { props: { snapshot: snapshot(), connected: true } }).get('.dice').classes()).not.toContain('dice-dense');
  });

  it('says Reconnecting when the socket is down', () => {
    expect(mount(StageOverlay, { props: { snapshot: snapshot(), connected: false } }).text()).toContain('Reconnecting');
  });

  it('has no controls, images, facts, corrections or forbidden classes', () => {
    const wrapper = mount(StageOverlay, { props: { snapshot: snapshot(), connected: true, activeSegmentId: 'g1' } });
    for (const tag of ['button', 'input', 'select', 'textarea', 'img', 'a']) expect(wrapper.find(tag).exists()).toBe(false);
    expect(wrapper.find('[data-testid="public-facts"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="published-correction"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Published corrections"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('The ledger is missing.');
    expect(wrapper.text()).not.toContain('Correction: it was Tuesday.');
    for (const name of ['stage', 'segment', 'cast', 'cast-person', 'track']) expect(wrapper.find(`.${name}`).exists()).toBe(false);
  });

  it('has a transparent root with no background class or inline background', () => {
    const root = mount(StageOverlay, { props: { snapshot: snapshot(), connected: true } }).get('.overlay');
    expect(root.attributes('style') ?? '').not.toMatch(/background/i);
    expect(root.classes().filter(name => /bg|background|opaque/i.test(name))).toEqual([]);
  });
  it('keeps the camera area (x 480-1440, y 200-760) clear except for the wager banner', () => {
    const css = overlaySource;
    const box = (selector: string) => {
      const rule = css.match(new RegExp('\\n\\' + selector + ' \\{([^}]*)\\}'))?.[1] ?? '';
      const px = (name: string) => Number(rule.match(new RegExp('(?:^|[;\\s])' + name + ': (\\d+)px'))?.[1]);
      return { left: px('left'), top: px('top'), width: px('width'), height: px('height') };
    };
    for (const selector of ['.dice', '.stage-story', '.slate-spot', '.cast-chips', '.rail', '.scene-corner']) {
      const { left, top, width, height } = box(selector);
      expect([left, top, width, height].every(Number.isFinite), selector).toBe(true);
      const overlapsX = left < 1440 && left + width > 480;
      const overlapsY = top < 760 && top + height > 200;
      expect(overlapsX && overlapsY, selector).toBe(false);
      expect(top + height, selector).toBeLessThanOrEqual(1020);
    }
  });

  describe('pictures', () => {
    const withPictures = (extra: Record<string, unknown> = {}) => {
      const base = snapshot();
      const characters = base.characters.map((character, index) => index === 0 ? { ...character, portraitId: 'p1' } : character);
      return snapshot({
        picturesEnabled: true, characters,
        scenePicture: { imageId: 'sp1', sceneId: 'sc', hidden: false, updatedAt: '2026-10-20T10:00:00.000Z' }, ...extra
      });
    };

    it('shows the scene picture in the corner and portraits on cast chips', () => {
      const wrapper = mount(StageOverlay, { props: { snapshot: withPictures(), connected: true } });
      const corner = wrapper.get('.overlay > img.scene-corner');
      expect(corner.attributes('alt')).toBe('The Salt Bar');
      expect(corner.attributes('src')).toContain('/images/sp1');
      const chip = wrapper.get('img.chip-portrait');
      expect(chip.attributes('alt')).toBe('Portrait of Mara Vale');
      expect(chip.attributes('src')).toContain('/images/p1');
      expect(wrapper.findAll('.chip').length).toBe(2);
      expect(wrapper.findAll('.initials')).toHaveLength(1);
      expect(wrapper.find('.line img').exists()).toBe(false);
    });

    it('falls back to initials and hides the corner picture when an image fails', async () => {
      const wrapper = mount(StageOverlay, { props: { snapshot: withPictures(), connected: true } });
      await wrapper.get('img.chip-portrait').trigger('error');
      await wrapper.get('img.scene-corner').trigger('error');
      expect(wrapper.find('img').exists()).toBe(false);
      expect(wrapper.findAll('.initials')).toHaveLength(2);
    });

    it('forgets a failed corner picture once it is hidden and tries it again when shown', async () => {
      const wrapper = mount(StageOverlay, { props: { snapshot: withPictures(), connected: true } });
      await wrapper.get('img.scene-corner').trigger('error');
      expect(wrapper.find('img.scene-corner').exists()).toBe(false);
      await wrapper.setProps({ snapshot: withPictures({ summary: 'same picture still shown' }) });
      expect(wrapper.find('img.scene-corner').exists()).toBe(false);
      await wrapper.setProps({ snapshot: withPictures({ scenePicture: null }) });
      expect(wrapper.find('img.scene-corner').exists()).toBe(false);
      await wrapper.setProps({ snapshot: withPictures() });
      expect(wrapper.find('img.scene-corner').exists()).toBe(true);
    });

    it('tries a failed chip portrait again once the snapshot moves the chip off it and back', async () => {
      const withPortrait = (portraitId: string) => {
        const base = withPictures();
        const characters = base.characters.map((character, index) => index === 0 ? { ...character, portraitId } : character);
        return { ...base, characters };
      };
      const wrapper = mount(StageOverlay, { props: { snapshot: withPortrait('p1'), connected: true } });
      await wrapper.get('img.chip-portrait').trigger('error');
      expect(wrapper.find('img.chip-portrait').exists()).toBe(false);
      await wrapper.setProps({ snapshot: withPortrait('p2') });
      expect(wrapper.get('img.chip-portrait').attributes('src')).toContain('/images/p2');
      await wrapper.setProps({ snapshot: withPortrait('p1') });
      expect(wrapper.get('img.chip-portrait').attributes('src')).toContain('/images/p1');
    });

    it('shows nothing when pictures are off, hidden or from another scene', () => {
      const off = withPictures({ picturesEnabled: false });
      expect(mount(StageOverlay, { props: { snapshot: off, connected: true } }).find('img').exists()).toBe(false);
      const stale = withPictures({ scenePicture: { imageId: 'sp1', sceneId: 'other', hidden: false, updatedAt: '2026-10-20T10:00:00.000Z' } });
      expect(mount(StageOverlay, { props: { snapshot: stale, connected: true } }).find('.scene-corner').exists()).toBe(false);
    });
  });
});
