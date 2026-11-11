// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { Roll, SessionSnapshot } from '@rpg/contracts';
import StageDice from './StageDice.vue';
import { diceSchedule } from './dice-moment';
import { sortRolls } from './stage-format';
import type { ActiveMoment } from './use-dice-moment';

const NAMES = ['Mara Vale', 'Tom Reed', 'Ida Fenn', 'Jo Pike', 'Lu Ash', 'Bo Dray', 'Cy Bell', 'Di Stroud'];
function roll(id: string, actor: string, over: Partial<Roll> = {}): Roll {
  return { id, contractId: 'k', contractVersion: 1, actorCharacterId: actor, faces: [4, 5], trait: 'wits', traitModifier: 2, edge: 0, total: 11, band: 'clean', ...over } as Roll;
}
function snapshot(rolls: Roll[]): SessionSnapshot {
  return {
    schemaVersion: 1, role: 'stage', eventSeq: 4,
    session: { id: 's1', title: 'T', status: 'live', mode: 'conversation', stateRevision: 1, beatNumber: 2, actionRoundNumber: 0, inputEpoch: 0, scene: { id: 'sc', title: 'S', description: '', locationId: 'l' } },
    characters: NAMES.map((displayName, i) => ({ id: `c${i}`, displayName, traits: { force: 0, finesse: 0, wits: 2, presence: 0 }, strain: 0, appearance: '', approved: true, ready: true })),
    npcs: [], tracks: [], facts: [], corrections: [],
    history: [{ id: 'b1', kind: 'action', beatNumber: 1, actionRoundNumber: 1, stateRevision: 1, publishedAt: '2026-10-20T10:00:00.000Z', textOnly: true, segments: [], rolls, outcomes: [] }],
    activeBeat: null,
  } as unknown as SessionSnapshot;
}
const momentOf = (snap: SessionSnapshot): ActiveMoment => ({ beatId: 'b1', startedAt: 0, schedule: diceSchedule(sortRolls(snap.history[0]!.rolls, snap.characters)), before: snap });
const markup = (html: string) => html.replace(/ data-v-[0-9a-f]+=""/g, '');

describe('the Dice piece during a dice moment', () => {
  const two = snapshot([roll('a', 'c0'), roll('b', 'c1', { faces: [1, 1], traitModifier: 0, total: 2, band: 'critical' })]);
  const moment = momentOf(two);
  const show = (elapsed: number, snap = two, extra: Record<string, unknown> = {}) =>
    mount(StageDice, { props: { snapshot: snap, connected: true, moment: momentOf(snap), elapsed, ...extra } });

  it('opens each card with only its name, then counts and stamps on schedule', () => {
    const first = moment.schedule.rolls[0]!;
    const before = show(first.countAt - 60);
    const card = before.findAll('.roll')[0]!;
    expect(card.get('.roll-who').text()).toBe('Mara Vale');
    expect(card.get('.roll-total').text()).toBe('');
    expect(card.find('.roll-band').exists()).toBe(false);
    expect(card.find('.roll-sum').exists()).toBe(false);
    expect(show(first.countAt).findAll('.roll')[0]!.get('.roll-total').text()).toBe('9');
    expect(show(first.countAt + 240).findAll('.roll')[0]!.get('.roll-total').text()).toBe('11');
    const stamped = show(first.verdictAt).findAll('.roll')[0]!;
    expect(stamped.get('.roll-result').text()).toBe('Clean success');
    expect(stamped.get('.roll-sum').text()).toBe('4 + 5 + Wits 2');
  });

  it('drops 40 px dice into the band above the cards for up to six rolls', () => {
    const wrapper = show(moment.schedule.rolls[1]!.countAt);
    const trays = wrapper.findAll('.strip-tray');
    expect(trays).toHaveLength(2);
    expect(trays.every(tray => tray.classes().includes('band'))).toBe(true);
    const dice = trays[1]!.findAll('.pixel-die');
    expect(dice.map(die => die.attributes('data-face'))).toEqual(['1', '1']);
    expect(dice[0]!.attributes('style')).toContain('width: 40px');
  });

  it('keeps the card in plain colours until its stamp, so the result is not given away', () => {
    const second = moment.schedule.rolls[1]!;
    expect(show(second.verdictAt - 60).findAll('.roll')[1]!.attributes('data-band')).toBeUndefined();
    expect(show(second.verdictAt).findAll('.roll')[1]!.attributes('data-band')).toBe('critical');
  });

  it('cracks the dice and shakes the card on a critical failure', () => {
    const second = moment.schedule.rolls[1]!;
    const card = show(second.verdictAt).findAll('.roll')[1]!;
    expect(card.findAll('.pixel-die').map(die => die.attributes('data-variant'))).toEqual(['crit', 'crit']);
    expect(card.attributes('style')).toContain('translateX(8px)');
  });

  it('tumbles the dice inside the card for seven or more rolls', () => {
    const seven = snapshot(Array.from({ length: 7 }, (_, i) => roll(`r${i}`, `c${i}`)));
    const trays = show(1000, seven).findAll('.strip-tray');
    expect(trays).toHaveLength(7);
    expect(trays.every(tray => tray.classes().includes('inside'))).toBe(true);
  });

  it('clears the dice off a crowded card at its stamp so the verdict can be read', () => {
    const seven = snapshot(Array.from({ length: 7 }, (_, i) => roll(`r${i}`, `c${i}`)));
    const first = momentOf(seven).schedule.rolls[0]!;
    const card = (elapsed: number) => show(elapsed, seven).findAll('.roll')[0]!;
    expect(card(first.verdictAt - 60).findAll('.pixel-die')).toHaveLength(2);
    expect(card(first.verdictAt).find('.pixel-die').exists()).toBe(false);
    expect(card(first.verdictAt).findAll('.strip-dust').length).toBeGreaterThan(0);
  });

  it("shows one person's rolls at the same times as everyone else", () => {
    const second = moment.schedule.rolls[1]!;
    const alone = show(second.countAt, two, { characterId: 'c1' });
    expect(alone.findAll('.roll')).toHaveLength(1);
    expect(alone.get('.roll-total').text()).toBe('2');
    expect(show(second.countAt - 60, two, { characterId: 'c1' }).get('.roll-total').text()).toBe('');
  });

  it("puffs the dice away at the settle and ends as today's card", () => {
    const settling = show(moment.schedule.settleAt);
    expect(settling.find('.pixel-die').exists()).toBe(false);
    expect(settling.findAll('.strip-dust').length).toBeGreaterThan(0);
    expect(show(moment.schedule.settleAt + 120).find('.strip-dust').exists()).toBe(false);
    const plain = mount(StageDice, { props: { snapshot: two, connected: true } });
    const after = mount(StageDice, { props: { snapshot: two, connected: true, moment: null, elapsed: 0 } });
    expect(markup(after.html())).toBe(markup(plain.html()));
  });

  it('keeps the strip as it is when this is the overlay strip (center mode)', () => {
    const wrapper = show(1000, two, { mode: 'center' });
    expect(wrapper.find('.strip-tray').exists()).toBe(false);
    expect(wrapper.get('.dice').classes()).toContain('dice-waiting');
  });
});
