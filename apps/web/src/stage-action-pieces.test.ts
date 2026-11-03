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
