import { describe, expect, it } from 'vitest';
import { SessionStateSchema } from '@rpg/contracts';
import { createLedgerState } from './index';

describe('The Ledger Job rehearsal seed', () => {
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
