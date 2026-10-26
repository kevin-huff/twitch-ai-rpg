import { describe, expect, it } from 'vitest';
import { ScenarioDefinitionSchema, ScenarioDraftSchema } from '@rpg/contracts';
import { scenarioFromDraft } from '../src/scenario-generation';

const counter = () => { let n = 0; return () => `id-${++n}`; };
const places = [
  { key: 'opening', title: 'Harbor', description: 'A foggy harbor.' },
  { key: 'second', title: 'Tower', description: 'A tall tower.' },
];
const draftOf = (overrides: Record<string, unknown> = {}) => ScenarioDraftSchema.parse({
  title: 'Fog Night', premise: 'A ship is missing.', locations: places,
  openingScene: { title: 'The dock', description: 'Bells ring.', locationKey: 'opening' },
  ...overrides,
});
const npc = (overrides: Record<string, unknown> = {}) => ({
  name: 'Mara', role: 'Dockhand', locationKey: 'opening', presence: 'present', motivation: 'Wants her brother back.', ...overrides,
});
const run = (overrides: Record<string, unknown> = {}, boundaries: string[] = []) => scenarioFromDraft(draftOf(overrides), boundaries, counter());

describe('scenarioFromDraft', () => {
  it('assigns ids in order: places, opening scene, characters, tracks, facts', () => {
    const { definition } = run({
      npcs: [npc()], tracks: [{ label: 'Search', kind: 'progress', max: 4 }], facts: [{ text: 'The ship left at dawn.' }],
    });
    expect(definition.locations.map(item => item.id)).toEqual(['id-1', 'id-2']);
    expect(definition.openingScene.id).toBe('id-3');
    expect(definition.npcs[0]!.id).toBe('id-4');
    expect(definition.tracks[0]!.id).toBe('id-5');
    expect(definition.facts[0]!.id).toBe('id-6');
    expect(definition.openingScene.locationId).toBe('id-1');
    expect(definition.rulesVersion).toBe('0.1');
    expect(definition.pacing).toEqual({ conversationWords: 90, actionWords: 120 });
    expect(definition.extensions).toEqual({});
  });

  it('drops places with blank titles and keeps the first mapping for a repeated key', () => {
    const result = run({
      locations: [
        { key: 'blank', title: '   ', description: '' },
        { key: 'a', title: 'First', description: '' },
        { key: 'a', title: 'Second', description: '' },
      ],
      openingScene: { title: 'Start', description: '', locationKey: 'a' },
      npcs: [npc({ locationKey: 'a' })],
    });
    expect(result.definition.locations.map(item => item.title)).toEqual(['First', 'Second']);
    expect(result.definition.openingScene.locationId).toBe(result.definition.locations[0]!.id);
    expect(result.definition.npcs[0]!.locationId).toBe(result.definition.locations[0]!.id);
    expect(result.adjustments.join(' ')).toMatch(/no title/);
    expect(result.adjustments.join(' ')).toMatch(/reused the key/);
  });

  it('throws when every place has a blank title', () => {
    expect(() => run({ locations: [{ key: 'a', title: ' ', description: '' }] })).toThrow();
  });

  it('sends an unknown opening scene key to the first place and fills a blank title', () => {
    const { definition, adjustments } = run({ openingScene: { title: ' ', description: 'x', locationKey: 'nowhere' } });
    expect(definition.openingScene.locationId).toBe(definition.locations[0]!.id);
    expect(definition.openingScene.title).toBe('Opening scene');
    expect(adjustments).toHaveLength(2);
  });

  it('repairs characters', () => {
    const { definition, adjustments } = run({
      npcs: [
        npc({ name: '  ' }),
        npc({ name: 'Wander', locationKey: 'unknown', presence: 'present' }),
        npc({ name: 'Remote', locationKey: 'second', presence: 'present', communicationChannel: '  ', hiddenIdentity: ' ', mood: '' }),
        npc({
          name: 'Ines', aliases: [' Ink ', ' '], personality: [' calm ', ''], limits: [' no lies '], dialogueExamples: [' Hello. '],
          secrets: [' owes money ', ' '], mood: ' wary ', hiddenIdentity: ' The Baron ', communicationChannel: ' radio ',
          knowledge: [{ statement: ' The tower is locked. ', category: 'claim' }, { statement: '  ', category: 'fact' }],
          partyStance: 'friendly', partyReason: ' She owes them. ',
        }),
        npc({ name: 'Quiet', partyStance: 'hostile', partyReason: ' ' }),
      ],
    });
    expect(definition.npcs.map(item => item.displayName)).toEqual(['Wander', 'Remote', 'Ines', 'Quiet']);
    const [wander, remote, ines, quiet] = definition.npcs;
    expect(wander!.locationId).toBe(definition.openingScene.locationId);
    expect(wander!.status).toBe('present');
    expect(remote!.status).toBe('offstage');
    expect(remote!.locationId).toBe(definition.locations[1]!.id);
    expect(remote!.communicationChannel).toBeNull();
    expect(remote!.hiddenIdentity).toBeNull();
    expect(remote!.mood).toBe('neutral');
    expect(ines).toMatchObject({
      aliases: ['Ink'], personality: ['calm'], limits: ['no lies'], dialogueExamples: ['Hello.'], secrets: ['owes money'],
      mood: 'wary', hiddenIdentity: 'The Baron', communicationChannel: 'radio', voiceProfileId: 'narrator',
      knowledge: [{ statement: 'The tower is locked.', category: 'claim' }],
      partyRelationship: { stance: 'friendly', reason: 'She owes them.' },
    });
    expect(quiet!.partyRelationship).toBeNull();
    expect(adjustments.length).toBeGreaterThanOrEqual(6);
    expect(adjustments.every(item => item.length <= 300 && !item.includes('—'))).toBe(true);
  });

  it('notes blank list entries once per list per character', () => {
    const { adjustments } = run({
      npcs: [npc({
        name: 'Ines', mood: 'calm', aliases: [' ', ''], personality: ['', ' '], limits: [' ', ' ', ''], dialogueExamples: [''], secrets: [' ', ' '],
      })],
    });
    expect(adjustments).toEqual([
      'Dropped blank entries from the other names of Ines.',
      'Dropped blank entries from the personality of Ines.',
      'Dropped blank entries from the limits of Ines.',
      'Dropped blank entries from the sample lines of Ines.',
      'Dropped blank entries from the secrets of Ines.',
    ]);
  });

  it('notes a party reason that has no stance, once', () => {
    const { adjustments, definition } = run({ npcs: [npc({ name: 'Ines', mood: 'calm', partyReason: ' She owes them. ' })] });
    expect(definition.npcs[0]!.partyRelationship).toBeNull();
    expect(adjustments).toEqual(['Ines had a reason for how they feel about the party but no stance, so the reason was dropped.']);
  });

  it('notes a ticking non-countdown track once and leaves its trigger null', () => {
    const { adjustments, definition } = run({
      tracks: [{ label: 'Climb', kind: 'progress', max: 5, ticksEachActionRound: true }, { label: 'Clock', kind: 'countdown', max: 4, ticksEachActionRound: true }],
    });
    expect(definition.tracks.map(item => item.trigger)).toEqual([null, 'action_round']);
    expect(adjustments).toEqual(['The track "Climb" was set to tick each action round, but only countdowns can, so it does not tick.']);
  });

  it('resets tracks and keeps the action-round trigger only for ticking countdowns', () => {
    const { definition } = run({
      tracks: [
        { label: ' ', kind: 'progress', max: 3 },
        { label: 'Clock', kind: 'countdown', max: 4, ticksEachActionRound: true, completionText: ' Boom. ' },
        { label: 'Still', kind: 'countdown', max: 4 },
        { label: 'Climb', kind: 'progress', max: 5, ticksEachActionRound: true, visibility: 'director' },
      ],
    });
    expect(definition.tracks.map(item => item.label)).toEqual(['Clock', 'Still', 'Climb']);
    expect(definition.tracks.map(item => item.trigger)).toEqual(['action_round', null, null]);
    expect(definition.tracks.every(item => item.current === 0 && item.enabled && item.completionEffects.length === 0)).toBe(true);
    expect(definition.tracks[0]!.completionText).toBe('Boom.');
    expect(definition.tracks[2]!.visibility).toBe('director');
  });

  it('drops blank facts, trims lists and defaults a blank title', () => {
    const { definition, adjustments } = run({
      title: '  ', facts: [{ text: ' ' }, { text: ' Real. ', visibility: 'director' }],
      playerHooks: [' hook ', ''], objectives: [' goal '], discoveries: ['', ' found '], opportunities: [' chance '],
    });
    expect(definition.title).toBe('Untitled scenario');
    expect(definition.facts).toHaveLength(1);
    expect(definition.facts[0]).toMatchObject({ text: 'Real.', visibility: 'director' });
    expect(definition.playerHooks).toEqual(['hook']);
    expect(definition.discoveries).toEqual(['found']);
    expect(adjustments.length).toBeGreaterThanOrEqual(3);
  });

  describe('boundaries', () => {
    it('keeps host boundaries verbatim and first, and lists only appended suggestions', () => {
      const result = run({ suggestedBoundaries: ['no spiders', ' Keep Gore Off Screen. ', 'No Spiders', 'new one'] }, ['No spiders', 'keep gore off screen.']);
      expect(result.definition.boundaries).toEqual(['No spiders', 'keep gore off screen.', 'new one']);
      expect(result.suggestedBoundaries).toEqual(['new one']);
    });

    it('lists nothing when every suggestion is already present', () => {
      const result = run({ suggestedBoundaries: ['A'] }, ['a']);
      expect(result.suggestedBoundaries).toEqual([]);
      expect(result.definition.boundaries).toEqual(['a']);
    });

    it('stops at 30 boundaries', () => {
      const host = Array.from({ length: 28 }, (_, index) => `host ${index}`);
      const result = run({ suggestedBoundaries: ['s1', 's2', 's3', 's4'] }, host);
      expect(result.definition.boundaries).toHaveLength(30);
      expect(result.definition.boundaries.slice(0, 28)).toEqual(host);
      expect(result.suggestedBoundaries).toEqual(['s1', 's2']);
    });
  });

  describe('warnings', () => {
    it('names a character whose hidden identity shows in public text', () => {
      const result = run({
        premise: 'The Baron hides in town.',
        npcs: [npc({ name: 'Mara', hiddenIdentity: 'the baron' }), npc({ name: 'Ines', hiddenIdentity: 'Spy', motivation: 'x' })],
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Mara');
    });

    it('checks names, tracks, public facts, hooks and objectives but not director facts or secrets', () => {
      const clean = run({
        facts: [{ text: 'Mara is the Baron.', visibility: 'director' }],
        tracks: [{ label: 'Baron hunt', kind: 'progress', max: 3, visibility: 'director' }],
        npcs: [npc({ hiddenIdentity: 'Baron', secrets: ['The Baron'] })],
      });
      expect(clean.warnings).toEqual([]);
      for (const where of [
        { facts: [{ text: 'Baron seen.' }] },
        { tracks: [{ label: 'Find the Baron', kind: 'progress', max: 3 }] },
        { tracks: [{ label: 'Clock', kind: 'countdown', max: 3, completionText: 'The BARON wins.' }] },
        { playerHooks: ['Meet the baron.'] },
        { objectives: ['Unmask the baron.'] },
        { openingScene: { title: 'Baron arrives', description: '', locationKey: 'opening' } },
      ]) {
        expect(run({ ...where, npcs: [npc({ hiddenIdentity: 'Baron' })] }).warnings).toHaveLength(1);
      }
      expect(run({ npcs: [npc({ name: 'Baron Smith', hiddenIdentity: 'Baron' })] }).warnings).toHaveLength(1);
    });

    it('warns about more than three public tracks', () => {
      const tracks = Array.from({ length: 4 }, (_, index) => ({ label: `Track ${index}`, kind: 'progress', max: 3 }));
      expect(run({ tracks }).warnings).toEqual(['The stage shows three public tracks at most.']);
      expect(run({ tracks: [...tracks.slice(0, 3), { label: 'Hidden', kind: 'progress', max: 3, visibility: 'director' }] }).warnings).toEqual([]);
    });

    it('warns about a character with only public details', () => {
      const result = run({ npcs: [npc({ name: 'Plain', motivation: '' })] });
      expect(result.warnings).toEqual(['Plain has only public details. Add the private details by hand.']);
    });

    it('does not warn when a party stance is the only private detail', () => {
      const result = run({ npcs: [npc({ name: 'Plain', motivation: '', partyStance: 'wary', partyReason: 'Seen them before.' })] });
      expect(result.warnings).toEqual([]);
    });

    it('keeps scenario-wide notes first and adds an overflow sentence when over 40', () => {
      const npcs = Array.from({ length: 20 }, (_, index) => npc({ name: `Person${index}`, mood: ' ', personality: [' '], secrets: [''] }));
      const existing = Array.from({ length: 30 }, (_, index) => `Boundary ${index}`);
      const result = scenarioFromDraft(draftOf({
        npcs, tracks: [{ label: ' ', kind: 'progress', max: 1 }], suggestedBoundaries: ['Extra one'],
      }), existing, counter());
      const total = 2 + 20 * 3;
      expect(result.adjustments).toHaveLength(40);
      expect(result.adjustments).toContain('Some suggested boundaries were left out because the list is full.');
      expect(result.adjustments).toContain('Dropped a track that had no label.');
      expect(result.adjustments[40 - 1]).toBe(`The app made ${total - 39} more changes that are not listed here.`);
    });

    it('puts the boundaries note first, ahead of every other change note', () => {
      const existing = Array.from({ length: 30 }, (_, index) => `Boundary ${index}`);
      const facts = Array.from({ length: 45 }, () => ({ text: ' ', visibility: 'public' }));
      const npcs = Array.from({ length: 20 }, (_, index) => npc({ name: `Person${index}`, personality: [' '], secrets: [''] }));
      const result = scenarioFromDraft(draftOf({ npcs, facts, suggestedBoundaries: ['Extra one'] }), existing, counter());
      expect(result.adjustments[0]).toBe('Some suggested boundaries were left out because the list is full.');
    });

    it('adds no overflow sentence at exactly 40 notes', () => {
      const existing = Array.from({ length: 30 }, (_, index) => `Boundary ${index}`);
      const npcs = Array.from({ length: 13 }, (_, index) => npc({ name: `Person${index}`, personality: [' '], secrets: [''] }));
      const result = scenarioFromDraft(draftOf({ npcs, suggestedBoundaries: ['Extra one'] }), existing, counter());
      expect(result.adjustments).toHaveLength(40);
      expect(result.adjustments.join(' ')).not.toMatch(/more changes/);
      expect(result.adjustments.at(-1)).toBe('Dropped blank entries from the secrets of Person12.');
    });

    it('adds no overflow sentence when the notes fit', () => {
      const result = run({ npcs: [npc({ name: 'Ines', mood: ' ' }), npc({ name: 'Bo', mood: ' ' })] });
      expect(result.adjustments).toHaveLength(2);
      expect(result.adjustments.join(' ')).not.toMatch(/more changes/);
    });

    it('caps adjustments and warnings at 40 entries of 300 characters, with no em dash', () => {
      const long = 'N'.repeat(75) + '—';
      const npcs = Array.from({ length: 20 }, (_, index) => npc({ name: `${long}${index}`, motivation: '', locationKey: 'x' }));
      const result = run({ npcs, tracks: Array.from({ length: 20 }, () => ({ label: ' ', kind: 'progress', max: 1 })) });
      expect(result.adjustments.length).toBeLessThanOrEqual(40);
      expect(result.warnings.length).toBeLessThanOrEqual(40);
      expect([...result.adjustments, ...result.warnings].every(item => item.length <= 300 && !item.includes('—'))).toBe(true);
      expect(result.warnings.length).toBe(20);
    });
  });

  it('accepts a draft shaped like the fake provider with no warnings', () => {
    const result = scenarioFromDraft(ScenarioDraftSchema.parse({
      title: 'Test story', premise: 'Something goes wrong at the dock.', genre: 'mystery', tone: 'tense', directorNotes: 'Notes.',
      locations: [
        { key: 'opening', title: 'Dock', description: 'Wet planks.' },
        { key: 'second', title: 'Radio room', description: 'Static.' },
        { key: 'third', title: 'Cellar', description: 'Dark.' },
      ],
      openingScene: { title: 'Arrival', description: 'You arrive.', locationKey: 'opening' },
      npcs: [
        { name: 'Guard', role: 'Watch', appearance: 'Tall.', locationKey: 'opening', presence: 'present', personality: ['stern'], mood: 'alert', motivation: 'Keep order.', goal: 'Find the thief.', secrets: ['Took a bribe.'], knowledge: [{ statement: 'The gate was open.', category: 'fact' }] },
        { name: 'Voice', role: 'Caller', locationKey: 'second', presence: 'offstage', communicationChannel: 'radio', mood: 'urgent', motivation: 'Warn the party.' },
      ],
      tracks: [{ label: 'Search', kind: 'progress', max: 4 }, { label: 'Tide', kind: 'countdown', max: 4, ticksEachActionRound: true }],
      facts: [{ text: 'Fact one.' }, { text: 'Fact two.' }, { text: 'Director fact.', visibility: 'director' }],
      playerHooks: ['A note arrives.'], objectives: ['Find the thief.'], suggestedBoundaries: ['Keep serious injuries off screen.'],
    }), ['No spiders.'], counter());
    expect(result.warnings).toEqual([]);
    expect(result.adjustments).toEqual([]);
    expect(result.suggestedBoundaries).toEqual(['Keep serious injuries off screen.']);
    expect(result.definition.boundaries).toEqual(['No spiders.', 'Keep serious injuries off screen.']);
    expect(ScenarioDefinitionSchema.safeParse(result.definition).success).toBe(true);
    expect(result.definition.tracks.map(item => item.trigger)).toEqual([null, 'action_round']);
  });
});
