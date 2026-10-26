import { describe, expect, it } from 'vitest';
import { SessionStateSchema } from '@rpg/contracts';
import { createLedgerState } from './index';

const agePresentation = /^An? (?:[\w-]+ ){0,3}?(?:woman|man|girl|boy|person)\b.*?\b(?:in (?:her|his|their) (?:early |late |mid-)?(?:teens|twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)|(?:young|old|elderly|middle-aged|teenage))\b/i;

describe('The Ledger Job rehearsal seed', () => {
  it('opens every starter person appearance with apparent age and gender', () => {
    let sequence = 0;
    const seed = SessionStateSchema.parse(createLedgerState('session', () => `opaque-${++sequence}`));
    const people = seed.npcs.filter(npc => npc.displayName !== 'Biscuit');
    expect(people.map(npc => npc.displayName)).toEqual(['Mara Vale', 'Inspector Dax']);
    for (const npc of people) expect(npc.appearance).toMatch(agePresentation);
    expect(agePresentation.test('A tall stranger with a cane.')).toBe(false);
    expect(agePresentation.test('A woman with an unhurried gaze.')).toBe(false);
  });

  it('creates a valid four-person cast, distinct specialties, and two available recurring speakers', () => {
    let sequence = 0;
    const seed = SessionStateSchema.parse(createLedgerState('session', () => `opaque-${++sequence}`));
    expect(seed.characters).toHaveLength(4);
    expect(new Set(seed.characters.map(character => Object.entries(character.traits).find(([, value]) => value === 2)?.[0])).size).toBe(4);
    expect(seed.npcs.find(npc => npc.displayName === 'Mara Vale')?.voiceProfileId).toBe('voice_mara');
    expect(seed.npcs.flatMap(npc => npc.knowledge).every(knowledge => knowledge.sourceEventId.length > 0)).toBe(true);
    expect(seed.tracks.find(track => track.kind === 'countdown')?.enabled).toBe(false);
  });
  it('keeps secrets separate and creates independent session snapshots', () => {
    let sequence = 0;
    const makeId = () => `opaque-${++sequence}`;
    const first = createLedgerState('one', makeId);
    const second = createLedgerState('two', makeId);
    first.characters[0].strain = 4;
    expect(second.characters[0].strain).toBe(0);
    expect(first.npcs[0].secrets.length).toBeGreaterThan(0);
    expect(second.npcs[0].knowledge.some(knowledge => knowledge.statement.includes('archive safe'))).toBe(false);
    expect(first.npcs[0].id).not.toBe(second.npcs[0].id);
  });
});
