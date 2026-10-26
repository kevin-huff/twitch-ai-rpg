// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { SessionSnapshot } from '@rpg/contracts';
import StageScene from './StageScene.vue';

const traits = { force: 0, finesse: 1, wits: 2, presence: 1 };
const characters = [
  { id: 'c1', displayName: 'Skooty Vale', traits, strain: 2, appearance: '', approved: true, ready: true },
  { id: 'c2', displayName: 'Ren Ortega', traits: { ...traits, wits: 0 }, strain: 4, appearance: '', approved: true, ready: true },
];

function beat(id: string, number: number, extra: Record<string, unknown> = {}) {
  return {
    id, kind: 'action', beatNumber: number, actionRoundNumber: 1, stateRevision: number, publishedAt: '2026-10-28T20:00:00.000Z',
    segments: [
      { id: `${id}-s1`, kind: 'narration', text: 'The lantern gutters out.', speaker: null, recipientCharacterIds: [], delivery: 'neutral', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: true },
      { id: `${id}-s2`, kind: 'npc_dialogue', text: 'Who sent you here?', speaker: { entityId: 'mara', displayName: 'Mara Vale' }, recipientCharacterIds: [], delivery: 'neutral', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: true },
      { id: `${id}-s3`, kind: 'player_dialogue', text: 'Nobody. I came alone.', speaker: { entityId: 'c1', displayName: 'Skooty Vale' }, recipientCharacterIds: [], delivery: 'neutral', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: true },
    ],
    rolls: [
      { id: `${id}-r1`, contractId: 'k1', contractVersion: 1, actorCharacterId: 'c2', faces: [3, 4], trait: 'wits', traitModifier: 0, edge: 0, total: 7, band: 'costly' },
      { id: `${id}-r2`, contractId: 'k2', contractVersion: 1, actorCharacterId: 'c1', faces: [4, 5], trait: 'wits', traitModifier: 2, edge: 1, total: 12, band: 'clean' },
    ],
    outcomes: [], textOnly: true, ...extra,
  };
}

function snapshot(extra: Record<string, unknown> = {}, status = 'live'): SessionSnapshot {
  return {
    schemaVersion: 1, role: 'stage', eventSeq: 4,
    session: { id: 'show', title: 'The Ledger Job', status, mode: 'conversation', stateRevision: 3, beatNumber: 2, actionRoundNumber: 1, inputEpoch: 0, scene: { id: 'bar', title: 'The Velvet Static', description: 'Find the missing ledger.', locationId: 'bar' } },
    characters, npcs: [], tracks: [], facts: [], activeBeat: null, history: [beat('b1', 1)], corrections: [],
    ...extra,
  } as unknown as SessionSnapshot;
}

const mountScene = (snap: SessionSnapshot, props: Record<string, unknown> = {}) =>
  mount(StageScene, { props: { snapshot: snap, connected: true, ...props } });

describe('StageScene', () => {
  it('holds every line of the latest beat with its speaker inside one .stage-story', () => {
    const wrapper = mountScene(snapshot({ history: [beat('b0', 1), beat('b1', 2)] }));
    expect(wrapper.findAll('.stage-story')).toHaveLength(1);
    const story = wrapper.get('.stage-story');
    expect(story.text()).toContain('The lantern gutters out.');
    expect(story.text()).toContain('Who sent you here?');
    expect(story.text()).toContain('Mara Vale');
    expect(story.text()).toContain('Nobody. I came alone.');
    expect(story.text()).toContain('Skooty Vale');
    expect(story.text()).toContain('Narrator');
    expect(story.text()).toContain('Character');
    expect(story.text()).toContain('Player');
    expect(wrapper.html().match(/The lantern gutters out\./g)).toHaveLength(1);
  });

  it('shows one roll per roll of the latest beat in cast order, with trait, breakdown and band', () => {
    const wrapper = mountScene(snapshot());
    const rolls = wrapper.findAll('.roll');
    expect(rolls).toHaveLength(2);
    expect(rolls[0]!.text()).toContain('12');
    expect(rolls[0]!.text()).toContain('4 + 5 + Wits 2 + Edge 1');
    expect(rolls[0]!.get('.roll-name').text()).toBe('Skooty Vale');
    expect(rolls[0]!.get('.roll-result').text()).toBe('Clean success');
    expect(rolls[1]!.get('.roll-name').text()).toBe('Ren Ortega');
    expect(rolls[1]!.get('.roll-result').text()).toBe('Success with a cost');
    expect(wrapper.findAll('.stage-story .roll')).toHaveLength(2);
  });

  it('shows every roll and lays out three per row only when there are more than four', () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({
      id: `b1-r${index + 1}`, contractId: `k${index + 1}`, contractVersion: 1, actorCharacterId: index % 2 ? 'c1' : 'c2',
      faces: [3, 4], trait: 'wits', traitModifier: 0, edge: 0, total: 7 + index, band: 'costly',
    }));
    for (const count of [1, 4]) {
      const wrapper = mountScene(snapshot({ history: [beat('b1', 1, { rolls: many(count) })] }));
      expect(wrapper.findAll('.roll')).toHaveLength(count);
      expect(wrapper.get('.dice').classes()).not.toContain('dice-dense');
    }
    for (const count of [5, 6]) {
      const wrapper = mountScene(snapshot({ history: [beat('b1', 1, { rolls: many(count) })] }));
      expect(wrapper.findAll('.roll')).toHaveLength(count);
      expect(wrapper.findAll('.stage-story .roll')).toHaveLength(count);
      expect(wrapper.get('.dice').classes()).toContain('dice-dense');
    }
  });

  it('does not clip the dice block, so no roll is cut off', () => {
    const source = readFileSync(resolve(process.cwd(), 'apps/web/src/StageScene.vue'), 'utf8');
    const rule = /\n\.dice \{[^}]*\}/.exec(source.slice(source.indexOf('<style')))![0];
    expect(rule).not.toMatch(/max-height|overflow/);
  });

  describe('dice grid', () => {
    const styleSource = () => {
      const source = readFileSync(resolve(process.cwd(), 'apps/web/src/StageScene.vue'), 'utf8');
      return source.slice(source.indexOf('<style'));
    };
    const ruleOf = (selector: string) => {
      const escaped = selector.replace(/[.[\]()]/g, '\\$&');
      return new RegExp(`\\n${escaped} \\{[^}]*\\}`).exec(styleSource())![0];
    };

    it('lays the dice out in two columns, or three when dense', () => {
      expect(ruleOf('.dice')).toMatch(/display:\s*grid/);
      expect(ruleOf('.dice')).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
      expect(ruleOf('.dice-dense')).toMatch(/grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    });

    it('cuts a long name or breakdown short with an ellipsis instead of wrapping', () => {
      for (const selector of ['.roll-name', '.roll-breakdown']) {
        const rule = ruleOf(selector);
        expect(rule).toMatch(/text-overflow:\s*ellipsis/);
        expect(rule).toMatch(/white-space:\s*nowrap/);
        expect(rule).toMatch(/overflow:\s*hidden/);
      }
    });

    it('puts the name then the breakdown on line one and the symbol then the band on line two', () => {
      const wrapper = mountScene(snapshot());
      const roll = wrapper.findAll('.roll')[0]!;
      const detail = roll.get('.roll-detail');
      expect(Array.from(roll.element.children).map(child => child.className)).toEqual(['roll-total', 'roll-detail']);
      expect(Array.from(detail.element.children).map(child => child.className)).toEqual(['roll-head', 'roll-band']);
      expect(Array.from(detail.get('.roll-head').element.children).map(child => child.className)).toEqual(['roll-name', 'roll-breakdown']);
      expect(Array.from(detail.get('.roll-band').element.children).map(child => child.className)).toEqual(['roll-symbol', 'roll-result']);
      expect(roll.get('.roll-name').text()).toBe('Skooty Vale');
      expect(roll.get('.roll-breakdown').text()).toBe('4 + 5 + Wits 2 + Edge 1');
      expect(roll.get('.roll-result').text()).toBe('Clean success');
      expect(roll.find('.roll-sep').exists()).toBe(false);
    });

    it('never cuts the band label and cuts the breakdown before the name', () => {
      const result = ruleOf('.roll-result');
      expect(result).not.toMatch(/overflow|text-overflow/);
      expect(ruleOf('.roll-band')).not.toMatch(/overflow/);
      const shrink = (rule: string) => Number(/flex:\s*0\s+(\d+)/.exec(rule)?.[1]);
      expect(shrink(ruleOf('.roll-breakdown'))).toBeGreaterThan(shrink(ruleOf('.roll-name')));
    });

    it('spans a lone roll and an odd last roll across the full row, but not an even set or a dense grid', () => {
      const many = (count: number) => Array.from({ length: count }, (_, index) => ({
        id: `b1-r${index + 1}`, contractId: `k${index + 1}`, contractVersion: 1, actorCharacterId: index % 2 ? 'c1' : 'c2',
        faces: [3, 4], trait: 'wits', traitModifier: 0, edge: 0, total: 7 + index, band: 'costly',
      }));
      const wide = (count: number) => mountScene(snapshot({ history: [beat('b1', 1, { rolls: many(count) })] }))
        .findAll('.roll').map(roll => roll.classes('roll-wide'));
      expect(wide(1)).toEqual([true]);
      expect(wide(2)).toEqual([false, false]);
      expect(wide(3)).toEqual([false, false, true]);
      expect(wide(4)).toEqual([false, false, false, false]);
      expect(wide(5)).toEqual([false, false, false, false, false]);
      expect(ruleOf('.roll-wide')).toMatch(/grid-column:\s*1\s*\/\s*-1/);
    });
  });

  it('shows no rolls when the latest beat has none, even if an older beat had them', () => {
    const wrapper = mountScene(snapshot({ history: [beat('b0', 1), beat('b1', 2, { rolls: [] })] }));
    expect(wrapper.findAll('.roll')).toHaveLength(0);
  });

  it('lists every public fact newest first in public-facts', () => {
    const wrapper = mountScene(snapshot({ facts: [{ id: 'f1', text: 'The Courier carries the key.' }, { id: 'f2', text: 'Ren is the heir.' }, { id: 'f3', text: 'The vault is flooded.' }] }));
    const facts = wrapper.get('[data-testid="public-facts"]');
    expect(facts.text()).toContain('Known to the party');
    const text = facts.text();
    expect(text).toContain('The Courier carries the key.');
    expect(text).toContain('Ren is the heir.');
    expect(text.indexOf('The vault is flooded.')).toBeLessThan(text.indexOf('The Courier carries the key.'));
  });

  it('leaves public-facts out when there are no facts', () => {
    expect(mountScene(snapshot()).find('[data-testid="public-facts"]').exists()).toBe(false);
  });

  it('shows the wager with goal, trait, helper credit and outcomes', () => {
    const stake = {
      id: 'k3', version: 1, actorCharacterId: 'c1', helperCharacterIds: ['c2'], intent: 'Pick the vault lock', approach: 'Quietly',
      ruling: 'check', trait: 'wits', edge: 1, edgeReason: 'Ren holds the light', risk: 'high',
      outcomes: { clean: 'The door opens.', costly: 'The door opens but a bell rings.', setback: 'The lock jams.' },
    };
    const wrapper = mountScene(snapshot({ activeBeat: { id: 'b2', kind: 'action', phase: 'stakes_review', revision: 1, stakes: [stake], locked: false } }));
    const text = wrapper.get('.stage-story').text();
    expect(text).toContain('What’s at stake');
    expect(text).toContain('Skooty Vale');
    expect(text).toContain('Pick the vault lock');
    expect(text).toContain('Wits +2 · high risk');
    expect(text).toContain('With Ren Ortega (+1 Edge)');
    expect(text).toContain('10+ Clean success');
    expect(text).toContain('7-9 Success with a cost');
    expect(text).toContain('6 or less Setback');
    expect(text).toContain('The lock jams.');
  });

  it('shows only the outcome a no-check ruling can produce, with no trait line or Edge', () => {
    const stake = {
      id: 'k5', version: 1, actorCharacterId: 'c1', helperCharacterIds: ['c2'], intent: 'Walk in through the open door', approach: 'Calmly',
      ruling: 'no_check', trait: 'wits', edge: 1, edgeReason: null, risk: 'low',
      outcomes: { clean: 'They are inside.', costly: 'Unused cost.', setback: 'Unused setback.' },
    };
    const wrapper = mountScene(snapshot({ activeBeat: { id: 'b2', kind: 'action', phase: 'stakes_review', revision: 1, stakes: [stake], locked: false } }));
    const text = wrapper.get('.stage-story').text();
    expect(text).toContain('No roll needed');
    expect(text).toContain('They are inside.');
    expect(text).toContain('With Ren Ortega');
    expect(text).not.toContain('(+1 Edge)');
    expect(text).not.toContain('Wits +2');
    expect(text).not.toContain('7-9 Success with a cost');
    expect(text).not.toContain('Unused setback.');
  });

  it('leaves the Edge out of the helper credit when the check has no Edge', () => {
    const stake = {
      id: 'k6', version: 1, actorCharacterId: 'c1', helperCharacterIds: ['c2'], intent: 'Pick the vault lock', approach: 'Quietly',
      ruling: 'check', trait: 'wits', edge: 0, edgeReason: null, risk: 'high',
      outcomes: { clean: 'The door opens.', costly: 'The door opens but a bell rings.', setback: 'The lock jams.' },
    };
    const text = mountScene(snapshot({ activeBeat: { id: 'b2', kind: 'action', phase: 'stakes_review', revision: 1, stakes: [stake], locked: false } })).get('.stage-story').text();
    expect(text).toContain('With Ren Ortega');
    expect(text).not.toContain('(+1 Edge)');
  });

  describe('stakes layout', () => {
    const four = ['c1', 'c2', 'c3', 'c4'].map((id, i) => ({
      id, displayName: ['Skooty Vale', 'Ren Ortega', 'Mira Cole', 'Jun Park'][i], traits, strain: 0, appearance: '', approved: true, ready: true,
    }));
    const stakeFor = (actor: string, n: number, helpers: string[] = []) => ({
      id: `k${n}`, version: 1, actorCharacterId: actor, helperCharacterIds: helpers, intent: `Goal ${actor} reaching the far side of the flooded vault`, approach: 'Quietly',
      ruling: 'check', trait: 'wits', edge: helpers.length ? 1 : 0, edgeReason: '', risk: 'high',
      outcomes: { clean: `Clean ${actor}`, costly: `Costly ${actor}`, setback: `Setback ${actor}` },
    });
    const activeWith = (list: ReturnType<typeof stakeFor>[]) => ({ id: 'b2', kind: 'action', phase: 'stakes_review', revision: 1, stakes: list, locked: false });
    const stakeSnapshot = (list: ReturnType<typeof stakeFor>[]) => snapshot({ characters: four, activeBeat: activeWith(list) });
    const shuffled = () => [stakeFor('c3', 0), stakeFor('c1', 1), stakeFor('c4', 2), stakeFor('c2', 3, ['c3'])];
    const outcomeTexts = (card: ReturnType<ReturnType<typeof mountScene>['get']>) => card.findAll('.wager-outcome-text').map(text => text.text());

    beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });
    afterEach(() => { vi.useRealTimers(); });

    it('names both actors in cast order and features one full wager at a time for two stakes', async () => {
      const wrapper = mountScene(stakeSnapshot([stakeFor('c2', 0, ['c1']), stakeFor('c1', 1)]));
      const items = wrapper.findAll('.wager-row .wager-row-item');
      expect(items.map(item => item.get('.wager-row-name').text())).toEqual(['Skooty Vale', 'Ren Ortega']);
      expect(wrapper.find('.wager-row-goal').exists()).toBe(false);
      expect(items.map(item => item.classes('current'))).toEqual([true, false]);
      expect(wrapper.find('.wager-list').exists()).toBe(false);
      expect(wrapper.findAll('.wager-card')).toHaveLength(1);
      const card = wrapper.get('.wager-card.spotlight');
      expect(card.get('.wager-name').text()).toBe('Skooty Vale');
      expect(card.get('.wager-goal').text()).toBe('Goal c1 reaching the far side of the flooded vault');
      expect(card.findAll('.wager-outcome b').map(label => label.text())).toEqual(['10+ Clean success', '7-9 Success with a cost', '6 or less Setback']);
      expect(outcomeTexts(card)).toEqual(['Clean c1', 'Costly c1', 'Setback c1']);
      expect(wrapper.get('.wager-marker').text()).toBe('1 of 2');
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(8000);
      await nextTick();
      expect(wrapper.get('.wager-marker').text()).toBe('2 of 2');
      const next = wrapper.get('.wager-card.spotlight');
      expect(next.get('.wager-name').text()).toBe('Ren Ortega');
      expect(next.get('.wager-helpers').text()).toBe('With Skooty Vale (+1 Edge)');
      expect(outcomeTexts(next)).toEqual(['Clean c2', 'Costly c2', 'Setback c2']);
      expect(wrapper.findAll('.wager-row-item').map(item => item.classes('current'))).toEqual([false, true]);
      wrapper.unmount();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('shows one full card for a single stake', () => {
      const wrapper = mountScene(stakeSnapshot([stakeFor('c3', 0)]));
      const cards = wrapper.findAll('.wager-list .wager-card');
      expect(cards).toHaveLength(1);
      expect(wrapper.find('.wager-list[data-count="1"]').exists()).toBe(true);
      expect(outcomeTexts(cards[0]!)).toEqual(['Clean c3', 'Costly c3', 'Setback c3']);
      expect(wrapper.find('.wager-row').exists()).toBe(false);
      expect(wrapper.find('.spotlight').exists()).toBe(false);
      expect(wrapper.find('.wager-marker').exists()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('names every actor in cast order and features one full wager with the full goal with a 1 of 4 marker', () => {
      const wrapper = mountScene(stakeSnapshot(shuffled()));
      const items = wrapper.findAll('.wager-row .wager-row-item');
      expect(items.map(item => item.get('.wager-row-name').text())).toEqual(['Skooty Vale', 'Ren Ortega', 'Mira Cole', 'Jun Park']);
      expect(wrapper.find('.wager-row-goal').exists()).toBe(false);
      expect(items.map(item => item.classes('current'))).toEqual([true, false, false, false]);
      expect(wrapper.find('.wager-list').exists()).toBe(false);
      const spotlights = wrapper.findAll('.wager-card.spotlight');
      expect(spotlights).toHaveLength(1);
      expect(wrapper.findAll('.wager-card')).toHaveLength(1);
      const card = spotlights[0]!;
      expect(card.get('.wager-name').text()).toBe('Skooty Vale');
      expect(card.get('.wager-goal').text()).toBe('Goal c1 reaching the far side of the flooded vault');
      expect(card.get('.wager-trait').text()).toBe('Wits +2 · high risk');
      expect(card.find('.wager-helpers').exists()).toBe(false);
      expect(card.findAll('.wager-outcome b').map(label => label.text())).toEqual(['10+ Clean success', '7-9 Success with a cost', '6 or less Setback']);
      expect(outcomeTexts(card)).toEqual(['Clean c1', 'Costly c1', 'Setback c1']);
      expect(wrapper.get('.wager-marker').text()).toBe('1 of 4');
      expect(wrapper.find('[aria-label="What is at stake"]').exists()).toBe(true);
    });

    it('moves the spotlight to the next actor every eight seconds and wraps after the last', async () => {
      const wrapper = mountScene(stakeSnapshot(shuffled()));
      vi.advanceTimersByTime(7999);
      await nextTick();
      expect(wrapper.get('.wager-marker').text()).toBe('1 of 4');
      vi.advanceTimersByTime(1);
      await nextTick();
      expect(wrapper.get('.wager-marker').text()).toBe('2 of 4');
      const card = wrapper.get('.wager-card.spotlight');
      expect(card.get('.wager-name').text()).toBe('Ren Ortega');
      expect(card.get('.wager-goal').text()).toBe('Goal c2 reaching the far side of the flooded vault');
      expect(card.get('.wager-trait').text()).toBe('Wits +2 · high risk');
      expect(card.get('.wager-helpers').text()).toBe('With Mira Cole (+1 Edge)');
      expect(outcomeTexts(card)).toEqual(['Clean c2', 'Costly c2', 'Setback c2']);
      expect(wrapper.findAll('.wager-row-item').map(item => item.classes('current'))).toEqual([false, true, false, false]);
      const names: string[] = [];
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(8000);
        await nextTick();
        names.push(`${wrapper.get('.wager-marker').text()} ${wrapper.get('.spotlight .wager-name').text()}`);
      }
      expect(names).toEqual(['3 of 4 Mira Cole', '4 of 4 Jun Park', '1 of 4 Skooty Vale']);
      expect(wrapper.findAll('.wager-card.spotlight')).toHaveLength(1);
      wrapper.unmount();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('starts the spotlight over when the stakes change, but not when the same stakes come again', async () => {
      const wrapper = mountScene(stakeSnapshot(shuffled()));
      vi.advanceTimersByTime(8000);
      await nextTick();
      expect(wrapper.get('.wager-marker').text()).toBe('2 of 4');
      await wrapper.setProps({ snapshot: stakeSnapshot(shuffled()) });
      expect(wrapper.get('.wager-marker').text()).toBe('2 of 4');
      await wrapper.setProps({ snapshot: stakeSnapshot([...shuffled(), stakeFor('c1', 9)]) });
      expect(wrapper.get('.wager-marker').text()).toBe('1 of 5');
      expect(wrapper.findAll('.wager-row-item')).toHaveLength(5);
      vi.advanceTimersByTime(7999);
      await nextTick();
      expect(wrapper.get('.wager-marker').text()).toBe('1 of 5');
      vi.advanceTimersByTime(1);
      await nextTick();
      expect(wrapper.get('.wager-marker').text()).toBe('2 of 5');
      await wrapper.setProps({ snapshot: stakeSnapshot([stakeFor('c1', 0), stakeFor('c2', 1)]) });
      expect(wrapper.get('.wager-marker').text()).toBe('1 of 2');
      expect(vi.getTimerCount()).toBe(1);
      await wrapper.setProps({ snapshot: stakeSnapshot([stakeFor('c2', 0)]) });
      expect(wrapper.findAll('.wager-list .wager-card')).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('rotates with three stakes too', async () => {
      const wrapper = mountScene(stakeSnapshot([stakeFor('c2', 0), stakeFor('c1', 1), stakeFor('c3', 2)]));
      expect(wrapper.findAll('.wager-row-item')).toHaveLength(3);
      expect(wrapper.get('.wager-marker').text()).toBe('1 of 3');
      vi.advanceTimersByTime(8000);
      await nextTick();
      expect(wrapper.get('.wager-marker').text()).toBe('2 of 3');
      expect(wrapper.get('.spotlight .wager-name').text()).toBe('Ren Ortega');
    });

    it('hides the previous dice while stakes are up and keeps every roll in the story', async () => {
      const wrapper = mountScene(snapshot({ characters: four, activeBeat: activeWith(shuffled()) }));
      expect(wrapper.get('.dice').classes()).toContain('dice-held');
      expect(wrapper.findAll('.stage-story .roll')).toHaveLength(2);
      await wrapper.setProps({ snapshot: snapshot({ characters: four, activeBeat: activeWith([stakeFor('c1', 0)]) }) });
      expect(wrapper.get('.dice').classes()).toContain('dice-held');
      expect(wrapper.findAll('.roll')).toHaveLength(2);
      await wrapper.setProps({ snapshot: snapshot({ characters: four }) });
      expect(wrapper.get('.dice').classes()).not.toContain('dice-held');
      expect(wrapper.findAll('.roll')).toHaveLength(2);
    });

    it('wraps wager text instead of cutting it, keeps it at 24px or more, and animates only when motion is welcome', () => {
      const source = readFileSync(resolve(process.cwd(), 'apps/web/src/StageScene.vue'), 'utf8');
      const css = source.slice(source.indexOf('<style'));
      const rules = [...css.matchAll(/\n(\.wager[^{]*)\{([^}]*)\}/g)];
      expect(rules.length).toBeGreaterThan(8);
      for (const [, selector, body] of rules) {
        expect(body, selector).not.toMatch(/nowrap|ellipsis/);
        for (const [, size] of body!.matchAll(/font-size:\s*([\d.]+)px/g)) expect(Number(size), selector).toBeGreaterThanOrEqual(24);
      }
      for (const [selector, lines] of [['.wager-goal', 4], ['.wager-outcome', 3]] as const) {
        const body = rules.find(([, name]) => name!.trim() === selector)![2]!;
        expect(body, selector).toMatch(new RegExp(`-webkit-line-clamp:\\s*${lines};`));
        expect(body, selector).toMatch(new RegExp(`[^-]line-clamp:\\s*${lines};`));
      }
      expect(css).not.toMatch(/wager-row-goal/);
      expect(css).not.toMatch(/\.wager-list \{[^}]*repeat\(2/);
      const spotlightHeight = /\n\.wager-card\.spotlight \{ height:\s*(\d+)px; \}/.exec(css);
      expect(Number(spotlightHeight![1])).toBeGreaterThanOrEqual(300);
      expect(Number(spotlightHeight![1])).toBeLessThanOrEqual(320);
      expect(/\n\.dice-held \{[^}]*\}/.exec(css)![0]).toMatch(/display:\s*none/);
      const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, '');
      expect(outside).not.toMatch(/animation:|transition:[^;]*border/);
      expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{[^@]*\.wager-card\.spotlight \{ animation:/);
    });
  });

  it('shows the status chip and the AI badge in every state', () => {
    expect(mountScene(snapshot()).get('.chip').text()).toBe('Live');
    expect(mountScene(snapshot()).text()).toContain('AI-generated narration and character voices');
    expect(mountScene(snapshot(), { connected: false }).get('.chip').text()).toBe('Reconnecting');
    expect(mountScene(snapshot({}, 'lobby')).get('.chip').text()).toBe('Starting soon');
    expect(mountScene(snapshot({}, 'paused')).get('.chip').text()).toBe('Paused');
    expect(mountScene(snapshot({}, 'ended')).get('.chip').text()).toBe('Ended');
    expect(mountScene(snapshot({}, 'paused')).text()).toContain('AI-generated narration and character voices');
  });

  it('shows the first wager on an empty live scene instead of the waiting slate', () => {
    const stake = {
      id: 'k1', version: 1, actorCharacterId: 'c1', helperCharacterIds: [], intent: 'Open the safe', approach: 'Quietly',
      ruling: 'check', trait: 'wits', edge: 0, edgeReason: '', risk: 'low',
      outcomes: { clean: 'It opens.', costly: 'It opens loudly.', setback: 'It jams.' },
    };
    const wrapper = mountScene(snapshot({
      history: [],
      activeBeat: { id: 'b2', kind: 'action', phase: 'stakes_review', revision: 1, stakes: [stake], locked: false },
    }));
    expect(wrapper.find('[aria-label="What is at stake"]').exists()).toBe(true);
    expect(wrapper.get('.stage-story').text()).toContain('Open the safe');
    expect(wrapper.find('.scene[data-slate]').exists()).toBe(false);
    expect(wrapper.find('[data-slate]').exists()).toBe(false);
  });

  it('renders only the newest correction, even from an older beat', () => {
    const corrections = [
      { id: 'x1', publishedBeatId: 'b1', beatNumber: 1, stateRevision: 5, recordedAt: '2026-10-28T20:05:00.000Z', publicText: 'Older fix.' },
      { id: 'x2', publishedBeatId: 'b0', beatNumber: 1, stateRevision: 9, recordedAt: '2026-10-28T20:09:00.000Z', publicText: 'Newest fix for beat one.' },
    ];
    const wrapper = mountScene(snapshot({ history: [beat('b0', 1), beat('b1', 2)], corrections }));
    const region = wrapper.get('[aria-label="Published corrections"]');
    const items = region.findAll('[data-testid="published-correction"]');
    expect(items).toHaveLength(1);
    expect(items[0]!.text()).toBe('Newest fix for beat one.');
    expect(wrapper.text()).not.toContain('Older fix.');
  });

  it('omits the corrections region when there is none', () => {
    expect(mountScene(snapshot()).find('[aria-label="Published corrections"]').exists()).toBe(false);
  });

  it.each([
    ['paused', 'We’ll be right back'],
    ['lobby', 'Starting soon'],
    ['ended', 'Thanks for watching'],
  ])('shows the %s slate in the story column', (status, headline) => {
    const wrapper = mountScene(snapshot({}, status));
    expect(wrapper.findAll('.stage-story')).toHaveLength(1);
    expect(wrapper.get('.stage-story .stage-slate').text()).toContain(headline);
    expect(wrapper.find('.line').exists()).toBe(false);
    expect(wrapper.find('.roll').exists()).toBe(false);
  });

  it('keeps the header, rail, party and corrections visible during the waiting slate', () => {
    const wrapper = mountScene(snapshot({
      history: [], facts: [{ id: 'f1', text: 'A fact known before play.' }],
      tracks: [{ id: 't1', label: 'Alarm', kind: 'danger', current: 1, max: 4, completionText: '', enabled: true }],
      corrections: [{ id: 'x1', publishedBeatId: 'b1', beatNumber: 1, stateRevision: 5, recordedAt: '2026-10-28T20:05:00.000Z', publicText: 'A fix.' }],
    }));
    expect(wrapper.get('.stage-story .stage-slate').attributes('data-kind')).toBe('waiting');
    expect(wrapper.get('[data-testid="public-facts"]').text()).toContain('A fact known before play.');
    expect(wrapper.text()).toContain('Alarm');
    expect(wrapper.text()).toContain('The Ledger Job');
    expect(wrapper.text()).toContain('Find the missing ledger.');
    expect(wrapper.text()).toContain('Skooty Vale');
    expect(wrapper.get('[data-testid="published-correction"]').text()).toBe('A fix.');
    expect(wrapper.text()).toContain('AI-generated narration and character voices');
  });

  it('shows up to three enabled tracks with their kind as a word', () => {
    const track = (n: number, enabled = true, kind = 'progress') => ({ id: `t${n}`, label: `Track ${n}`, kind, current: 1, max: 3, completionText: '', enabled });
    const wrapper = mountScene(snapshot({ tracks: [track(1, false), track(2), track(3, true, 'danger'), track(4, true, 'countdown'), track(5)] }));
    const text = wrapper.get('.rail').text();
    expect(text).not.toContain('Track 1');
    expect(text).toContain('Track 2');
    expect(text).toContain('Track 4');
    expect(text).not.toContain('Track 5');
    expect(text).toContain('Progress');
    expect(text).toContain('Danger');
    expect(text).toContain('Countdown');
    expect(text).toContain('1/3');
  });

  it('shows the scene description and the party with strain', () => {
    const wrapper = mountScene(snapshot());
    expect(wrapper.get('.rail').text()).toContain('The scene');
    expect(wrapper.get('.rail').text()).toContain('Find the missing ledger.');
    const party = wrapper.get('[aria-label="The party"]');
    expect(party.text()).toContain('Skooty Vale');
    expect(party.text()).toContain('SV');
    expect(party.text().match(/Needs help/g)).toHaveLength(1);
    expect(party.findAll('[aria-label="Strain 2 of 4"]')).toHaveLength(1);
  });

  it('shows avatar and name only when more than five characters are at the table', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...characters[0]!, id: `m${i}`, displayName: `Hero ${i}`, strain: 4 }));
    const party = mountScene(snapshot({ characters: many })).get('[aria-label="The party"]');
    expect(party.text()).toContain('Hero 5');
    expect(party.text()).not.toContain('Needs help');
    expect(party.find('.pips').exists()).toBe(false);
  });

  it('gives the matching line the speaking class and dims only when something matches', () => {
    const active = mountScene(snapshot(), { activeSegmentId: 'b1-s2' });
    const lines = active.findAll('.line');
    expect(lines).toHaveLength(3);
    expect(lines.filter(line => line.classes('speaking'))).toHaveLength(1);
    expect(lines[1]!.classes()).toContain('speaking');
    expect(active.get('.lines').classes()).toContain('has-active');

    for (const id of [undefined, null, 'unknown-segment']) {
      const idle = mountScene(snapshot(), { activeSegmentId: id });
      expect(idle.findAll('.speaking')).toHaveLength(0);
      expect(idle.get('.lines').classes()).not.toContain('has-active');
    }
  });

  it('never dims a player line, but dims narration and character lines while another line is speaking', () => {
    const source = readFileSync(resolve(process.cwd(), 'apps/web/src/StageScene.vue'), 'utf8');
    const css = source.slice(source.indexOf('<style'));
    const dim = /\n(\.lines\.has-active[^{]*)\{[^}]*opacity:\s*0\.45[^}]*\}/.exec(css)![1]!.trim();
    const wrapper = mountScene(snapshot(), { activeSegmentId: 'b1-s1' });
    const lines = wrapper.get('.lines').element;
    expect(lines.classList.contains('has-active')).toBe(true);
    const dimmed = Array.from((wrapper.element as Element).querySelectorAll(dim));
    expect(dimmed.map(line => line.getAttribute('data-segment-id'))).toEqual(['b1-s2']);
    expect(wrapper.get('.line.player_dialogue').classes()).not.toContain('speaking');
    expect(dim).toContain(':not(.player_dialogue)');
  });

  it('renders authored markup as text and never as elements', () => {
    const markup = '<img src=x onerror="alert(1)"><b>bold</b>';
    const hostile = beat('b1', 1);
    hostile.segments[1]!.text = markup;
    const wrapper = mountScene(snapshot({
      history: [hostile], facts: [{ id: 'f1', text: markup }],
      corrections: [{ id: 'x1', publishedBeatId: 'b1', beatNumber: 1, stateRevision: 1, recordedAt: '2026-10-28T20:05:00.000Z', publicText: markup }],
    }));
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('b b').exists()).toBe(false);
    expect(wrapper.findAll('.line-text')[1]!.text()).toBe(markup);
    expect(wrapper.get('[data-testid="published-correction"]').text()).toBe(markup);
  });

  it('draws no controls, images or forbidden class names', () => {
    const wrapper = mountScene(snapshot({
      facts: [{ id: 'f1', text: 'x' }],
      tracks: [{ id: 't1', label: 'Alarm', kind: 'danger', current: 1, max: 4, completionText: '', enabled: true }],
      corrections: [{ id: 'x1', publishedBeatId: 'b1', beatNumber: 1, stateRevision: 1, recordedAt: '2026-10-28T20:05:00.000Z', publicText: 'Fix' }],
    }));
    expect(wrapper.find('button, input, select, textarea, a, img, video, audio').exists()).toBe(false);
    for (const name of ['stage', 'segment', 'cast', 'cast-person', 'track']) expect(wrapper.find(`.${name}`).exists()).toBe(false);
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });

  it('never shows director-only fields from a director-shaped snapshot', () => {
    const wrapper = mountScene(snapshot({
      role: 'director', directorNotes: 'SECRET NOTES', submissions: [{ id: 'sub1', text: 'SECRET SUBMISSION' }],
      npcDetails: [{ id: 'mara', displayName: 'Mara', secret: 'SECRET NPC' }], characterDetails: [], jobs: [],
      activeBeat: { id: 'b2', kind: 'action', phase: 'stakes_review', revision: 1, selectedSubmissionIds: [], contracts: [{ intent: 'SECRET CONTRACT' }], stakesApproved: false },
    }));
    const text = wrapper.text();
    for (const secret of ['SECRET NOTES', 'SECRET SUBMISSION', 'SECRET NPC', 'SECRET CONTRACT']) expect(text).not.toContain(secret);
    expect(text).not.toContain('What’s at stake');
    expect(wrapper.findAll('.stage-story')).toHaveLength(1);
  });

  it('copes with a minimal snapshot that has no corrections or rolls', () => {
    const minimal = snapshot();
    delete (minimal as unknown as Record<string, unknown>).corrections;
    (minimal.history[0] as unknown as Record<string, unknown>).rolls = undefined;
    const wrapper = mountScene(minimal);
    expect(wrapper.findAll('.roll')).toHaveLength(0);
    expect(wrapper.get('.stage-story').text()).toContain('Who sent you here?');
  });

  it('keeps every font size at 24px or more and every block inside the safe area', () => {
    const source = readFileSync(resolve(process.cwd(), 'apps/web/src/StageScene.vue'), 'utf8');
    const css = source.slice(source.indexOf('<style'));
    const sizes = [...css.matchAll(/font-size:\s*([\d.]+)(px|em|rem|%)/g)];
    expect(sizes.length).toBeGreaterThan(10);
    for (const [, value, unit] of sizes) {
      expect(unit).toBe('px');
      expect(Number(value)).toBeGreaterThanOrEqual(24);
    }
    const blocks = [...css.matchAll(/\{[^}]*position:\s*absolute;[^}]*\}/g)].map(match => match[0]);
    for (const block of blocks) {
      const read = (property: string) => Number(new RegExp(`(?:^|[\\s;{])${property}:\\s*(\\d+)px`).exec(block)?.[1]);
      const [left, top, width, height] = [read('left'), read('top'), read('width'), read('height')];
      if ([left, top, width, height].some(Number.isNaN)) continue;
      expect(left).toBeGreaterThanOrEqual(96);
      expect(top).toBeGreaterThanOrEqual(60);
      expect(left + width).toBeLessThanOrEqual(1824);
      expect(top + height).toBeLessThanOrEqual(1020);
    }
    expect(blocks.filter(block => /left:\s*\d+px/.test(block) && /height:\s*\d+px/.test(block)).length).toBeGreaterThanOrEqual(5);
  });

  describe('scene picture', () => {
    const IMAGE = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
    const OTHER = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
    const withPicture = (imageId: string | null, extra: Record<string, unknown> = {}) =>
      snapshot({ picturesEnabled: true, scenePicture: imageId ? { imageId, sceneId: 'bar' } : null, ...extra });
    const titles = (wrapper: ReturnType<typeof mountScene>) => wrapper.find('.scene-reveal-titles');
    const panel = (wrapper: ReturnType<typeof mountScene>) => wrapper.find('.scene-picture');

    afterEach(() => { vi.useRealTimers(); });

    it('shows the current scene picture in the rail panel without a reveal on first mount', () => {
      const wrapper = mountScene(withPicture(IMAGE));
      const img = wrapper.get('.scene > .scene-picture img');
      expect(img.attributes('alt')).toBe('The Velvet Static');
      expect(img.attributes('src')).toBe(`/api/sessions/show/images/${IMAGE}`);
      expect(panel(wrapper).classes()).not.toContain('revealing');
      expect(titles(wrapper).exists()).toBe(false);
      expect(wrapper.get('.rail').classes()).toContain('with-picture');
      expect(wrapper.find('.about').exists()).toBe(false);
    });

    it('draws nothing when pictures are off, there is no picture, or the picture is for another scene', () => {
      for (const snap of [
        snapshot({ scenePicture: { imageId: IMAGE, sceneId: 'bar' } }),
        withPicture(null),
        withPicture(IMAGE, { scenePicture: { imageId: IMAGE, sceneId: 'cellar' } }),
      ]) {
        const wrapper = mountScene(snap);
        expect(wrapper.find('img').exists()).toBe(false);
        expect(panel(wrapper).exists()).toBe(false);
        expect(wrapper.get('.rail').classes()).not.toContain('with-picture');
        expect(wrapper.get('.about').text()).toContain('Find the missing ledger.');
      }
    });

    it('reveals a new picture full frame with both titles, shrinks it at 4 seconds and clears at 4.9 seconds', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const wrapper = mountScene(withPicture(null));
      expect(panel(wrapper).exists()).toBe(false);
      await wrapper.setProps({ snapshot: withPicture(IMAGE) });
      expect(panel(wrapper).classes()).toContain('revealing');
      expect(titles(wrapper).get('.reveal-show').text()).toBe('The Ledger Job');
      expect(titles(wrapper).get('.reveal-scene').text()).toBe('The Velvet Static');
      expect(wrapper.get('.rail').classes()).toContain('with-picture');
      vi.advanceTimersByTime(3999);
      await nextTick();
      expect(panel(wrapper).classes()).toContain('revealing');
      vi.advanceTimersByTime(1);
      await nextTick();
      expect(panel(wrapper).classes()).not.toContain('revealing');
      expect(panel(wrapper).classes()).toContain('shrinking');
      expect(titles(wrapper).exists()).toBe(false);
      vi.advanceTimersByTime(900);
      await nextTick();
      expect(panel(wrapper).classes()).toEqual(['scene-picture']);
      expect(wrapper.get('.scene-picture img').attributes('alt')).toBe('The Velvet Static');
    });

    it('never reveals a picture it has already seen, and reveals a different new one', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const wrapper = mountScene(withPicture(IMAGE));
      await wrapper.setProps({ snapshot: withPicture(null) });
      expect(panel(wrapper).exists()).toBe(false);
      await wrapper.setProps({ snapshot: withPicture(IMAGE) });
      expect(panel(wrapper).classes()).not.toContain('revealing');
      expect(titles(wrapper).exists()).toBe(false);
      await wrapper.setProps({ snapshot: withPicture(OTHER) });
      expect(panel(wrapper).classes()).toContain('revealing');
      expect(wrapper.get('.scene-picture img').attributes('src')).toBe(`/api/sessions/show/images/${OTHER}`);
    });

    it('stops the reveal when the picture goes away', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const wrapper = mountScene(withPicture(null));
      await wrapper.setProps({ snapshot: withPicture(IMAGE) });
      expect(titles(wrapper).exists()).toBe(true);
      await wrapper.setProps({ snapshot: withPicture(null) });
      expect(panel(wrapper).exists()).toBe(false);
      expect(titles(wrapper).exists()).toBe(false);
      expect(wrapper.get('.rail').classes()).not.toContain('with-picture');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('tries a failed picture again once the snapshot has hidden it and shows it again, but not while it stays up', async () => {
      const wrapper = mountScene(withPicture(IMAGE));
      await wrapper.get('.scene-picture img').trigger('error');
      expect(panel(wrapper).exists()).toBe(false);
      await wrapper.setProps({ snapshot: withPicture(IMAGE, { eventSeq: 5 }) });
      expect(panel(wrapper).exists()).toBe(false);
      await wrapper.setProps({ snapshot: withPicture(null) });
      expect(panel(wrapper).exists()).toBe(false);
      await wrapper.setProps({ snapshot: withPicture(IMAGE) });
      expect(wrapper.get('.scene-picture img').attributes('src')).toBe(`/api/sessions/show/images/${IMAGE}`);
    });

    it('hides the panel when the picture cannot load', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const wrapper = mountScene(withPicture(null));
      await wrapper.setProps({ snapshot: withPicture(IMAGE) });
      await wrapper.get('.scene-picture img').trigger('error');
      expect(panel(wrapper).exists()).toBe(false);
      expect(titles(wrapper).exists()).toBe(false);
      expect(wrapper.get('.rail').classes()).not.toContain('with-picture');
      expect(wrapper.get('.about').text()).toContain('Find the missing ledger.');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the reveal timers when the stage goes away', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const wrapper = mountScene(withPicture(null));
      await wrapper.setProps({ snapshot: withPicture(IMAGE) });
      expect(vi.getTimerCount()).toBe(2);
      wrapper.unmount();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('portraits and compact meters', () => {
    const IMAGE = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
    const P_SKOOTY = '2a2b2c2d-0000-4000-8000-000000000001';
    const P_MARA = '2a2b2c2d-0000-4000-8000-000000000002';
    const tracks = ['Alarm', 'Trust', 'Time'].map((label, index) => ({ id: `t${index}`, label, kind: 'danger', current: index + 1, max: 4, completionText: '', enabled: true }));
    const facts = ['The vault is open.', 'Mara owes a debt.', 'A guard is bribed.', 'The ledger is torn.'].map((text, index) => ({ id: `f${index}`, text }));
    const portraits = (extra: Record<string, unknown> = {}) => snapshot({
      picturesEnabled: true,
      characters: characters.map(character => (character.id === 'c1' ? { ...character, portraitId: P_SKOOTY } : character)),
      npcs: [{ id: 'mara', displayName: 'Mara Vale', portraitId: P_MARA }],
      ...extra,
    });

    it('draws three one-line meters with no kind words and keeps every fact while a picture is up', () => {
      const wrapper = mountScene(snapshot({ picturesEnabled: true, scenePicture: { imageId: IMAGE, sceneId: 'bar' }, tracks, facts }));
      expect(wrapper.get('.rail').classes()).toContain('with-picture');
      const rows = wrapper.findAll('.meter-compact');
      expect(rows).toHaveLength(3);
      expect(rows[0]!.get('.meter-label').text()).toBe('Alarm');
      expect(rows[0]!.get('.meter-count').text()).toBe('1/4');
      expect(rows[0]!.findAll('.pip.filled')).toHaveLength(1);
      expect(wrapper.find('.meter-kind').exists()).toBe(false);
      expect(wrapper.findAll('.fact')).toHaveLength(4);
      expect(wrapper.get('[data-testid="public-facts"]').text()).toContain('Known to the party');
    });

    it('keeps the compact meter text at 24px or more and in pixels', () => {
      const source = readFileSync(resolve(process.cwd(), 'apps/web/src/StageScene.vue'), 'utf8');
      const css = source.slice(source.indexOf('<style'));
      const rules = [...css.matchAll(/\n(\.meter-line[^{]*|\.meter-compact[^{]*)\{([^}]*)\}/g)];
      expect(rules.length).toBeGreaterThan(2);
      for (const [, selector, body] of rules) {
        expect(body, selector).not.toMatch(/\d(em|rem|%)\b/);
        for (const [, size] of body!.matchAll(/font-size:\s*([\d.]+)px/g)) expect(Number(size), selector).toBeGreaterThanOrEqual(24);
      }
    });

    it('draws the meters as before without a picture', () => {
      for (const wrapper of [mountScene(snapshot({ tracks, facts })), mountScene(snapshot({ picturesEnabled: true, scenePicture: null, tracks, facts }))]) {
        expect(wrapper.find('.meter-compact').exists()).toBe(false);
        expect(wrapper.findAll('.meter-kind')).toHaveLength(3);
        expect(wrapper.findAll('.meter-top')).toHaveLength(3);
      }
    });

    it('shows the speaker portrait on player and NPC lines but never on narration', () => {
      const wrapper = mountScene(portraits());
      const lines = wrapper.findAll('.line');
      expect(lines[0]!.find('.line-portrait').exists()).toBe(false);
      expect(lines[0]!.get('.line-who').classes()).not.toContain('with-portrait');
      const npc = lines[1]!.get('.line-portrait');
      expect(npc.attributes('src')).toBe(`/api/sessions/show/images/${P_MARA}`);
      expect(npc.attributes('alt')).toBe('Portrait of Mara Vale');
      expect(lines[1]!.get('.line-who').classes()).toContain('with-portrait');
      expect(lines[1]!.get('.line-who').element.firstElementChild).toBe(npc.element);
      expect(lines[2]!.get('.line-portrait').attributes('src')).toBe(`/api/sessions/show/images/${P_SKOOTY}`);
      expect(lines[2]!.get('.line-portrait').attributes('alt')).toBe('Portrait of Skooty Vale');
    });

    it('never gives a system line a portrait, even from a character who has one', () => {
      const system = beat('b1', 1);
      system.segments[0] = { ...system.segments[0]!, kind: 'system', speaker: { entityId: 'c1', displayName: 'Skooty Vale' } } as never;
      const wrapper = mountScene(portraits({ history: [system] }));
      expect(wrapper.findAll('.line')[0]!.find('.line-portrait').exists()).toBe(false);
    });

    it('puts the portrait in place of the initials on party cards and keeps initials for the rest', () => {
      const wrapper = mountScene(portraits());
      const cards = wrapper.findAll('.party-card');
      const img = cards[0]!.get('img.party-portrait');
      expect(img.attributes('src')).toBe(`/api/sessions/show/images/${P_SKOOTY}`);
      expect(img.attributes('alt')).toBe('Portrait of Skooty Vale');
      expect(cards[0]!.find('.initials').exists()).toBe(false);
      expect(cards[1]!.find('.party-portrait').exists()).toBe(false);
      expect(cards[1]!.get('.initials').text()).toBe('RO');
    });

    it('falls back to initials and no speaker portrait when a portrait fails to load', async () => {
      const wrapper = mountScene(portraits());
      await wrapper.get('img.party-portrait').trigger('error');
      expect(wrapper.find('.party-portrait').exists()).toBe(false);
      expect(wrapper.findAll('.party-card')[0]!.get('.initials').text()).toBe('SV');
      // the same picture also fed Skooty's speaker line, so that line falls back too and only Mara's stays
      expect(wrapper.findAll('.line-portrait')).toHaveLength(1);
      expect(wrapper.findAll('.line')[2]!.find('.line-portrait').exists()).toBe(false);
      await wrapper.get('.line-portrait').trigger('error');
      expect(wrapper.find('.line-portrait').exists()).toBe(false);
      expect(wrapper.findAll('.line-who.with-portrait')).toHaveLength(0);
    });

    it('brings back a failed speaker portrait after its portraitId is removed and then restored', async () => {
      const withMara = (portraitId: string | null) => portraits({ npcs: [{ id: 'mara', displayName: 'Mara Vale', ...(portraitId ? { portraitId } : {}) }] });
      const wrapper = mountScene(withMara(P_MARA));
      await wrapper.findAll('.line')[1]!.get('.line-portrait').trigger('error');
      expect(wrapper.findAll('.line')[1]!.find('.line-portrait').exists()).toBe(false);
      await wrapper.setProps({ snapshot: withMara(P_MARA) });
      expect(wrapper.findAll('.line')[1]!.find('.line-portrait').exists()).toBe(false);
      await wrapper.setProps({ snapshot: withMara(null) });
      await wrapper.setProps({ snapshot: withMara(P_MARA) });
      expect(wrapper.findAll('.line')[1]!.get('.line-portrait').attributes('src')).toBe(`/api/sessions/show/images/${P_MARA}`);
    });

    it('shows no portraits at all when pictures are off', () => {
      const wrapper = mountScene(portraits({ picturesEnabled: false }));
      expect(wrapper.find('img').exists()).toBe(false);
      expect(wrapper.find('.with-portrait').exists()).toBe(false);
      expect(wrapper.findAll('.initials')).toHaveLength(2);
    });
  });

  describe('fitting the latest beat into the story box', () => {
    let BOX = 600;
    const DICE_ROOM = 250;
    let heights: Record<string, number> = {};
    const names = ['clientHeight', 'scrollHeight', 'offsetHeight'] as const;
    const saved = new Map<string, PropertyDescriptor | undefined>();

    const fitOf = (el: HTMLElement) => Number(el.closest<HTMLElement>('.lines')?.style.getPropertyValue('--fit')) || 1;
    const lineHeight = (line: HTMLElement) => (line.classList.contains('off-page') ? 0 : (heights[line.dataset.segmentId ?? ''] ?? 0) * fitOf(line));
    const box = (lines: HTMLElement) => BOX - (lines.parentElement?.querySelector('.dice') ? DICE_ROOM : 0);
    const content = (lines: HTMLElement) => {
      const shown = Array.from(lines.querySelectorAll<HTMLElement>('.line')).filter(line => !line.classList.contains('off-page'));
      return shown.reduce((sum, line) => sum + lineHeight(line), 0) + 20 * Math.max(0, shown.length - 1) + 12;
    };

    beforeEach(() => {
      BOX = 600;
      for (const name of names) saved.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get(this: HTMLElement) { return this.classList.contains('lines') ? box(this) : 0; },
      });
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get(this: HTMLElement) { return this.classList.contains('lines') ? Math.max(box(this), content(this)) : 0; },
      });
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get(this: HTMLElement) {
          if (this.classList.contains('line')) return lineHeight(this);
          const line = this.classList.contains('line-text') ? this.closest<HTMLElement>('.line') : null;
          return line ? Math.max(0, lineHeight(line) - 40 * fitOf(line)) : 0;
        },
      });
    });

    afterEach(() => {
      for (const name of names) {
        const descriptor = saved.get(name);
        if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    const settle = async () => {
      for (let i = 0; i < 6; i++) { await flushPromises(); await nextTick(); }
    };
    const fit = (wrapper: ReturnType<typeof mountScene>) => Number((wrapper.get('.lines').element as HTMLElement).style.getPropertyValue('--fit') || 1);
    const visible = (wrapper: ReturnType<typeof mountScene>) => wrapper.findAll('.line').filter(line => !line.classes('off-page')).map(line => line.attributes('data-segment-id'));

    it('scales the text down to fit before it pages, with no page marker', async () => {
      heights = { 'b1-s1': 300, 'b1-s2': 300, 'b1-s3': 300 };
      const wrapper = mountScene(snapshot({ history: [beat('b1', 1, { rolls: [] })] }));
      await settle();
      expect(fit(wrapper)).toBeLessThan(1);
      expect(fit(wrapper)).toBeGreaterThanOrEqual(0.6);
      expect(content(wrapper.get('.lines').element as HTMLElement)).toBeLessThanOrEqual(BOX);
      expect(wrapper.find('.page-marker').exists()).toBe(false);
      expect(wrapper.findAll('.off-page')).toHaveLength(0);
      expect(wrapper.findAll('.line').map(line => line.attributes('data-segment-id'))).toEqual(['b1-s1', 'b1-s2', 'b1-s3']);
    });

    it('pages at the smallest size, keeping the first segment on page one and every line in the story', async () => {
      heights = { 'b1-s1': 400, 'b1-s2': 300, 'b1-s3': 400 };
      const wrapper = mountScene(snapshot({ history: [beat('b1', 1, { rolls: [] })] }));
      await settle();
      expect(fit(wrapper)).toBe(0.6);
      expect(wrapper.get('.page-marker').text()).toBe('Part 1 of 2');
      expect(visible(wrapper)).toEqual(['b1-s1', 'b1-s2']);
      expect(wrapper.get('.line[data-segment-id="b1-s3"]').classes()).toContain('off-page');
      const story = wrapper.get('.stage-story').text();
      expect(story).toContain('Nobody. I came alone.');
      expect(story).toContain('Skooty Vale');
    });

    it('turns the page every eight seconds and loops back to the start', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      heights = { 'b1-s1': 400, 'b1-s2': 300, 'b1-s3': 400 };
      const wrapper = mountScene(snapshot({ history: [beat('b1', 1, { rolls: [] })] }));
      await settle();
      expect(wrapper.get('.page-marker').text()).toBe('Part 1 of 2');
      vi.advanceTimersByTime(7999);
      await nextTick();
      expect(wrapper.get('.page-marker').text()).toBe('Part 1 of 2');
      vi.advanceTimersByTime(1);
      await nextTick();
      expect(wrapper.get('.page-marker').text()).toBe('Part 2 of 2');
      expect(visible(wrapper)).toEqual(['b1-s3']);
      vi.advanceTimersByTime(8000);
      await nextTick();
      expect(wrapper.get('.page-marker').text()).toBe('Part 1 of 2');
      wrapper.unmount();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('gives a segment that narration moves to a full eight seconds before its page turns', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      stubRows();
      BOX = 164;
      heights = { 'b1-s2': (NAME_ROW + 5 * ROW) / 0.6, 'b1-s2b': (NAME_ROW + 3 * ROW) / 0.6 };
      const wrapper = mountScene(snapshot({ history: [twoSpeakers()] }), { activeSegmentId: 'b1-s2' });
      await settle();
      expect(wrapper.get('.page-marker').text()).toBe('Part 1 of 5');
      vi.advanceTimersByTime(5000);
      await nextTick();
      expect(wrapper.get('.page-marker').text()).toBe('Part 1 of 5');
      await wrapper.setProps({ activeSegmentId: 'b1-s2b' });
      await nextTick();
      expect(wrapper.get('.page-marker').text()).toBe('Part 4 of 5');
      vi.advanceTimersByTime(7999);
      await nextTick();
      expect(wrapper.get('.page-marker').text()).toBe('Part 4 of 5');
      vi.advanceTimersByTime(1);
      await nextTick();
      expect(wrapper.get('.page-marker').text()).toBe('Part 5 of 5');
    });

    it('shows the page of the segment being voiced and starts a new beat on page one', async () => {
      heights = { 'b1-s1': 400, 'b1-s2': 300, 'b1-s3': 400, 'b2-s1': 400, 'b2-s2': 300, 'b2-s3': 400 };
      const wrapper = mountScene(snapshot({ history: [beat('b1', 1, { rolls: [] })] }), { activeSegmentId: 'b1-s3' });
      await settle();
      expect(wrapper.get('.page-marker').text()).toBe('Part 2 of 2');
      expect(wrapper.get('.line[data-segment-id="b1-s3"]').classes()).toContain('speaking');
      await wrapper.setProps({ activeSegmentId: null, snapshot: snapshot({ history: [beat('b1', 1, { rolls: [] }), beat('b2', 2, { rolls: [] })] }) });
      await settle();
      expect(wrapper.get('.page-marker').text()).toBe('Part 1 of 2');
      expect(visible(wrapper)).toEqual(['b2-s1', 'b2-s2']);
    });

    it('fits again when dice appear above the lines', async () => {
      heights = { 'b1-s1': 150, 'b1-s2': 150, 'b1-s3': 150 };
      const wrapper = mountScene(snapshot({ history: [beat('b1', 1, { rolls: [] })] }));
      await settle();
      expect(fit(wrapper)).toBe(1);
      await wrapper.setProps({ snapshot: snapshot({ history: [beat('b1', 1)] }) });
      await settle();
      expect(wrapper.findAll('.roll')).toHaveLength(2);
      expect(fit(wrapper)).toBeLessThan(1);
      expect(content(wrapper.get('.lines').element as HTMLElement)).toBeLessThanOrEqual(BOX - DICE_ROOM);
    });

    it('fits again when a speaker portrait appears mid-beat', async () => {
      heights = { 'b1-s1': 100, 'b1-s2': 100, 'b1-s3': 100 };
      const withMara = (portraitId?: string) => snapshot({
        picturesEnabled: true, history: [beat('b1', 1, { rolls: [] })],
        npcs: [{ id: 'mara', displayName: 'Mara Vale', ...(portraitId ? { portraitId } : {}) }],
      });
      const wrapper = mountScene(withMara());
      await settle();
      expect(fit(wrapper)).toBe(1);
      heights = { 'b1-s1': 300, 'b1-s2': 300, 'b1-s3': 300 };
      await wrapper.setProps({ snapshot: withMara('2a2b2c2d-0000-4000-8000-000000000002') });
      await settle();
      expect(wrapper.find('.line-portrait').exists()).toBe(true);
      expect(fit(wrapper)).toBeLessThan(1);
    });

    it('fits again when a party portrait appears mid-beat', async () => {
      heights = { 'b1-s1': 100, 'b1-s2': 100, 'b1-s3': 100 };
      const withParty = (portraitId?: string) => snapshot({
        picturesEnabled: true, history: [beat('b1', 1, { rolls: [] })],
        characters: characters.map(character => (character.id === 'c2' && portraitId ? { ...character, portraitId } : character)),
      });
      const wrapper = mountScene(withParty());
      await settle();
      expect(fit(wrapper)).toBe(1);
      heights = { 'b1-s1': 300, 'b1-s2': 300, 'b1-s3': 300 };
      await wrapper.setProps({ snapshot: withParty('2a2b2c2d-0000-4000-8000-000000000002') });
      await settle();
      expect(wrapper.find('img.party-portrait').exists()).toBe(true);
      expect(fit(wrapper)).toBeLessThan(1);
    });

    const ROW = 36;
    const NAME_ROW = 40 * 0.6;
    const stubRows = () => {
      const original = globalThis.getComputedStyle;
      vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
        const style = original(el, pseudo);
        return el.classList.contains('line-text') ? ({ ...style, lineHeight: `${ROW}px`, fontSize: style.fontSize } as CSSStyleDeclaration) : style;
      });
    };
    const rowsOf = (id: string) => Math.ceil(((heights[id] ?? 0) * 0.6 - NAME_ROW) / ROW - 0.01);
    const windowOf = (wrapper: ReturnType<typeof mountScene>, id: string) => {
      const line = wrapper.get(`.line[data-segment-id="${id}"]`).element as HTMLElement;
      const text = line.querySelector<HTMLElement>('.line-text')!;
      const clip = Number.parseFloat(line.style.maxHeight);
      const shift = Math.abs(Number.parseFloat(text.style.marginTop || '0'));
      expect(line.style.overflow).toBe('hidden');
      const rows = (clip - NAME_ROW) / ROW;
      const offset = shift / ROW;
      expect(Number.isInteger(Math.round(rows * 1000) / 1000)).toBe(true);
      expect(Number.isInteger(Math.round(offset * 1000) / 1000)).toBe(true);
      return { offset: Math.round(offset), rows: Math.round(rows) };
    };
    const walk = async (wrapper: ReturnType<typeof mountScene>) => {
      const count = Number(/of (\d+)/.exec(wrapper.get('.page-marker').text())?.[1]);
      const seen: { page: number; ids: string[] }[] = [];
      const covered: Record<string, number[]> = {};
      for (let page = 1; page <= count; page++) {
        expect(wrapper.get('.page-marker').text()).toBe(`Part ${page} of ${count}`);
        const ids = visible(wrapper) as string[];
        seen.push({ page, ids });
        for (const id of ids) {
          const line = wrapper.get(`.line[data-segment-id="${id}"]`).element as HTMLElement;
          if (!line.style.maxHeight) continue;
          const { offset, rows } = windowOf(wrapper, id);
          covered[id] ??= [];
          for (let row = offset; row < offset + rows; row++) covered[id]!.push(row);
        }
        vi.advanceTimersByTime(8000);
        await nextTick();
      }
      return { count, seen, covered };
    };
    const range = (n: number) => Array.from({ length: n }, (_, i) => i);

    it('pages a segment too tall for the box across consecutive pages, cut to whole rows', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      stubRows();
      heights = { 'b1-s1': 200, 'b1-s2': 2000, 'b1-s3': 200 };
      const wrapper = mountScene(snapshot({ history: [beat('b1', 1, { rolls: [] })] }));
      await settle();
      const perPage = Math.floor((BOX - 40 - NAME_ROW) / ROW);
      const tallPages = Math.ceil(rowsOf('b1-s2') / perPage);
      expect(tallPages).toBeGreaterThan(1);
      expect(wrapper.get('.page-marker').text()).toBe(`Part 1 of ${tallPages + 2}`);
      expect(visible(wrapper)).toEqual(['b1-s1']);
      const { seen, covered } = await walk(wrapper);
      const tallOn = seen.filter(entry => entry.ids.includes('b1-s2')).map(entry => entry.page);
      expect(tallOn).toEqual(range(tallPages).map(i => i + 2));
      for (const page of tallOn) expect(seen[page - 1]!.ids).toEqual(['b1-s2']);
      expect(covered['b1-s2']).toEqual(range(rowsOf('b1-s2')));
      expect(seen.at(-1)!.ids).toEqual(['b1-s3']);
      expect(wrapper.findAll('.stage-story .line[data-segment-id="b1-s2"]')).toHaveLength(1);
      expect(wrapper.get('.stage-story').text()).toContain('Who sent you here?');
    });

    it('keeps the visible text of a paged line above the page marker when the box is tiny', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const PADDING = 6;
      const original = globalThis.getComputedStyle;
      vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
        const style = original(el, pseudo);
        if (el.classList.contains('line-text')) return { ...style, lineHeight: `${ROW}px`, fontSize: style.fontSize } as CSSStyleDeclaration;
        if (el.classList.contains('lines')) return { ...style, paddingTop: `${PADDING}px`, paddingBottom: `${PADDING}px`, rowGap: '20px' } as CSSStyleDeclaration;
        return style;
      });
      for (const size of [164, 126, 110, 90, 60]) {
        BOX = size;
        heights = { 'b1-s2': (NAME_ROW + 4 * ROW) / 0.6, 'b1-s2b': (NAME_ROW + 3 * ROW) / 0.6 };
        const wrapper = mountScene(snapshot({ history: [twoSpeakers()] }));
        await settle();
        expect(wrapper.find('.page-marker').exists()).toBe(true);
        const room = size - 2 * PADDING - 40;
        const count = Number(/of (\d+)/.exec(wrapper.get('.page-marker').text())?.[1]);
        for (let page = 0; page < count; page++) {
          for (const line of wrapper.findAll('.line').filter(entry => entry.element.getAttribute('style')?.includes('max-height'))) {
            const clip = Number.parseFloat((line.element as HTMLElement).style.maxHeight);
            expect(clip + PADDING).toBeLessThanOrEqual(room + PADDING);
            expect(clip).toBeGreaterThan(0);
          }
          vi.advanceTimersByTime(8000);
          await nextTick();
        }
        wrapper.unmount();
      }
    });

    const twoSpeakers = () => {
      const tall = beat('b1', 1, { rolls: [] });
      tall.segments = [tall.segments[1]!, { ...tall.segments[1]!, id: 'b1-s2b', text: 'Then why carry his ring?' }];
      return tall;
    };

    it('steps through every row of two tall character lines in a 164 px box, starting with the first', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      stubRows();
      BOX = 164;
      heights = { 'b1-s2': (NAME_ROW + 5 * ROW) / 0.6, 'b1-s2b': (NAME_ROW + 3 * ROW) / 0.6 };
      expect([rowsOf('b1-s2'), rowsOf('b1-s2b')]).toEqual([5, 3]);
      const wrapper = mountScene(snapshot({ history: [twoSpeakers()] }));
      await settle();
      expect(fit(wrapper)).toBe(0.6);
      expect(visible(wrapper)).toEqual(['b1-s2']);
      expect(windowOf(wrapper, 'b1-s2')).toEqual({ offset: 0, rows: 2 });
      const { count, seen, covered } = await walk(wrapper);
      expect(count).toBe(5);
      expect(seen.map(entry => entry.ids)).toEqual([['b1-s2'], ['b1-s2'], ['b1-s2'], ['b1-s2b'], ['b1-s2b']]);
      expect(covered).toEqual({ 'b1-s2': range(5), 'b1-s2b': range(3) });
      expect(wrapper.get('.page-marker').text()).toBe('Part 1 of 5');
      const story = wrapper.get('.stage-story').text();
      expect(story).toContain('Who sent you here?');
      expect(story).toContain('Then why carry his ring?');
    });

    it('steps through the pages of a voiced tall line every eight seconds and holds on its last', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      stubRows();
      BOX = 164;
      heights = { 'b1-s2': (NAME_ROW + 5 * ROW) / 0.6, 'b1-s2b': (NAME_ROW + 3 * ROW) / 0.6 };
      const wrapper = mountScene(snapshot({ history: [twoSpeakers()] }), { activeSegmentId: 'b1-s2b' });
      await settle();
      expect(wrapper.get('.page-marker').text()).toBe('Part 4 of 5');
      await wrapper.setProps({ activeSegmentId: 'b1-s2' });
      await nextTick();
      const marks: string[] = [wrapper.get('.page-marker').text()];
      for (let i = 0; i < 4; i++) {
        vi.advanceTimersByTime(8000);
        await nextTick();
        marks.push(wrapper.get('.page-marker').text());
      }
      expect(marks).toEqual(['Part 1 of 5', 'Part 2 of 5', 'Part 3 of 5', 'Part 3 of 5', 'Part 3 of 5']);
      expect(windowOf(wrapper, 'b1-s2')).toEqual({ offset: 4, rows: 1 });
      await wrapper.setProps({ activeSegmentId: null, snapshot: snapshot({ history: [twoSpeakers(), { ...twoSpeakers(), id: 'b2' }] }) });
      await settle();
      expect(wrapper.get('.page-marker').text()).toBe('Part 1 of 5');
    });
  });
});
