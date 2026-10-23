import { describe, expect, it } from 'vitest';
import { FIELD_GENERATION_FIELDS, FieldGenerationRequestSchema, CharacterBuilderFieldGenerationRequestSchema, FieldGenerationResponseSchema, FieldGenerationCharacterContextSchema, hasUsefulCharacterContext, MAX_FIELD_GENERATION_CONTEXT_BYTES, validateFieldGenerationText, allowsPremise } from './field-generation';

describe('player character drafting contracts', () => {
  it('uses bounded director instructions for ordinary character fields while preserving explicit pronouns', () => {
    expect(FieldGenerationRequestSchema.parse({ field: 'character.backstory', seed: '', instructions: '  Build a desert courier.  ' })).toEqual({ field: 'character.backstory', seed: '', instructions: 'Build a desert courier.' });
    expect(FieldGenerationRequestSchema.safeParse({ field: 'character.pronouns', seed: 'they/them', instructions: 'A courier' }).success).toBe(true);
    for (const input of [
      { field: 'character.pronouns', seed: '', instructions: 'A courier' },
      { field: 'npc.role', seed: 'A keeper', instructions: 'A courier' },
      { field: 'character.backstory', seed: 'A courier', instructions: ' ' },
      { field: 'character.backstory', seed: 'A courier', instructions: 'x'.repeat(4001) },
    ]) expect(FieldGenerationRequestSchema.safeParse(input).success).toBe(false);
  });

  it('accepts incomplete current cards and leaves useful-input validation until stored instructions are added', () => {
    const input = { expectedRevision: 0, field: 'character.backstory', seed: ' ', characterContext: { kind: 'character', displayName: '', possessions: ['', '', 'Map'], traits: { force: 2, finesse: 2 } } };
    expect(CharacterBuilderFieldGenerationRequestSchema.parse(input)).toEqual({ ...input, seed: '' });
  });

  it('rejects noncharacter fields, spoofed context, missing revisions, and client instructions or premise', () => {
    const valid = { expectedRevision: 0, field: 'character.appearance', seed: '', characterContext: { kind: 'character' } };
    for (const input of [
      { ...valid, expectedRevision: -1 }, { ...valid, expectedRevision: 0.5 }, { ...valid, expectedRevision: undefined },
      { ...valid, field: 'npc.appearance' }, { ...valid, field: 'character.traits' },
      { ...valid, instructions: 'Overridden instructions' }, { ...valid, premise: 'Other scenario' },
      { ...valid, builderId: 'another-builder' }, { ...valid, characterContext: undefined },
      { ...valid, characterContext: { kind: 'npc' } }, { ...valid, characterContext: { kind: 'character', otherCharacter: 'Secret' } },
    ]) expect(CharacterBuilderFieldGenerationRequestSchema.safeParse(input).success).toBe(false);
  });
});

describe('same-character drafting context', () => {
  it('accepts unfinished fields and trait assignments without applying saved-card requirements', () => {
    const characterContext = { kind: 'character', displayName: '', backstory: 'A courier who draws maps.', possessions: ['', 'Compass'], traits: { force: 2, finesse: 2, wits: 0, presence: 0 }, secret: 'The map is forged.' };
    expect(FieldGenerationRequestSchema.parse({ field: 'character.appearance', seed: '', characterContext })).toEqual({ field: 'character.appearance', seed: '', characterContext });
    expect(hasUsefulCharacterContext(FieldGenerationCharacterContextSchema.parse(characterContext))).toBe(true);
    const npc = { kind: 'npc', displayName: '', role: 'Keeper', locationId: '', voiceProfileId: '', secrets: [''], knowledge: [{ statement: '', category: 'belief' }], partyRelationship: { stance: 'wary', reason: '' } };
    expect(FieldGenerationRequestSchema.parse({ field: 'npc.motivation', seed: '', characterContext: npc }).characterContext).toEqual(npc);
  });

  it('allows only the target character family and rejects unrelated records at every level', () => {
    for (const characterContext of [
      { kind: 'character', displayName: 'Aster', extensions: {} },
      { kind: 'npc', displayName: 'Mara', id: 'mara' },
      { kind: 'npc', displayName: 'Mara', otherCharacters: [] },
      { kind: 'npc', knowledge: [{ statement: 'A clue', category: 'fact', sourceEventId: 'event' }] },
      { kind: 'npc', relationships: [{ stance: 'friendly', reason: 'An old debt', targetCharacterId: null, secret: 'extra' }] },
      { kind: 'character', traits: { force: 2, finesse: 1, wits: 1, presence: 0, bonus: 99 } },
    ]) expect(FieldGenerationCharacterContextSchema.safeParse(characterContext).success).toBe(false);
    for (const field of ['scenario.genre', 'live.publicReveal', 'script.npcDialogue', 'character.backstory']) {
      expect(FieldGenerationRequestSchema.safeParse({ field, seed: 'A brief', characterContext: { kind: 'npc', role: 'Keeper' } }).success).toBe(false);
    }
    expect(FieldGenerationRequestSchema.safeParse({ field: 'npc.goal', seed: 'A brief', characterContext: { kind: 'character', displayName: 'Aster' } }).success).toBe(false);
  });

  it('requires useful context for blank briefs and preserves explicit pronoun and limit decisions', () => {
    for (const characterContext of [{ kind: 'character' }, { kind: 'character', displayName: ' ', possessions: [''] }, { kind: 'character', traits: { force: 2, finesse: 1, wits: 1, presence: 0 } }]) {
      expect(FieldGenerationRequestSchema.safeParse({ field: 'character.backstory', seed: '', characterContext }).success).toBe(false);
    }
    for (const field of ['npc.limit', 'npc.limits', 'character.pronouns']) {
      const characterContext = field.startsWith('npc.') ? { kind: 'npc', role: 'Keeper', limits: ['No violence'] } : { kind: 'character', pronouns: 'they/them', backstory: 'A courier' };
      expect(FieldGenerationRequestSchema.safeParse({ field, seed: '', characterContext }).success).toBe(false);
      expect(FieldGenerationRequestSchema.safeParse({ field, seed: 'Clarify this wording', characterContext }).success).toBe(true);
    }
  });

  it('bounds field sizes and serialized UTF-8 context without truncating accumulated knowledge', () => {
    const knowledge = Array.from({ length: 101 }, (_, index) => ({ statement: `Known fact ${index}`, category: 'fact' }));
    expect(FieldGenerationCharacterContextSchema.parse({ kind: 'npc', knowledge })).toEqual({ kind: 'npc', knowledge });
    for (const characterContext of [
      { kind: 'character', backstory: 'x'.repeat(4001) },
      { kind: 'npc', knowledge: [{ statement: 'x'.repeat(6001), category: 'fact' }] },
      { kind: 'npc', knowledge: Array(20).fill({ statement: '界'.repeat(6000), category: 'fact' }) },
    ]) expect(FieldGenerationCharacterContextSchema.safeParse(characterContext).success).toBe(false);
    expect(MAX_FIELD_GENERATION_CONTEXT_BYTES).toBe(120000);
    const valid = { kind: 'npc', knowledge: Array(10).fill({ statement: '界'.repeat(3000), category: 'fact' }) };
    expect(FieldGenerationCharacterContextSchema.parse(valid)).toEqual(valid);
  });
});

describe('field drafting contracts', () => {
  it('accepts a premise alone or with extra direction while keeping descriptions independent', () => {
    expect(FieldGenerationRequestSchema.parse({ field: 'scenario.genre', seed: ' ', premise: '  A clockwork city is losing time.  ' })).toEqual({ field: 'scenario.genre', seed: '', premise: 'A clockwork city is losing time.' });
    expect(FieldGenerationRequestSchema.parse({ field: 'npc.goal', seed: '  A reluctant ally  ', premise: 'A city is losing time.' })).toEqual({ field: 'npc.goal', seed: 'A reluctant ally', premise: 'A city is losing time.' });
    expect(FieldGenerationRequestSchema.parse({ field: 'npc.goal', seed: 'A reluctant ally' })).not.toHaveProperty('premise');
  });

  it('rejects invalid premise context without bypassing description and output limits', () => {
    for (const input of [
      { field: 'scenario.genre', seed: '' }, { field: 'scenario.genre', seed: '', premise: ' ' },
      { field: 'scenario.genre', seed: 'A setting', premise: 'x'.repeat(4001) },
      { field: 'scenario.genre', seed: 'x'.repeat(12001), premise: 'A setting' },
      { field: 'scenario.genre', seed: '', premise: 'A setting', context: { secrets: 'private' } },
      { field: 'scenario.genre', seed: '', premise: { text: 'A setting' } },
    ]) expect(FieldGenerationRequestSchema.safeParse(input).success).toBe(false);
    expect(FieldGenerationRequestSchema.safeParse({ field: 'scenario.genre', seed: '', premise: 'x'.repeat(4000) }).success).toBe(true);
  });

  it('keeps explicit-only fields independent of inferred setting details', () => {
    const explicit = ['scenario.premise', 'scenario.boundaries', 'npc.limit', 'npc.limits', 'character.pronouns', 'live.publicReveal'] as const;
    for (const field of explicit) {
      expect(allowsPremise(field)).toBe(false);
      expect(FieldGenerationRequestSchema.safeParse({ field, seed: 'Explicit wording', premise: 'A setting' }).success).toBe(false);
      expect(FieldGenerationRequestSchema.safeParse({ field, seed: 'Explicit wording' }).success).toBe(true);
    }
    expect(allowsPremise('npc.appearance')).toBe(true);
  });

  it('accepts only known fields and a bounded short description, without hidden context', () => {
    expect(FieldGenerationRequestSchema.parse({ field: 'npc.displayName', seed: '  a weary sailor  ' })).toEqual({ field: 'npc.displayName', seed: 'a weary sailor' });
    for (const input of [{ field: 'voiceProfileId', seed: 'voice' }, { field: 'scenario.title', seed: ' ' }, { field: 'scenario.title', seed: 'x'.repeat(12001) }, { field: 'scenario.title', seed: 'title', context: { secret: 'private' } }]) {
      expect(FieldGenerationRequestSchema.safeParse(input).success).toBe(false);
    }
    expect(FieldGenerationRequestSchema.safeParse({ field: 'npc.displayName', seed: 'x'.repeat(12000) }).success).toBe(true);
    expect(FieldGenerationResponseSchema.safeParse({ text: 'name', effects: [] }).success).toBe(false);
  });

  it('enforces every target limit without truncating the generated result', () => {
    for (const [field, spec] of Object.entries(FIELD_GENERATION_FIELDS)) {
      if (spec.kind !== 'text') continue;
      expect(validateFieldGenerationText(field as keyof typeof FIELD_GENERATION_FIELDS, `  ${'x'.repeat(spec.maxChars)}  `)).toBe('x'.repeat(spec.maxChars));
      expect(() => validateFieldGenerationText(field as keyof typeof FIELD_GENERATION_FIELDS, 'x'.repeat(spec.maxChars + 1))).toThrow();
    }
    expect(() => validateFieldGenerationText('scenario.premise', '  ')).toThrow();
  });

  it('normalizes list lines and validates both item lengths and item counts', () => {
    expect(validateFieldGenerationText('npc.aliases', '  Grey Fox \r\n The Captain  ')).toBe('Grey Fox\nThe Captain');
    expect(validateFieldGenerationText('npc.aliases', Array(10).fill('x'.repeat(80)).join('\n'))).toHaveLength(809);
    for (const invalid of ['x'.repeat(81), Array(11).fill('name').join('\n'), 'First\n\nSecond']) expect(() => validateFieldGenerationText('npc.aliases', invalid)).toThrow();
  });
});
