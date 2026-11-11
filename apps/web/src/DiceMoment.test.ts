// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Roll, SessionSnapshot } from '@rpg/contracts';
import DiceMoment from './DiceMoment.vue';
import { diceSchedule, flickerFaces } from './dice-moment';
import type { ActiveMoment } from './use-dice-moment';

function roll(over: Partial<Roll> = {}): Roll {
  return { id: 'r1', contractId: 'k', contractVersion: 1, actorCharacterId: 'c1', faces: [3, 4], trait: 'force', traitModifier: 0, edge: 0, total: 7, band: 'costly', ...over } as Roll;
}
const snapshot = {
  characters: [{ id: 'c1', displayName: 'Mara Vale' }, { id: 'c2', displayName: 'Tom Reed' }, { id: 'c3', displayName: 'Ida' }],
} as unknown as SessionSnapshot;
const momentOf = (rolls: Roll[]): ActiveMoment => ({ beatId: 'b2', startedAt: 0, schedule: diceSchedule(rolls), before: snapshot });
const show = (rolls: Roll[], elapsed: number, layout: 'overlay' | 'scene' = 'overlay') =>
  mount(DiceMoment, { props: { moment: momentOf(rolls), elapsed, snapshot, layout } });

afterEach(() => vi.restoreAllMocks());

describe('DiceMoment', () => {
  it('opens the window where the stakes sit and lays out one cell per roll', () => {
    const wrapper = show([roll({ id: 'a' }), roll({ id: 'b', actorCharacterId: 'c2' }), roll({ id: 'c', actorCharacterId: 'c3' })], 0);
    const style = wrapper.get('.moment-window').attributes('style');
    expect(style).toContain('left: 480px');
    expect(style).toContain('top: 140px');
    expect(style).toContain('width: 960px');
    expect(style).toContain('height: 612px');
    expect(wrapper.findAll('.moment-cell').map(cell => cell.attributes('data-roll-id'))).toEqual(['a', 'b', 'c']);
    expect(wrapper.findAll('.cell-name').map(name => name.text())).toEqual(['Mara Vale', 'Tom Reed', 'Ida']);
  });

  it('covers the story panel on the full scene', () => {
    const style = show([roll()], 0, 'scene').get('.moment-window').attributes('style');
    expect(style).toContain('left: 96px');
    expect(style).toContain('width: 1204px');
  });

  it('marks a last chance in the name row', () => {
    const wrapper = show([roll({ lastChance: true, faces: [5, 4], total: 9 })], 0);
    expect(wrapper.get('.cell-last').text()).toBe('Last chance');
  });

  it('shows flicker faces in flight and the real faces after landing', () => {
    const rolls = [roll({ id: 'a', faces: [6, 2], total: 8 })];
    const schedule = diceSchedule(rolls);
    const first = schedule.rolls[0]!.dice[0];
    const flying = show(rolls, first.throwAt + 3 * 60).findAll('.pixel-die');
    expect(flying[0]!.attributes('data-face')).toBe(String(flickerFaces('a', 0, 24)[3]));
    const landed = show(rolls, schedule.rolls[0]!.countAt).findAll('.pixel-die');
    expect(landed.map(die => die.attributes('data-face'))).toEqual(['6', '2']);
  });

  it('counts up from the sum to the total, showing each chip with its step', () => {
    const rolls = [roll({ faces: [4, 5], traitModifier: 2, edge: 1, total: 12, band: 'clean' })];
    const at = diceSchedule(rolls).rolls[0]!.countAt;
    expect(show(rolls, at - 60).get('.cell-total').text()).toBe('');
    const sum = show(rolls, at);
    expect(sum.get('.cell-total').text()).toBe('9');
    expect(sum.findAll('.cell-chip')).toHaveLength(0);
    const trait = show(rolls, at + 120);
    expect(trait.get('.cell-total').text()).toBe('10');
    expect(trait.get('[data-chip="trait"]').text()).toBe('+2 Force');
    const edge = show(rolls, at + 360);
    expect(edge.get('.cell-total').text()).toBe('12');
    expect(edge.get('[data-chip="edge"]').text()).toBe('+1 Edge');
  });

  it('stamps the verdict with its band after verdictAt', () => {
    const rolls = [roll({ faces: [5, 6], total: 11, band: 'clean' })];
    const at = diceSchedule(rolls).rolls[0]!.verdictAt;
    expect(show(rolls, at - 60).find('.cell-verdict').exists()).toBe(false);
    const verdict = show(rolls, at).get('.cell-verdict');
    expect(verdict.text()).toBe('Clean success');
    expect(verdict.attributes('data-band')).toBe('clean');
    expect(show(rolls, at).findAll('.cell-sparkle').length).toBe(8);
  });

  it('flashes the total for a success with a cost', () => {
    const rolls = [roll()];
    const at = diceSchedule(rolls).rolls[0]!.verdictAt;
    expect(show(rolls, at).get('.cell-total').classes()).toContain('flash');
    expect(show(rolls, at + 180).get('.cell-total').classes()).not.toContain('flash');
  });

  it('shakes a setback cell and cracks critical dice', () => {
    const setback = [roll({ faces: [1, 3], total: 4, band: 'setback' })];
    const at = diceSchedule(setback).rolls[0]!.verdictAt;
    expect(show(setback, at).get('.moment-cell').attributes('style')).toContain('translateX(4px)');
    expect(show(setback, at).findAll('.pixel-die').map(die => die.attributes('data-variant'))).toEqual(['plain', 'plain']);
    const critical = [roll({ faces: [1, 1], total: 2, band: 'critical' })];
    const crit = diceSchedule(critical).rolls[0]!.verdictAt;
    expect(show(critical, crit).get('.moment-cell').attributes('style')).toContain('translateX(8px)');
    expect(show(critical, crit - 60).findAll('.pixel-die').map(die => die.attributes('data-variant'))).toEqual(['plain', 'plain']);
    expect(show(critical, crit).findAll('.pixel-die').map(die => die.attributes('data-variant'))).toEqual(['crit', 'crit']);
  });

  it('darkens the dice of a last chance that dies', () => {
    const rolls = [roll({ faces: [2, 3], total: 5, band: 'setback', lastChance: true })];
    const at = diceSchedule(rolls).rolls[0]!.verdictAt;
    const wrapper = show(rolls, at);
    expect(wrapper.get('.cell-verdict').text()).toBe('Dies');
    expect(wrapper.findAll('.pixel-die').map(die => die.attributes('data-variant'))).toEqual(['dark', 'dark']);
  });

  it('drops each total straight down in the settle when the page has no layout', () => {
    const rolls = [roll()];
    const settle = diceSchedule(rolls).settleAt;
    expect(show(rolls, settle - 60).get('.cell-total').classes()).not.toContain('dropping');
    const dropping = show(rolls, settle + 120).get('.cell-total');
    expect(dropping.classes()).toContain('dropping');
    expect(dropping.attributes('style')).toMatch(/translateY\([1-9]\d*px\)/);
  });

  it('sends each total toward its strip target in the settle when the page has a layout', async () => {
    const rolls = [roll({ id: 'a' })];
    const schedule = diceSchedule(rolls);
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.classList.contains('dice-moment')) return rect(0, 0, 960, 540) as DOMRect;
      if (this.getAttribute('data-dice-target') === 'a') return rect(120, 381, 34, 34) as DOMRect;
      if (this.classList.contains('cell-total')) return rect(300, 200, 48, 48) as DOMRect;
      return rect(0, 0, 0, 0) as DOMRect;
    });
    const Host = defineComponent({
      props: { elapsed: { type: Number, required: true } },
      setup: props => () => h('div', [h('span', { 'data-dice-target': 'a' }), h(DiceMoment, { moment: { beatId: 'b2', startedAt: 0, schedule, before: snapshot }, elapsed: props.elapsed, snapshot, layout: 'overlay' })]),
    });
    const wrapper = mount(Host, { props: { elapsed: schedule.settleAt - 60 }, attachTo: document.body });
    await wrapper.setProps({ elapsed: schedule.settleAt });
    const start = wrapper.get('.moment-flyer[data-roll-id="a"]').attributes('style');
    expect(start).toContain('left: 600px');
    expect(start).toContain('top: 400px');
    await wrapper.setProps({ elapsed: schedule.settleAt + 6 * 60 });
    const end = wrapper.get('.moment-flyer[data-roll-id="a"]').attributes('style');
    expect(end).toContain('left: 240px');
    expect(end).toContain('top: 762px');
    expect(wrapper.find('.cell-total.dropping').exists()).toBe(false);
    wrapper.unmount();
  });

  it('closes the window in the settle', () => {
    const rolls = [roll()];
    const settle = diceSchedule(rolls).settleAt;
    expect(show(rolls, settle + 180).get('.moment-window').classes()).not.toContain('closing');
    expect(show(rolls, settle + 240).get('.moment-window').classes()).toContain('closing');
  });
});
