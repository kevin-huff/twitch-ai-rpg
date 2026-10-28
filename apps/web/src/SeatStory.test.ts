// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { PublicCharacter, PublishedBeat, Roll, ScriptSegment } from '@rpg/contracts';
import SeatStory from './SeatStory.vue';

const segment = (id: string, kind: ScriptSegment['kind'], text: string, name?: string): ScriptSegment => ({
  id, kind, text, speaker: name ? { entityId: `c-${name}`, displayName: name } : null, recipientCharacterIds: [], delivery: 'neutral',
  sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false,
});
const roll = (id: string, actor: string, total: number, band: Roll['band']): Roll => ({
  id, contractId: 'k', contractVersion: 1, actorCharacterId: actor, faces: [3, 4], trait: 'force', traitModifier: 1, edge: 0, total, band,
});
const beat = (n: number, segments: ScriptSegment[], rolls: Roll[] = []): PublishedBeat => ({
  id: `beat-${n}`, kind: 'action', beatNumber: n, actionRoundNumber: n, stateRevision: n, publishedAt: '2026-10-28T00:00:00Z',
  segments, rolls, outcomes: [], textOnly: true,
});
const characters = [{ id: 'c-Dash', displayName: 'Dash' }] as PublicCharacter[];

const first = beat(1, [segment('a', 'narration', 'The rain starts.')]);
const second = beat(2, [
  segment('n', 'narration', 'The alley goes quiet.'),
  segment('p1', 'player_dialogue', 'Anyone there?\nHello?', 'Dash'),
  segment('p2', 'player_action', 'I climb the fire escape.', 'Dash'),
  segment('x', 'npc_dialogue', 'Who goes there?', 'Guard'),
], [roll('r1', 'c-Dash', 11, 'clean'), roll('r2', 'gone', 7, 'costly')]);

describe('SeatStory', () => {
  it('explains the empty state and offers no toggle', () => {
    const wrapper = mount(SeatStory, { props: { history: [], characters } });
    expect(wrapper.get('h2').text()).toBe('The story');
    expect(wrapper.get('[data-testid="seat-story-empty"]').text()).toBe('The story starts when the director publishes the first beat.');
    expect(wrapper.find('[data-testid="seat-story-scroll"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="whole-story-toggle"]').exists()).toBe(false);
  });

  it('shows Critical failure for a double 1 roll on the seat', () => {
    const critical = beat(3, [segment('n', 'narration', 'The fire escape gives way.')], [roll('r3', 'c-Dash', 3, 'critical')]);
    const wrapper = mount(SeatStory, { props: { history: [critical], characters } });
    expect(wrapper.get('[data-testid="seat-story-roll"]').text()).toBe('Dash rolled 3: Critical failure');
  });

  it('shows only the latest beat while closed', () => {
    const wrapper = mount(SeatStory, { props: { history: [first, second], characters } });
    expect(wrapper.findAll('[data-testid="seat-story-beat"]')).toHaveLength(1);
    expect(wrapper.text()).not.toContain('The rain starts.');
    expect(wrapper.text()).not.toContain('Beat 2');
    const toggle = wrapper.get('[data-testid="whole-story-toggle"]');
    expect(toggle.text()).toBe('Show the whole story');
    expect(toggle.attributes('aria-expanded')).toBe('false');
  });

  it('orders player lines, then rolls in words, then the rest', () => {
    const wrapper = mount(SeatStory, { props: { history: [second], characters } });
    const rows = wrapper.get('[data-testid="seat-story-beat"]').findAll('p').map(row => row.text());
    expect(rows).toEqual([
      'Dash Anyone there?\nHello?',
      'Dash Action I climb the fire escape.',
      'Dash rolled 11: Clean success',
      'Someone rolled 7: Success with a cost',
      'The alley goes quiet.',
      'Guard Who goes there?',
    ]);
    const lines = wrapper.findAll('[data-testid="seat-story-line"]');
    expect(lines.map(line => line.classes()[line.classes().length - 1])).toEqual(['player_dialogue', 'player_action', 'narration', 'npc_dialogue']);
    expect(wrapper.findAll('[data-testid="seat-story-roll"]')).toHaveLength(2);
  });

  it('tags only actions and names only spoken lines', () => {
    const wrapper = mount(SeatStory, { props: { history: [second], characters } });
    const tags = wrapper.findAll('.seat-story-tag');
    expect(tags).toHaveLength(1);
    expect(tags[0]!.text()).toBe('Action');
    const narration = wrapper.findAll('[data-testid="seat-story-line"]').find(line => line.classes().includes('narration'))!;
    expect(narration.find('.seat-story-name').exists()).toBe(false);
  });

  it('opens to the whole log oldest first with beat labels, then closes again', async () => {
    const wrapper = mount(SeatStory, { props: { history: [first, second], characters } });
    const toggle = wrapper.get('[data-testid="whole-story-toggle"]');
    await toggle.trigger('click');
    expect(toggle.text()).toBe('Hide the whole story');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    const beats = wrapper.findAll('[data-testid="seat-story-beat"]');
    expect(beats).toHaveLength(2);
    expect(beats[0]!.text()).toContain('Beat 1');
    expect(beats[0]!.text()).toContain('The rain starts.');
    expect(beats[1]!.text()).toContain('Beat 2');
    await toggle.trigger('click');
    expect(toggle.text()).toBe('Show the whole story');
    expect(wrapper.findAll('[data-testid="seat-story-beat"]')).toHaveLength(1);
  });

  it('scrolls the open log to the newest beat when it opens and when a beat arrives', async () => {
    const wrapper = mount(SeatStory, { props: { history: [first], characters }, attachTo: document.body });
    const scroll = wrapper.get('[data-testid="seat-story-scroll"]').element as HTMLElement;
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 900 });
    await wrapper.get('[data-testid="whole-story-toggle"]').trigger('click');
    await wrapper.vm.$nextTick();
    expect(scroll.scrollTop).toBe(900);
    scroll.scrollTop = 0;
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1400 });
    await wrapper.setProps({ history: [first, second] });
    await wrapper.vm.$nextTick();
    expect(scroll.scrollTop).toBe(1400);
    wrapper.unmount();
  });

  it('scrolls the closed box back to the top when a new beat arrives', async () => {
    const wrapper = mount(SeatStory, { props: { history: [first], characters }, attachTo: document.body });
    const scroll = wrapper.get('[data-testid="seat-story-scroll"]').element as HTMLElement;
    scroll.scrollTop = 656;
    await wrapper.setProps({ history: [first, second] });
    await wrapper.vm.$nextTick();
    expect(scroll.scrollTop).toBe(0);
    const beats = wrapper.findAll('[data-testid="seat-story-beat"]');
    expect(beats).toHaveLength(1);
    expect(beats[0].text()).toContain('The alley goes quiet.');
    wrapper.unmount();
  });

  it('scrolls back to the top of the latest beat when the whole story closes', async () => {
    const wrapper = mount(SeatStory, { props: { history: [first, second], characters }, attachTo: document.body });
    const scroll = wrapper.get('[data-testid="seat-story-scroll"]').element as HTMLElement;
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1400 });
    await wrapper.get('[data-testid="whole-story-toggle"]').trigger('click');
    await wrapper.vm.$nextTick();
    expect(scroll.scrollTop).toBe(1400);
    await wrapper.get('[data-testid="whole-story-toggle"]').trigger('click');
    await wrapper.vm.$nextTick();
    expect(scroll.scrollTop).toBe(0);
    wrapper.unmount();
  });

  it('updates when history grows', async () => {
    const wrapper = mount(SeatStory, { props: { history: [], characters } });
    await wrapper.setProps({ history: [first] });
    expect(wrapper.find('[data-testid="seat-story-empty"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('The rain starts.');
    await wrapper.setProps({ history: [first, second] });
    expect(wrapper.text()).toContain('The alley goes quiet.');
    expect(wrapper.text()).not.toContain('The rain starts.');
  });

  it('shows a voice copy line as its plain words, never its audio tags', () => {
    const tagged = (id: string, kind: ScriptSegment['kind'], name?: string): ScriptSegment => ({
      ...segment(id, kind, 'Keep your voice down.', name), voiceText: '[whispers] Keep your voice down.',
    });
    const whispered = beat(4, [tagged('vn', 'narration'), tagged('vx', 'npc_dialogue', 'Guard'), tagged('vp', 'player_dialogue', 'Dash')]);
    const wrapper = mount(SeatStory, { props: { history: [whispered], characters } });
    expect(wrapper.text()).toContain('Keep your voice down.');
    expect(wrapper.findAll('[data-testid="seat-story-line"]')).toHaveLength(3);
    expect(wrapper.html()).not.toContain('[whispers]');
    expect(wrapper.text()).not.toContain('[whispers]');
  });
});
