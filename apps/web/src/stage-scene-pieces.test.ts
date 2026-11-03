// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '@rpg/contracts';
import StageFacts from './StageFacts.vue';
import StageCorrections from './StageCorrections.vue';
import factsSource from './StageFacts.vue?raw';
import correctionsSource from './StageCorrections.vue?raw';

const rule = (source: string, selector: string) => source.match(new RegExp('\\n' + selector.replace(/\./g, '\\.') + ' \\{([^}]*)\\}'))?.[1] ?? '';

function snapshot(overrides: Record<string, unknown> = {}): SessionSnapshot {
  return {
    schemaVersion: 1, role: 'stage', eventSeq: 1,
    session: {
      id: 's1', title: 'The Story Table', status: 'live', mode: 'conversation', stateRevision: 1, beatNumber: 1, actionRoundNumber: 0,
      inputEpoch: 0, scene: { id: 'sc', title: 'The Salt Bar', description: 'A bar.', locationId: 'bar' }
    },
    characters: [], npcs: [], tracks: [], facts: [], corrections: [], history: [],
    ...overrides
  } as unknown as SessionSnapshot;
}
const correction = (id: string, stateRevision: number, recordedAt: string, publicText: string) => ({ id, publishedBeatId: 'b', beatNumber: 1, stateRevision, recordedAt, publicText });

describe('StageFacts', () => {
  it('lists facts newest first under the label', () => {
    const snap = snapshot({ facts: [{ id: 'f1', text: 'First fact.' }, { id: 'f2', text: 'Second fact.' }] });
    const wrapper = mount(StageFacts, { props: { snapshot: snap, connected: true } });
    expect(wrapper.attributes('data-testid')).toBe('public-facts');
    expect(wrapper.find('p.label').text()).toBe('Known to the party');
    expect(wrapper.findAll('.fact').map(node => node.text())).toEqual(['Second fact.', 'First fact.']);
  });

  it('draws nothing without facts and ignores characterId', () => {
    expect(mount(StageFacts, { props: { snapshot: snapshot(), connected: true } }).find('.facts').exists()).toBe(false);
    const snap = snapshot({ facts: [{ id: 'f1', text: 'A fact.' }] });
    expect(mount(StageFacts, { props: { snapshot: snap, connected: true, characterId: 'nobody' } }).find('.facts').exists()).toBe(true);
  });

  it('still draws during a slate', () => {
    const snap = snapshot({ facts: [{ id: 'f1', text: 'A fact.' }] });
    snap.session.status = 'paused';
    expect(mount(StageFacts, { props: { snapshot: snap, connected: true } }).find('.facts').exists()).toBe(true);
  });

  it('sits at left 0, top 0, 464 wide and 345 tall at most', () => {
    const css = rule(factsSource, '.facts');
    expect(css).toContain('position: absolute');
    expect(css).toContain('left: 0');
    expect(css).toContain('top: 0');
    expect(css).toContain('width: 464px');
    expect(css).toContain('max-height: 345px');
  });

  it('lets the fact lines take their own height inside a root with no fixed height', () => {
    const body = rule(factsSource, '.facts-body');
    expect(body).not.toMatch(/flex(-basis)?:[^;]*\b0(px|%)?\s*(;|$)/);
    expect(body).not.toMatch(/flex:\s*\d+(\s+\d+)?\s+0(px|%)?\b/);
    expect(body).toContain('min-height: 0');
    expect(body).toContain('overflow: hidden');
  });

  it('keeps the gaps under the label and between facts', () => {
    const fact = rule(factsSource, '.fact');
    const label = rule(factsSource, '.label');
    expect(fact).toMatch(/margin(-bottom)?: (0 0 )?4px/);
    expect(label).toMatch(/margin(-bottom)?: (0 0 )?8px/);
    const css = factsSource.slice(factsSource.indexOf('<style'));
    const zeroing = [...css.matchAll(/\n([^\n{]*\bp\b[^\n{]*) \{([^}]*)\}/g)].filter(match => /margin(-bottom)?:\s*0\b/.test(match[2]) && !/:where\(/.test(match[1]));
    expect(zeroing.map(match => match[1])).toEqual([]);
  });

  it('has no controls or links', () => {
    const snap = snapshot({ facts: [{ id: 'f1', text: 'A fact.' }] });
    expect(mount(StageFacts, { props: { snapshot: snap, connected: true } }).find('button, input, select, textarea, a').exists()).toBe(false);
  });
});

describe('StageCorrections', () => {
  it('shows the highest revision, then the latest recording', () => {
    const snap = snapshot({
      corrections: [
        correction('k1', 1, '2026-10-20T10:00:00.000Z', 'Old.'),
        correction('k2', 3, '2026-10-20T09:00:00.000Z', 'Highest revision.'),
        correction('k3', 2, '2026-10-20T12:00:00.000Z', 'Later but lower.')
      ]
    });
    const wrapper = mount(StageCorrections, { props: { snapshot: snap, connected: true } });
    expect(wrapper.attributes('aria-label')).toBe('Published corrections');
    expect(wrapper.find('.correction-tag').text()).toBe('Correction');
    expect(wrapper.find('[data-testid="published-correction"]').text()).toBe('Highest revision.');
    const tie = snapshot({ corrections: [correction('a', 2, '2026-10-20T10:00:00.000Z', 'Earlier.'), correction('b', 2, '2026-10-20T11:00:00.000Z', 'Later.')] });
    expect(mount(StageCorrections, { props: { snapshot: tie, connected: true } }).find('[data-testid="published-correction"]').text()).toBe('Later.');
  });

  it('draws nothing without corrections', () => {
    expect(mount(StageCorrections, { props: { snapshot: snapshot(), connected: true } }).find('.correction').exists()).toBe(false);
  });

  it('still draws during a slate and ignores characterId', () => {
    const snap = snapshot({ corrections: [correction('k1', 1, '2026-10-20T10:00:00.000Z', 'Fixed.')] });
    snap.session.status = 'paused';
    expect(mount(StageCorrections, { props: { snapshot: snap, connected: true, characterId: 'x' } }).find('.correction').exists()).toBe(true);
  });

  it('sits at left 0, top 0, 1728 by 88', () => {
    const css = rule(correctionsSource, '.correction');
    expect(css).toContain('position: absolute');
    expect(css).toContain('left: 0');
    expect(css).toContain('top: 0');
    expect(css).toContain('width: 1728px');
    expect(css).toContain('height: 88px');
  });

  it('has no controls or links', () => {
    const snap = snapshot({ corrections: [correction('k1', 1, '2026-10-20T10:00:00.000Z', 'Fixed.')] });
    expect(mount(StageCorrections, { props: { snapshot: snap, connected: true } }).find('button, input, select, textarea, a').exists()).toBe(false);
  });
});
