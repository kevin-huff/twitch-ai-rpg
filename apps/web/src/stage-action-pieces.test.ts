// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '@rpg/contracts';
import StageDice from './StageDice.vue';
import StageStakes from './StageStakes.vue';
import StageOverlay from './StageOverlay.vue';
import diceSource from './StageDice.vue?raw';
import stakesSource from './StageStakes.vue?raw';

const cssRule = (source: string, selector: string) => source.match(new RegExp('\\n' + selector.replace(/\./g, '\\.') + ' \\{([^}]*)\\}'))?.[1] ?? '';

function roll(id: string, actor: string, total = 9) {
  return { id, contractId: 'x', contractVersion: 1, actorCharacterId: actor, faces: [3, 4], trait: 'force', traitModifier: 2, edge: 0, total, band: 'costly' };
}
function stake(id: string, actor: string, intent: string) {
  return {
    id, version: 1, actorCharacterId: actor, helperCharacterIds: [], intent, approach: 'Carefully', ruling: 'check',
    trait: 'wits', edge: 1, edgeReason: 'Help', risk: 'high', outcomes: { clean: 'It opens.', costly: 'It opens, loudly.', setback: 'It jams.' }
  };
}

function snapshot(overrides: Record<string, unknown> = {}, status: 'lobby' | 'live' | 'paused' | 'ended' = 'live', stakes: unknown[] = []): SessionSnapshot {
  return {
    schemaVersion: 1, role: 'stage', eventSeq: 4,
    session: {
      id: 's1', title: 'The Story Table', status, mode: 'conversation', stateRevision: 1, beatNumber: 2, actionRoundNumber: 0,
      inputEpoch: 0, scene: { id: 'sc', title: 'The Salt Bar', description: 'A quiet bar by the dock.', locationId: 'bar' }
    },
    characters: [
      { id: 'c1', displayName: 'Mara Vale', traits: { force: 0, finesse: 1, wits: 2, presence: 1 }, strain: 3, appearance: '', approved: true, ready: true },
      { id: 'c2', displayName: 'Tom Reed', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, strain: 1, appearance: '', approved: true, ready: true }
    ],
    npcs: [], tracks: [], facts: [], corrections: [],
    history: [{
      id: 'b1', kind: 'action', beatNumber: 1, actionRoundNumber: 1, stateRevision: 1, publishedAt: '2026-10-20T10:00:00.000Z', textOnly: true,
      segments: [], rolls: [roll('r1', 'c2'), roll('r2', 'c1', 14)], outcomes: []
    }],
    activeBeat: stakes.length ? { id: 'b2', kind: 'action', phase: 'locked', revision: 1, locked: true, stakes } : null,
    ...overrides
  } as unknown as SessionSnapshot;
}

function lastRoll(id: string, actor: string, band: string, total: number) {
  return { ...roll(id, actor, total), faces: [3, 4], band, lastChance: true };
}
function lastChanceSnap(rolls: unknown[], beat: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): SessionSnapshot {
  const base = snapshot();
  return snapshot({
    history: [{ ...base.history[0]!, rolls }],
    activeBeat: { id: 'b2', kind: 'action', phase: 'collecting', revision: 1, locked: false, stakes: [], stakesApproved: true, lastChanceFor: [], ...beat },
    ...extra
  });
}

const markup = (html: string) => html.replace(/ data-v-[0-9a-f]+=""/g, '');
const props = (snap: SessionSnapshot, characterId?: string | null) => ({ snapshot: snap, connected: true, characterId });

describe('StageDice piece', () => {
  it('draws what the overlay draws', () => {
    const snap = snapshot();
    const alone = mount(StageDice, { props: props(snap) });
    const overlay = mount(StageOverlay, { props: { snapshot: snap, connected: true } });
    expect(markup(alone.find('.dice').html())).toBe(markup(overlay.find('.dice').html()));
    expect(alone.findAll('.roll')).toHaveLength(2);
    expect(alone.findAll('.roll-who').map(w => w.text())).toEqual(['Mara Vale', 'Tom Reed']);
  });

  it('keeps only the chosen character and draws nothing for an unknown id', () => {
    const snap = snapshot();
    const one = mount(StageDice, { props: props(snap, 'c2') });
    expect(one.findAll('.roll')).toHaveLength(1);
    expect(one.get('.roll-who').text()).toBe('Tom Reed');
    expect(mount(StageDice, { props: props(snap, 'nobody') }).find('.dice').exists()).toBe(false);
  });

  it('is held while stakes are up, even when they belong to someone else', () => {
    const snap = snapshot({}, 'live', [stake('k1', 'c1', 'Pick the lock')]);
    expect(mount(StageDice, { props: props(snap) }).get('.dice').classes()).toContain('dice-held');
    expect(mount(StageDice, { props: props(snap, 'c2') }).get('.dice').classes()).toContain('dice-held');
    expect(mount(StageDice, { props: props(snapshot()) }).get('.dice').classes()).not.toContain('dice-held');
  });

  it('goes dense past four rolls and into rows past six', () => {
    const rolls = Array.from({ length: 7 }, (_, i) => roll(`r${i}`, i % 2 ? 'c1' : 'c2'));
    const base = snapshot();
    const snap = snapshot({ history: [{ ...base.history[0]!, rolls }] });
    const classes = mount(StageDice, { props: props(snap) }).get('.dice').classes();
    expect(classes).toContain('dice-dense');
    expect(classes).toContain('dice-rows');
  });

  it('draws nothing while paused, in the lobby or with no rolls', () => {
    expect(mount(StageDice, { props: props(snapshot({}, 'paused')) }).find('.dice').exists()).toBe(false);
    expect(mount(StageDice, { props: props(snapshot({}, 'lobby')) }).find('.dice').exists()).toBe(false);
    const base = snapshot();
    expect(mount(StageDice, { props: props(snapshot({ history: [{ ...base.history[0]!, rolls: [] }] })) }).find('.dice').exists()).toBe(false);
  });

  it('keeps the overlay place and size', () => {
    const rule = cssRule(diceSource, '.dice');
    expect(rule).toContain('position: absolute');
    expect(rule).toContain('left: 240px');
    expect(rule).toContain('top: 762px');
    expect(rule).toContain('width: 1440px');
    expect(rule).toContain('height: 68px');
    const rows = cssRule(diceSource, '.dice-rows');
    expect(rows).toContain('top: 686px');
    expect(rows).toContain('height: 144px');
  });

  it('marks every last-chance roll card with the words, at 1, 5 and 12 rolls', () => {
    for (const count of [1, 5, 12]) {
      const rolls = Array.from({ length: count }, (_, i) => i === 0 ? lastRoll('rl', 'c1', 'setback', 5) : roll(`r${i}`, 'c2'));
      rolls.push(...(count === 5 ? [lastRoll('rl2', 'c2', 'costly', 8)] : []));
      const wrapper = mount(StageDice, { props: props(lastChanceSnap(rolls, { phase: 'draft_review' })) });
      const cards = wrapper.findAll('.roll[data-last-chance]');
      expect(cards.length).toBeGreaterThan(0);
      for (const card of cards) {
        expect(card.get('.roll-last').text()).toBe('Last chance');
        expect(['pulls-through', 'dies']).toContain(card.attributes('data-last-chance'));
      }
      const dying = wrapper.get('.roll[data-last-chance="dies"]');
      expect(dying.get('.roll-result').text()).toBe('Dies');
      expect(dying.get('.roll-sum').text()).toBe('3 + 4');
      expect(dying.get('.roll-sum').text()).not.toContain('Last chance:');
      if (count === 5) {
        const through = wrapper.get('.roll[data-last-chance="pulls-through"]');
        expect(through.get('.roll-result').text()).toBe('Pulls through');
        expect(wrapper.findAll('.roll').filter(card => !card.attributes('data-last-chance')).every(card => !card.find('.roll-last').exists())).toBe(true);
      }
    }
  });

  it('places roll-last between the name and the faces and never hides, shrinks or cuts it', () => {
    const wrapper = mount(StageDice, { props: props(lastChanceSnap([lastRoll('rl', 'c1', 'costly', 8)])) });
    const kids = Array.from(wrapper.get('.roll-head').element.children).map(child => child.className);
    expect(kids).toEqual(['roll-who', 'roll-last', 'roll-sum']);
    expect(wrapper.get('.roll[data-last-chance]').attributes('data-band')).toBe('costly');
    expect(wrapper.get('.roll-result').text()).toBe('Pulls through');
    const rule = cssRule(diceSource, '.roll-last');
    expect(rule).toContain('flex: 0 0 auto');
    expect(rule).not.toMatch(/ellipsis|display: none|visibility|font-size/);
    for (const line of diceSource.split('\n').filter(l => l.includes('.roll-last'))) {
      expect(line).not.toMatch(/display: none|visibility: hidden|overflow: hidden|text-overflow/);
    }
  });

  it('keeps ordinary roll cards free of last-chance marks', () => {
    const wrapper = mount(StageDice, { props: props(snapshot()) });
    expect(wrapper.find('[data-last-chance]').exists()).toBe(false);
    expect(wrapper.find('.roll-last').exists()).toBe(false);
    expect(wrapper.get('.roll-result').text()).toBe('Success with a cost');
  });

  it('is held while only a last-chance card is up', () => {
    const snap = lastChanceSnap([roll('r1', 'c2')], { lastChanceFor: ['c1'] });
    expect(mount(StageDice, { props: props(snap) }).get('.dice').classes()).toContain('dice-held');
    const none = lastChanceSnap([roll('r1', 'c2')], { lastChanceFor: [] });
    expect(mount(StageDice, { props: props(none) }).get('.dice').classes()).not.toContain('dice-held');
    const unapproved = lastChanceSnap([roll('r1', 'c2')], { lastChanceFor: ['c1'], stakesApproved: false });
    expect(mount(StageDice, { props: props(unapproved) }).get('.dice').classes()).not.toContain('dice-held');
  });

  it('renders no control', () => {
    const wrapper = mount(StageDice, { props: props(snapshot()) });
    expect(wrapper.find('button, input, select, textarea, a').exists()).toBe(false);
  });
});

describe('StageStakes piece', () => {
  const two = [stake('k1', 'c1', 'Pick the lock'), stake('k2', 'c2', 'Hold the door')];

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('draws what the overlay draws', () => {
    const snap = snapshot({}, 'live', [two[0]]);
    const alone = mount(StageStakes, { props: props(snap) });
    const overlay = mount(StageOverlay, { props: { snapshot: snap, connected: true } });
    expect(markup(alone.find('.wager').html())).toBe(markup(overlay.find('.wager').html()));
    expect(alone.text()).toContain('Pick the lock');
    expect(alone.get('.wager').attributes('aria-label')).toBe('What is at stake');
  });

  it('keeps only the chosen character and draws nothing for an unknown id', () => {
    const snap = snapshot({}, 'live', two);
    const one = mount(StageStakes, { props: props(snap, 'c2') });
    expect(one.text()).toContain('Hold the door');
    expect(one.text()).not.toContain('Pick the lock');
    expect(one.find('.wager-marker').exists()).toBe(false);
    expect(mount(StageStakes, { props: props(snap, 'nobody') }).find('.wager').exists()).toBe(false);
    expect(mount(StageStakes, { props: props(snapshot({}, 'live', [two[0]]), 'c2') }).find('.wager').exists()).toBe(false);
  });

  it('draws nothing without stakes, while paused or for a director', () => {
    expect(mount(StageStakes, { props: props(snapshot()) }).find('.wager').exists()).toBe(false);
    expect(mount(StageStakes, { props: props(snapshot({}, 'paused', two)) }).find('.wager').exists()).toBe(false);
    expect(mount(StageStakes, { props: props(snapshot({ role: 'director' }, 'live', two)) }).find('.wager').exists()).toBe(false);
  });

  it('rotates the spotlight over the filtered stakes and stops its timer on unmount', async () => {
    const wrapper = mount(StageStakes, { props: props(snapshot({}, 'live', two)) });
    expect(wrapper.get('.wager-marker').text()).toBe('1 of 2');
    expect(wrapper.text()).toContain('Pick the lock');
    vi.advanceTimersByTime(8000);
    await nextTick();
    expect(wrapper.get('.wager-marker').text()).toBe('2 of 2');
    expect(wrapper.text()).toContain('Hold the door');
    expect(vi.getTimerCount()).toBe(1);
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs no timer when the filter leaves one stake', () => {
    const wrapper = mount(StageStakes, { props: props(snapshot({}, 'live', two), 'c1') });
    expect(vi.getTimerCount()).toBe(0);
    wrapper.unmount();
  });

  it('adds a last-chance card after the real stakes and counts it in the marker', async () => {
    const snap = lastChanceSnap([], { phase: 'stakes_review', stakes: [two[0]], lastChanceFor: ['c2'] });
    const wrapper = mount(StageStakes, { props: props(snap) });
    expect(wrapper.get('.wager-marker').text()).toBe('1 of 2');
    expect(wrapper.find('[data-card]').exists()).toBe(false);
    vi.advanceTimersByTime(8000);
    await nextTick();
    expect(wrapper.get('.wager-marker').text()).toBe('2 of 2');
    const card = wrapper.get('[data-card="last-chance"]');
    expect(card.get('.wager-goal').text()).toBe('Tom Reed · Last chance');
    expect(card.get('p.wager-last').text()).toBe('Tom Reed is down. If nobody saves Tom Reed this round, one roll decides: 7 or more and Tom Reed pulls through; 6 or less, or double 1s, and Tom Reed dies.');
    expect(wrapper.findAll('.wager-outcomes p')).toHaveLength(0);
  });

  it('shows the last-chance card alone for a round with no real stakes, and says it was rolled after the dice', () => {
    const before = mount(StageStakes, { props: props(lastChanceSnap([], { phase: 'collecting', lastChanceFor: ['c1'] })) });
    expect(before.find('.wager-marker').exists()).toBe(false);
    expect(before.get('.wager-last').text()).toContain('Mara Vale is down.');
    const after = mount(StageStakes, { props: props(lastChanceSnap([], { phase: 'locked', lastChanceFor: ['c1'] })) });
    expect(after.get('.wager-last').text()).toBe('Mara Vale is down. The dice are rolled. The story will tell what happens.');
    expect(after.text()).not.toMatch(/pulls through|dies/i);
  });

  it('never names a result and draws no card without approval, without ids, for another character or on a slate', () => {
    const rolled = mount(StageStakes, { props: props(lastChanceSnap([lastRoll('rl', 'c1', 'costly', 8)], { phase: 'draft_review', lastChanceFor: ['c1'] })) });
    expect(rolled.text()).not.toMatch(/pulls through|dies/i);
    expect(mount(StageStakes, { props: props(lastChanceSnap([], { lastChanceFor: ['c1'], stakesApproved: false })) }).find('.wager').exists()).toBe(false);
    expect(mount(StageStakes, { props: props(lastChanceSnap([], { lastChanceFor: [] })) }).find('.wager').exists()).toBe(false);
    expect(mount(StageStakes, { props: props(lastChanceSnap([], { lastChanceFor: ['c1'] }), 'c2') }).find('.wager').exists()).toBe(false);
    expect(mount(StageStakes, { props: props(lastChanceSnap([], { lastChanceFor: ['c1'] }, { role: 'director' })) }).find('.wager').exists()).toBe(false);
    expect(mount(StageStakes, { props: props(lastChanceSnap([], { lastChanceFor: ['c1'] }, { session: { ...snapshot().session, status: 'paused' } })) }).find('.wager').exists()).toBe(false);
  });

  it('draws the same card in the overlay and has no line clamp on it', () => {
    const snap = lastChanceSnap([], { lastChanceFor: ['c1'] });
    const alone = mount(StageStakes, { props: props(snap) });
    const overlay = mount(StageOverlay, { props: { snapshot: snap, connected: true } });
    expect(markup(alone.find('.wager').html())).toBe(markup(overlay.find('.wager').html()));
    expect(cssRule(stakesSource, '.wager-last')).not.toMatch(/line-clamp/);
    expect(cssRule(stakesSource, '.wager-last')).toContain('40px');
  });

  it('keeps the overlay place and size', () => {
    const rule = cssRule(stakesSource, '.wager');
    expect(rule).toContain('position: absolute');
    expect(rule).toContain('left: 480px');
    expect(rule).toContain('top: 140px');
    expect(rule).toContain('width: 960px');
    expect(rule).toContain('max-height: 612px');
    expect(stakesSource).toContain('\n.wager p { margin: 0; }');
  });

  it('renders no control', () => {
    const wrapper = mount(StageStakes, { props: props(snapshot({}, 'live', two)) });
    expect(wrapper.find('button, input, select, textarea, a').exists()).toBe(false);
  });
});
