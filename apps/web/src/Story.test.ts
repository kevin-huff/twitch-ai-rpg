// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { PublishedBeat, PublicCorrection } from '@rpg/contracts';
import Story from './Story.vue';

const latest: PublishedBeat = {
  id: 'latest', kind: 'conversation', beatNumber: 5, actionRoundNumber: 0, stateRevision: 8,
  publishedAt: '2026-10-22T00:00:00Z', rolls: [], outcomes: [], textOnly: true,
  segments: [{ id: 'line', kind: 'narration', text: 'The original published words.', speaker: null,
    recipientCharacterIds: [], delivery: 'neutral', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false }],
};
const notice: PublicCorrection = { id: 'correction', publishedBeatId: 'older', beatNumber: 1,
  stateRevision: 9, recordedAt: '2026-10-22T01:00:00Z', publicText: 'The archive key was blue.' };

describe('published correction ledger', () => {
  it('keeps older corrections visible even when their publication is outside the story window', () => {
    const wrapper = mount(Story, { props: { history: [latest], characters: [], corrections: [notice] } });
    expect(wrapper.get('[aria-label="Published story"]').text()).toContain('The original published words.');
    const ledger = wrapper.get('[aria-label="Published corrections"]');
    expect(ledger.text()).toContain('Beat 1');
    expect(ledger.text()).toContain('The archive key was blue.');
    expect(ledger.get('time').attributes('datetime')).toBe(notice.recordedAt);
    expect(wrapper.text()).toContain('Original story and dice remain recorded.');
  });

  it('renders multiple notices in recorded order and escapes authored content on stage', () => {
    const second = { ...notice, id: 'second', stateRevision: 10, publicText: '<img src=x onerror=alert(1)> New clarification.' };
    const wrapper = mount(Story, { props: { history: [latest], characters: [], stage: true, corrections: [notice, second] } });
    const entries = wrapper.findAll('[data-testid="published-correction"]');
    expect(entries.map(entry => entry.text())).toEqual([expect.stringContaining(notice.publicText), expect.stringContaining(second.publicText)]);
    expect(wrapper.find('img').exists()).toBe(false);
  });

  it('accepts legacy views with no corrections', () => {
    const wrapper = mount(Story, { props: { history: [latest], characters: [] } });
    expect(wrapper.find('[aria-label="Published corrections"]').exists()).toBe(false);
    expect(wrapper.text()).toContain(latest.segments[0].text);
  });

  it('shows a player action with its name, an Action tag and the words', () => {
    const action = { ...latest, segments: [{ ...latest.segments[0], id: 'act', kind: 'player_action' as const,
      speaker: { entityId: 'dash', displayName: 'Dash' }, text: 'I climb the fire escape.' }] };
    const wrapper = mount(Story, { props: { history: [action], characters: [] } });
    const segment = wrapper.get('.segment');
    expect(segment.classes()).toContain('player_action');
    expect(segment.get('.speaker').text()).toContain('Dash');
    expect(segment.get('.speaker .segment-tag').text()).toBe('Action');
    expect(segment.get('p').text()).toBe('I climb the fire escape.');
  });

  it('names a system line The show', () => {
    const system = { ...latest, segments: [{ ...latest.segments[0], kind: 'system' as const, text: 'The show was paused.' }] };
    const wrapper = mount(Story, { props: { history: [system], characters: [] } });
    expect(wrapper.get('.speaker').text()).toBe('The show');
  });
});
