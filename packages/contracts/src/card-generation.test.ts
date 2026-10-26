import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BuilderCardGenerationRequestSchema, CardDraftSchema, CardGenerationInputSchema, CardGenerationResponseSchema,
  HostCardGenerationRequestSchema, SeatCardGenerationRequestSchema, SeatFieldGenerationRequestSchema,
} from './index';

const draft = { strongestTrait: 'wits', weakestTrait: 'force' };
const card = { schemaVersion: 1, displayName: 'Nia', traits: { force: 0, finesse: 1, wits: 2, presence: 1 }, possessions: [], extensions: {} };
const context = { kind: 'character', displayName: 'Nia' };

describe('CardDraftSchema', () => {
  it('strips unknown keys and fills defaults', () => {
    const parsed = CardDraftSchema.parse({ ...draft, extra: 'x' });
    expect(parsed).toEqual({ displayName: '', pronouns: '', appearance: '', personality: '', backstory: '', specialty: '', flaw: '', connection: '', secret: '', possessions: [], ...draft });
  });
  it('enforces every limit and the trait names', () => {
    const limits = { displayName: 80, pronouns: 80, appearance: 1000, personality: 2000, backstory: 4000, specialty: 1000, flaw: 1000, connection: 1000, secret: 2000 };
    for (const [key, max] of Object.entries(limits)) {
      expect(CardDraftSchema.safeParse({ ...draft, [key]: 'a'.repeat(max) }).success).toBe(true);
      expect(CardDraftSchema.safeParse({ ...draft, [key]: 'a'.repeat(max + 1) }).success).toBe(false);
    }
    expect(CardDraftSchema.safeParse({ ...draft, possessions: ['a', 'b', 'c', 'd'] }).success).toBe(false);
    expect(CardDraftSchema.safeParse({ ...draft, possessions: ['a'.repeat(161)] }).success).toBe(false);
    expect(CardDraftSchema.safeParse({ ...draft, strongestTrait: 'luck' }).success).toBe(false);
    expect(CardDraftSchema.safeParse({ displayName: 'x' }).success).toBe(false);
  });
  it('converts to a JSON schema', () => {
    expect(() => z.toJSONSchema(CardDraftSchema)).not.toThrow();
  });
});

describe('card generation requests', () => {
  it('rejects unknown keys, non-character context and oversize bodies', () => {
    expect(CardGenerationInputSchema.safeParse({ prompt: 'a', keepFilled: true }).success).toBe(true);
    expect(CardGenerationInputSchema.safeParse({ prompt: 'a', keepFilled: true, extra: 1 }).success).toBe(false);
    expect(CardGenerationInputSchema.safeParse({ prompt: 'a', keepFilled: true, current: { kind: 'npc' } }).success).toBe(false);
    const big = { kind: 'character', backstory: 'a'.repeat(200_000), secret: 'b'.repeat(100_000) };
    expect(CardGenerationInputSchema.safeParse({ prompt: 'a', keepFilled: true, current: big }).success).toBe(false);
  });
  it('limits builder and seat requests and defaults keepFilled to true', () => {
    const builder = BuilderCardGenerationRequestSchema.parse({ expectedRevision: 0, prompt: 'a', current: context });
    expect(builder.keepFilled).toBe(true);
    const seat = SeatCardGenerationRequestSchema.parse({ expectedCharacterRevision: 2, prompt: 'a', current: context });
    expect(seat.keepFilled).toBe(true);
    for (const extra of [{ premise: 'p' }, { instructions: 'i' }]) {
      expect(BuilderCardGenerationRequestSchema.safeParse({ expectedRevision: 0, prompt: 'a', current: context, ...extra }).success).toBe(false);
      expect(SeatCardGenerationRequestSchema.safeParse({ expectedCharacterRevision: 0, prompt: 'a', current: context, ...extra }).success).toBe(false);
    }
    expect(BuilderCardGenerationRequestSchema.safeParse({ expectedRevision: 0, prompt: 'a' }).success).toBe(false);
    expect(SeatCardGenerationRequestSchema.safeParse({ expectedCharacterRevision: -1, prompt: 'a', current: context }).success).toBe(false);
    expect(SeatCardGenerationRequestSchema.safeParse({ expectedCharacterRevision: 0, prompt: '   ', current: context }).success).toBe(false);
  });
  it('allows host requests with a premise but no instructions', () => {
    const host = HostCardGenerationRequestSchema.parse({ prompt: 'a', premise: 'p' });
    expect(host.keepFilled).toBe(true);
    expect(HostCardGenerationRequestSchema.safeParse({ prompt: 'a', instructions: 'i' }).success).toBe(false);
  });
  it('accepts only character fields for seats and defaults usePremise to false', () => {
    const ok = SeatFieldGenerationRequestSchema.parse({ expectedCharacterRevision: 0, field: 'character.backstory', seed: 'a thief', characterContext: context });
    expect(ok.usePremise).toBe(false);
    expect(SeatFieldGenerationRequestSchema.safeParse({ expectedCharacterRevision: 0, field: 'scenario.title', seed: 'a', characterContext: context }).success).toBe(false);
    expect(SeatFieldGenerationRequestSchema.safeParse({ expectedCharacterRevision: 0, field: 'character.backstory', seed: 'a', characterContext: { kind: 'npc' } }).success).toBe(false);
  });
});

describe('CardGenerationResponseSchema', () => {
  it('requires pronounsSuggested and a valid card', () => {
    expect(CardGenerationResponseSchema.safeParse({ card, notes: [], pronounsSuggested: false }).success).toBe(true);
    expect(CardGenerationResponseSchema.safeParse({ card, notes: [] }).success).toBe(false);
    expect(CardGenerationResponseSchema.safeParse({ card: { ...card, displayName: '' }, notes: [], pronounsSuggested: false }).success).toBe(false);
    expect(CardGenerationResponseSchema.safeParse({ card, notes: Array(11).fill('n'), pronounsSuggested: false }).success).toBe(false);
  });
});
