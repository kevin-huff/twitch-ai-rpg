// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { PublicActionContract, PublicBeat, PublicCharacter, PublishedBeat, ScriptSegment } from '@rpg/contracts';
import SeatStakes from './SeatStakes.vue';
import SeatStory, { changedForYou } from './SeatStory.vue';

const characters = [
  { id: 'c-rook', displayName: 'Rook' },
  { id: 'c-lark', displayName: 'Lark' },
] as PublicCharacter[];
const stake = (id: string, actor: string, over: Partial<PublicActionContract> = {}): PublicActionContract => ({
  id, version: 1, actorCharacterId: actor, helperCharacterIds: [], intent: `Goal ${id}`, approach: 'Carefully', ruling: 'check',
  trait: 'force', edge: 0, edgeReason: null, risk: 'normal',
  outcomes: { clean: 'It works.', costly: 'It works, at a cost.', setback: 'It fails.' }, ...over,
});
const beat = (over: Partial<PublicBeat> = {}): PublicBeat => ({
  id: 'b1', kind: 'action', phase: 'stakes_review', revision: 1, stakes: [stake('s1', 'c-rook'), stake('s2', 'c-lark', { helperCharacterIds: ['c-rook'], intent: 'Open the gate' })],
  locked: false, stakesApproved: true, ...over,
});
const render = (b: PublicBeat | null, characterId = 'c-rook') => mount(SeatStakes, { props: { beat: b, characterId, characters } });

describe('SeatStakes', () => {
  it('shows only the player\'s own stakes with goal and outcome rows, and the dice line', () => {
    const wrapper = render(beat());
    expect(wrapper.get('[data-testid="seat-stakes"]').text()).toContain('What is at stake for you');
    const own = wrapper.findAll('[data-testid="seat-stake"]');
    expect(own).toHaveLength(1);
    expect(own[0]!.text()).toContain('Goal s1');
    expect(own[0]!.text()).toContain('10+ Clean success');
    expect(own[0]!.text()).toContain('It fails.');
    expect(wrapper.text()).not.toContain('Goal s2');
    expect(wrapper.get('[data-testid="seat-stakes-dice"]').text()).toBe('How the dice work: two dice plus your trait. 10 or more is a clean success, 7 to 9 a success with a cost, 6 or less a setback, and double 1s a critical failure.');
  });

  it('says when the character only helps someone else', () => {
    const wrapper = render(beat({ stakes: [stake('s2', 'c-lark', { helperCharacterIds: ['c-rook'], intent: 'Open the gate' })] }));
    expect(wrapper.findAll('[data-testid="seat-stake"]')).toHaveLength(0);
    expect(wrapper.get('[data-testid="seat-stakes-helping"]').text()).toBe('You are helping Lark with this: Open the gate');
    expect(wrapper.find('[data-testid="seat-stakes-dice"]').exists()).toBe(false);
  });

  it('shows no dice line when the own stake needs no roll', () => {
    const wrapper = render(beat({ stakes: [stake('s1', 'c-rook', { ruling: 'no_check' })] }));
    expect(wrapper.find('[data-testid="seat-stake"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="seat-stakes-dice"]').exists()).toBe(false);
  });

  it('shows only between approval and publish', () => {
    for (const phase of ['stakes_review', 'locked', 'draft_review'] as const) expect(render(beat({ phase })).find('[data-testid="seat-stakes"]').exists()).toBe(true);
    expect(render(beat({ phase: 'collecting' })).find('[data-testid="seat-stakes"]').exists()).toBe(false);
    expect(render(beat({ phase: 'published' })).find('[data-testid="seat-stakes"]').exists()).toBe(false);
    expect(render(beat({ stakesApproved: false })).find('[data-testid="seat-stakes"]').exists()).toBe(false);
    expect(render(beat({ stakesApproved: undefined })).find('[data-testid="seat-stakes"]').exists()).toBe(false);
    expect(render(null).find('[data-testid="seat-stakes"]').exists()).toBe(false);
  });

  it('renders nothing for a character with no stake and no helping', () => {
    expect(render(beat(), 'c-nobody').find('[data-testid="seat-stakes"]').exists()).toBe(false);
  });

  it('never shows a roll or a result', () => {
    const wrapper = mount(SeatStakes, { props: { beat: { ...beat({ phase: 'locked' }), rolls: [{ total: 12 }] } as never, characterId: 'c-rook', characters } });
    expect(wrapper.text()).not.toMatch(/rolled|total/i);
    expect(Object.keys(SeatStakes.props ?? {})).not.toContain('rolls');
  });
});

describe('changedForYou', () => {
  const base = { name: 'Rook', lastChanceRolled: false };
  it('words each change', () => {
    expect(changedForYou({ ...base, before: { strain: 2, condition: undefined }, after: { strain: 8, condition: 'dead' } })).toBe('Rook died.');
    expect(changedForYou({ ...base, before: { strain: 6, condition: 'down' }, after: { strain: 6, condition: 'dead' } })).toBe('Rook died.');
    expect(changedForYou({ ...base, before: { strain: 5, condition: undefined }, after: { strain: 8, condition: 'down' } })).toBe('Rook went down.');
    expect(changedForYou({ ...base, before: { strain: 8, condition: 'down' }, after: { strain: 6, condition: undefined } })).toBe('Rook was saved and is back up at 6 of 8.');
    expect(changedForYou({ ...base, lastChanceRolled: true, before: { strain: 8, condition: 'down' }, after: { strain: 7, condition: undefined } })).toBe('Rook pulled through the last chance and is back up at 7 of 8.');
    expect(changedForYou({ ...base, before: { strain: 2, condition: undefined }, after: { strain: 5, condition: undefined } })).toBe("Rook's strain went from 2 to 5 of 8: Worn.");
    expect(changedForYou({ ...base, before: { strain: 5, condition: undefined }, after: { strain: 1, condition: undefined } })).toBe("Rook's strain went from 5 to 1 of 8: Fresh.");
  });
  it('returns null when nothing changed', () => {
    expect(changedForYou({ ...base, before: { strain: 3, condition: undefined }, after: { strain: 3, condition: undefined } })).toBeNull();
    expect(changedForYou({ ...base, before: { strain: 8, condition: 'dead' }, after: { strain: 8, condition: 'dead' } })).toBeNull();
  });
});

describe('SeatStory changed line', () => {
  const segment = (id: string, text: string): ScriptSegment => ({
    id, kind: 'narration', text, speaker: null, recipientCharacterIds: [], delivery: 'neutral', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false,
  });
  const published = (n: number): PublishedBeat => ({
    id: `beat-${n}`, kind: 'action', beatNumber: n, actionRoundNumber: n, stateRevision: n, publishedAt: '2026-10-28T00:00:00Z',
    segments: [segment(`g${n}`, `Part ${n}`)], rolls: [], outcomes: [], textOnly: true,
  });
  it('shows for the newest part only, above the story box so a phone shows it without scrolling inside the box', () => {
    const shown = mount(SeatStory, { props: { history: [published(1), published(2)], characters, changed: { beatId: 'beat-2', text: 'Rook went down.' } } });
    const line = shown.get('[data-testid="seat-changed"]');
    expect(shown.get('[data-testid="seat-story-scroll"]').find('[data-testid="seat-changed"]').exists()).toBe(false);
    const order = shown.findAll('[data-testid="seat-changed"], [data-testid="seat-story-scroll"]').map(item => item.attributes('data-testid'));
    expect(order).toEqual(['seat-changed', 'seat-story-scroll']);
    expect(line.text()).toContain('What changed for you');
    expect(line.text()).toContain('Rook went down.');
    expect(line.attributes('role')).toBeUndefined();
    expect(line.find('.seat-story-tag').exists()).toBe(true);
    const other = mount(SeatStory, { props: { history: [published(1), published(2)], characters, changed: { beatId: 'beat-1', text: 'Rook went down.' } } });
    expect(other.find('[data-testid="seat-changed"]').exists()).toBe(false);
    expect(mount(SeatStory, { props: { history: [published(2)], characters, changed: null } }).find('[data-testid="seat-changed"]').exists()).toBe(false);
  });
});
