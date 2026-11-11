// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '@rpg/contracts';
import StageOverlay from './StageOverlay.vue';
import StageScene from './StageScene.vue';
import { diceSchedule } from './dice-moment';
import { sortRolls } from './stage-format';
import type { ActiveMoment } from './use-dice-moment';

function roll(id: string, actor: string, total = 9) {
  return { id, contractId: 'k', contractVersion: 1, actorCharacterId: actor, faces: [3, 4], trait: 'force', traitModifier: 2, edge: 0, total, band: 'costly' };
}
function snapshot(status = 'live'): SessionSnapshot {
  return {
    schemaVersion: 1, role: 'stage', eventSeq: 4,
    session: {
      id: 's1', title: 'The Story Table', status, mode: 'conversation', stateRevision: 1, beatNumber: 2, actionRoundNumber: 0,
      inputEpoch: 0, scene: { id: 'sc', title: 'The Salt Bar', description: 'A quiet bar by the dock.', locationId: 'bar' },
    },
    characters: [
      { id: 'c1', displayName: 'Mara Vale', traits: { force: 0, finesse: 1, wits: 2, presence: 1 }, strain: 3, appearance: '', approved: true, ready: true },
      { id: 'c2', displayName: 'Tom Reed', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, strain: 1, appearance: '', approved: true, ready: true },
    ],
    npcs: [], tracks: [], facts: [], corrections: [],
    history: [{
      id: 'b1', kind: 'action', beatNumber: 1, actionRoundNumber: 1, stateRevision: 1, publishedAt: '2026-10-20T10:00:00.000Z', textOnly: true,
      segments: [], rolls: [roll('r1', 'c2'), roll('r2', 'c1', 14)], outcomes: [],
    }],
    activeBeat: null,
  } as unknown as SessionSnapshot;
}
function momentFor(snap: SessionSnapshot, beatId = 'b1'): ActiveMoment {
  return { beatId, startedAt: 0, schedule: diceSchedule(sortRolls(snap.history[0]!.rolls, snap.characters)), before: snap };
}
const markup = (html: string) => html.replace(/ data-v-[0-9a-f]+=""/g, '');

describe.each([
  { name: 'overlay', component: StageOverlay, layout: 'overlay' },
  { name: 'scene', component: StageScene, layout: 'scene' },
] as const)('the dice moment on the $name', ({ component, layout }) => {
  const show = (snap: SessionSnapshot, extra: Record<string, unknown> = {}) =>
    mount(component as typeof StageOverlay, { props: { snapshot: snap, connected: true, ...extra } as never });

  it('shows the window and hides the dice until the totals land', () => {
    const snap = snapshot();
    const moment = momentFor(snap);
    const during = show(snap, { diceMoment: moment, diceElapsed: 1000 });
    expect(during.get('.dice-moment').attributes('data-layout')).toBe(layout);
    expect(during.get('.dice').classes()).toContain('dice-waiting');
    expect(during.findAll('[data-dice-target]').map(el => el.attributes('data-dice-target'))).toEqual(['r2', 'r1']);
    const landed = show(snap, { diceMoment: moment, diceElapsed: moment.schedule.revealAt });
    expect(landed.get('.dice').classes()).not.toContain('dice-waiting');
  });

  it('renders exactly as today with no moment', () => {
    const snap = snapshot();
    const plain = show(snap);
    const empty = show(snap, { diceMoment: null, diceElapsed: 0 });
    expect(plain.find('.dice-moment').exists()).toBe(false);
    expect(markup(empty.html())).toBe(markup(plain.html()));
    expect(plain.find('[data-dice-target]').exists()).toBe(false);
  });

  it('ignores a moment for an older beat', () => {
    const snap = snapshot();
    const wrapper = show(snap, { diceMoment: momentFor(snap, 'b0'), diceElapsed: 1000 });
    expect(wrapper.find('.dice-moment').exists()).toBe(false);
    expect(wrapper.get('.dice').classes()).not.toContain('dice-waiting');
  });

  it('drops the window under a slate', () => {
    const snap = snapshot('paused');
    const wrapper = show(snap, { diceMoment: momentFor(snap), diceElapsed: 1000 });
    expect(wrapper.find('.dice-moment').exists()).toBe(false);
  });
});
