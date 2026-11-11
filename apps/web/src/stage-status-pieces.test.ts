// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '@rpg/contracts';
import StageTracks from './StageTracks.vue';
import StageBadge from './StageBadge.vue';
import tracksSource from './StageTracks.vue?raw';
import badgeSource from './StageBadge.vue?raw';

const cssRule = (source: string, selector: string) => source.match(new RegExp('\\n' + selector.replace(/\./g, '\\.') + ' \\{([^}]*)\\}'))?.[1] ?? '';

function snapshot(overrides: Record<string, unknown> = {}, status: 'lobby' | 'live' | 'paused' | 'ended' = 'live'): SessionSnapshot {
  return {
    schemaVersion: 1, role: 'stage', eventSeq: 4,
    session: {
      id: 's1', title: 'The Story Table', status, mode: 'conversation', stateRevision: 1, beatNumber: 2, actionRoundNumber: 0,
      inputEpoch: 0, scene: { id: 'sc', title: 'The Salt Bar', description: 'A quiet bar by the dock.', locationId: 'bar' }
    },
    characters: [
      { id: 'c1', displayName: 'Mara Vale', traits: { force: 0, finesse: 1, wits: 2, presence: 1 }, strain: 8, appearance: '', approved: true, ready: true },
      { id: 'c2', displayName: 'Tom Reed', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, strain: 1, appearance: '', approved: true, ready: true }
    ],
    npcs: [],
    tracks: [
      { id: 't1', label: 'Signal', kind: 'progress', current: 1, max: 4, completionText: '', enabled: true },
      { id: 't2', label: 'Tide', kind: 'countdown', current: 2, max: 6, completionText: '', enabled: true },
      { id: 't3', label: 'Third', kind: 'danger', current: 0, max: 3, completionText: '', enabled: true },
      { id: 't4', label: 'Off', kind: 'danger', current: 0, max: 3, completionText: '', enabled: false }
    ],
    facts: [{ id: 'f1', text: 'The ledger is missing.' }],
    corrections: [{ id: 'k1', publishedBeatId: 'b1', beatNumber: 1, stateRevision: 1, recordedAt: '2026-10-20T10:00:00.000Z', publicText: 'Correction: it was Tuesday.' }],
    history: [{
      id: 'b1', kind: 'action', beatNumber: 1, actionRoundNumber: 1, stateRevision: 1, publishedAt: '2026-10-20T10:00:00.000Z', textOnly: true,
      segments: [
        { id: 'g1', kind: 'narration', text: 'Rain taps the glass.', speaker: null, recipientCharacterIds: [], delivery: 'public', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false },
        { id: 'g2', kind: 'npc_dialogue', text: 'You are late <b>again</b>.', speaker: { entityId: 'n1', displayName: 'Old Brann' }, recipientCharacterIds: [], delivery: 'public', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false }
      ],
      rolls: [
        { id: 'r1', contractId: 'x', contractVersion: 1, actorCharacterId: 'c2', faces: [3, 4], trait: 'force', traitModifier: 2, edge: 0, total: 9, band: 'costly' },
        { id: 'r2', contractId: 'y', contractVersion: 1, actorCharacterId: 'c1', faces: [6, 5], trait: 'wits', traitModifier: 2, edge: 1, total: 14, band: 'clean' }
      ],
      outcomes: []
    }],
    activeBeat: {
      id: 'b2', kind: 'action', phase: 'locked', revision: 1, locked: true,
      stakes: [{
        id: 'k', version: 1, actorCharacterId: 'c1', helperCharacterIds: ['c2'], intent: 'Pick the ledger lock', approach: 'Carefully', ruling: 'check',
        trait: 'wits', edge: 1, edgeReason: 'Help', risk: 'high', outcomes: { clean: 'It opens.', costly: 'It opens, loudly.', setback: 'It jams.' }
      }]
    },
    ...overrides
  } as unknown as SessionSnapshot;
}

const noInteraction = 'button, input, select, textarea, a';

describe('StageTracks piece', () => {
  it('shows the first two enabled tracks and not a third or a disabled one', () => {
    const wrapper = mount(StageTracks, { props: { snapshot: snapshot(), connected: true } });
    expect(wrapper.find('.rail').exists()).toBe(true);
    const labels = wrapper.findAll('.rail-label').map(node => node.text());
    expect(labels).toEqual(['Signal', 'Tide']);
    expect(wrapper.text()).not.toContain('Third');
    expect(wrapper.text()).not.toContain('Off');
    expect(wrapper.findAll('.rail-count').map(node => node.text())).toEqual(['1/4', '2/6']);
    expect(wrapper.findAll('.rail-kind').map(node => node.text())).toEqual(['Progress', 'Countdown']);
    expect(wrapper.findAll('.pips')[0].findAll('i.filled')).toHaveLength(1);
  });

  it('draws nothing with no enabled tracks', () => {
    const tracks = [{ id: 't4', label: 'Off', kind: 'danger', current: 0, max: 3, completionText: '', enabled: false }];
    const wrapper = mount(StageTracks, { props: { snapshot: snapshot({ tracks }), connected: true } });
    expect(wrapper.find('.rail').exists()).toBe(false);
    expect(wrapper.html()).not.toContain('rail-item');
  });

  it('draws nothing while the show is paused', () => {
    const wrapper = mount(StageTracks, { props: { snapshot: snapshot({}, 'paused'), connected: true } });
    expect(wrapper.find('.rail').exists()).toBe(false);
  });

  it('ignores characterId', () => {
    const wrapper = mount(StageTracks, { props: { snapshot: snapshot(), connected: true, characterId: 'nobody' } });
    expect(wrapper.findAll('.rail-item')).toHaveLength(2);
  });

  it('keeps its place and size and has nothing to click', () => {
    const rail = cssRule(tracksSource, '.rail');
    for (const part of ['left: 1472px', 'top: 240px', 'width: 352px', 'height: 304px', 'position: absolute']) expect(rail).toContain(part);
    const wrapper = mount(StageTracks, { props: { snapshot: snapshot(), connected: true } });
    expect(wrapper.find(noInteraction).exists()).toBe(false);
  });
});

describe('StageBadge piece', () => {
  it('shows the AI badge text and Live', () => {
    const wrapper = mount(StageBadge, { props: { snapshot: snapshot({ activeBeat: null }), connected: true } });
    expect(wrapper.find('.ai-badge').text()).toMatch(/AI/);
    expect(wrapper.find('.state-chip').text()).toBe('Live');
    expect(wrapper.find('.chip-pulse').exists()).toBe(false);
    expect(wrapper.find('.state-chip').classes()).not.toContain('off');
  });

  it('says Paused, Starting soon and Reconnecting with the off class', () => {
    const paused = mount(StageBadge, { props: { snapshot: snapshot({}, 'paused'), connected: true } });
    expect(paused.find('.state-chip').text()).toBe('Paused');
    expect(paused.find('.state-chip').classes()).toContain('off');
    const lobby = mount(StageBadge, { props: { snapshot: snapshot({}, 'lobby'), connected: true } });
    expect(lobby.find('.state-chip').text()).toBe('Starting soon');
    expect(lobby.find('.state-chip').classes()).toContain('off');
    const away = mount(StageBadge, { props: { snapshot: snapshot(), connected: false } });
    expect(away.find('.state-chip').text()).toBe('Reconnecting');
    expect(away.find('.state-chip').classes()).toContain('off');
  });

  it('says the round stage and pulses only while waiting', () => {
    const at = (beat: Record<string, unknown>) => mount(StageBadge, { props: { snapshot: snapshot({ activeBeat: { id: 'b', ...beat } }), connected: true } }).find('.state-chip');
    const locked = at({ phase: 'locked' });
    expect(locked.text()).toBe('Writing the story');
    expect(locked.classes()).not.toContain('off');
    expect(locked.find('.chip-pulse').attributes('aria-hidden')).toBe('true');
    expect(locked.findAll('.chip-pulse i')).toHaveLength(2);
    expect(at({ phase: 'collecting' }).text()).toBe('Taking lines');
    expect(at({ phase: 'collecting', planning: true }).text()).toBe('Setting stakes');
    expect(at({ phase: 'draft_review' }).text()).toBe('Story coming up');
    const set = at({ phase: 'stakes_review', stakesApproved: true });
    expect(set.text()).toBe('Stakes are set');
    expect(set.find('.chip-pulse').exists()).toBe(false);
  });

  it('declares the pulse motion only without reduced motion, in steps', () => {
    const outside = badgeSource.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/, '');
    expect(outside).not.toMatch(/animation:/);
    expect(badgeSource).toMatch(/prefers-reduced-motion: no-preference\) \{[\s\S]*animation: chip-pulse 1s steps\(1, end\) infinite/);
    expect(cssRule(badgeSource, '.chip-pulse i')).toContain('width: 8px');
  });

  it('always draws, even when paused, and ignores characterId', () => {
    const wrapper = mount(StageBadge, { props: { snapshot: snapshot({}, 'paused'), connected: true, characterId: 'nobody' } });
    expect(wrapper.find('.top-right').exists()).toBe(true);
    expect(wrapper.find('.ai-badge').exists()).toBe(true);
  });

  it('keeps its place and size and has nothing to click', () => {
    const top = cssRule(badgeSource, '.top-right');
    for (const part of ['right: 96px', 'top: 60px', 'position: absolute']) expect(top).toContain(part);
    expect(cssRule(badgeSource, '.ai-badge')).toContain('width: 336px');
    const wrapper = mount(StageBadge, { props: { snapshot: snapshot(), connected: true } });
    expect(wrapper.find(noInteraction).exists()).toBe(false);
  });
});
