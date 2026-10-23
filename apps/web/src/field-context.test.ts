import { describe, expect, it } from 'vitest';
import { CharacterCardDefinitionSchema, FieldGenerationRequestSchema, NpcDefinitionSchema, NpcSchema } from '@rpg/contracts';
import { characterFieldContext, npcFieldContext } from './field-context';

describe('authored field context projections', () => {
  it('preserves possession positions when an initially empty card has only its third row edited', () => {
    const card = CharacterCardDefinitionSchema.parse({ schemaVersion: 1, displayName: 'Aster', traits: { force: 0, finesse: 2, wits: 1, presence: 1 }, possessions: [] });
    card.possessions[2] = '  Map  ';
    const before = structuredClone(card);
    const context = characterFieldContext(card);
    expect(context).toMatchObject({ possessions: ['', '', '  Map  '] });
    expect(FieldGenerationRequestSchema.safeParse({ field: 'character.backstory', seed: '', characterContext: context }).success).toBe(true);
    expect(card).toStrictEqual(before);
    if (context.kind !== 'character') throw new Error('Wrong context kind');
    context.possessions![2] = 'Changed';
    expect(card).toStrictEqual(before);
    expect(0 in card.possessions).toBe(false);
    expect(1 in card.possessions).toBe(false);
  });

  it('copies only character fields, preserving unfinished rows and trait allocations', () => {
    const card = CharacterCardDefinitionSchema.parse({ schemaVersion: 1, displayName: 'Aster', traits: { force: 0, finesse: 2, wits: 1, presence: 1 }, secret: 'Own private secret', extensions: { unrelated: 'Do not send' } });
    card.possessions = ['', 'Map', '']; card.traits.force = 2;
    const before = structuredClone(card);
    const context = characterFieldContext({ ...card, id: 'not-authored', version: 8 } as typeof card);
    const { schemaVersion, extensions, ...authored } = before;
    expect(context).toEqual({ kind: 'character', ...authored });
    expect(card).toEqual(before);
    if (context.kind !== 'character') throw new Error('Wrong context kind');
    context.possessions![0] = 'Changed'; context.traits!.force = 0;
    expect(card).toEqual(before);
  });

  it('keeps every own NPC field without copying IDs or hidden extra properties', () => {
    const npc = NpcDefinitionSchema.parse({ id: 'mara', displayName: 'Mara', role: '', locationId: 'bar', status: 'present', voiceProfileId: 'voice_mara', aliases: ['Mask'], hiddenIdentity: 'Own identity', secrets: ['Own secret'], knowledge: [{ statement: 'Own memory', category: 'belief' }], partyRelationship: { stance: 'wary', reason: 'Own reason' } });
    npc.aliases.push(''); npc.knowledge.push({ statement: '', category: 'claim' });
    const before = structuredClone(npc);
    const context = npcFieldContext({ ...npc, version: 7, directorNotes: 'Do not send' } as typeof npc);
    const { id, ...authored } = before;
    expect(context).toEqual({ kind: 'npc', ...authored });
    if (context.kind !== 'npc') throw new Error('Wrong context kind');
    context.aliases![0] = 'Changed'; context.knowledge![0]!.statement = 'Changed'; context.partyRelationship!.reason = 'Changed';
    expect(npc).toEqual(before);
  });

  it('projects live memory and relationship text without provenance or copying a snapshot', () => {
    const npc = NpcSchema.parse({ id: 'mara', displayName: 'Mara', role: 'Keeper', locationId: 'bar', status: 'present', voiceProfileId: 'voice_mara', knowledge: [{ id: 'memory', statement: 'Own memory', category: 'fact', acquisition: 'told', sourceEventId: 'private-event', sourceEntityId: 'other-npc', learnedBeatNumber: 9 }], relationships: [{ targetCharacterId: 'pc-1', stance: 'friendly', reason: 'Own reason', sourceEventId: 'private-event' }] });
    const before = structuredClone(npc);
    const { id, version, knowledge, relationships, ...profile } = npc;
    const context = npcFieldContext(profile, npc);
    expect(context).toEqual({ kind: 'npc', ...profile, knowledge: [{ statement: 'Own memory', category: 'fact' }], relationships: [{ targetCharacterId: 'pc-1', stance: 'friendly', reason: 'Own reason' }] });
    if (context.kind !== 'npc') throw new Error('Wrong context kind');
    context.knowledge![0]!.statement = 'Changed'; context.relationships![0]!.reason = 'Changed';
    expect(npc).toEqual(before);
    expect(npcFieldContext(profile)).toEqual({ kind: 'npc', ...profile });
  });

  it('does not silently truncate oversized authored input', () => {
    const npc = NpcDefinitionSchema.parse({ id: 'mara', displayName: 'Mara', role: '', locationId: 'bar', status: 'present', voiceProfileId: 'voice_mara' });
    npc.secrets = Array.from({ length: 11 }, () => 'x'.repeat(2001));
    expect(npcFieldContext(npc)).toMatchObject({ secrets: npc.secrets });
  });
});
