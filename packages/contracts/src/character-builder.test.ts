import { describe, expect, it } from 'vitest';
import { CharacterBuilderDraftSchema, CharacterBuilderSnapshotSchema, CharacterBuilderSummarySchema, CreateCharacterBuilderSchema, SaveCharacterBuilderSchema, SubmitCharacterBuilderSchema } from './index';

const draft = () => ({ schemaVersion: 1, displayName: '', pronouns: '', appearance: '', personality: '', backstory: '', traits: { force: 2, finesse: 2, wits: 0, presence: 0 }, specialty: '', flaw: '', possessions: ['', 'Rope', ''], connection: '', secret: 'Only my own secret.', extensions: {} });

describe('player character building', () => {
  it('saves incomplete cards without requiring a name or a finished trait allocation', () => {
    const input = { commandId: 'save-1', expectedRevision: 0, draft: draft() };
    expect(SaveCharacterBuilderSchema.parse(input)).toEqual(input);
    expect(SubmitCharacterBuilderSchema.safeParse(input).success).toBe(false);
  });

  it('submits the current complete card with empty possession slots removed', () => {
    const input = { commandId: 'submit-1', expectedRevision: 4, draft: { ...draft(), displayName: '  Aster  ', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, possessions: ['', ' Rope ', '   '] } };
    const parsed = SubmitCharacterBuilderSchema.parse(input);
    expect(parsed.draft.displayName).toBe('Aster');
    expect(parsed.draft.possessions).toEqual(['Rope']);
    expect(parsed.draft.secret).toBe('Only my own secret.');
    expect(input.draft.possessions).toEqual(['', ' Rope ', '   ']);
  });

  it('keeps draft field limits, trait ranges, and strict key validation', () => {
    for (const invalid of [
      { ...draft(), approved: true }, { ...draft(), displayName: 'a'.repeat(81) },
      { ...draft(), appearance: 'a'.repeat(1001) }, { ...draft(), secret: 'a'.repeat(2001) },
      { ...draft(), traits: { force: 3, finesse: 1, wits: 0, presence: 0 } },
      { ...draft(), traits: { force: 1.5, finesse: 1, wits: 0, presence: 0 } },
      { ...draft(), traits: { ...draft().traits, bonus: 2 } },
      { ...draft(), possessions: ['', '', '', ''] },
      { ...draft(), extensions: { nested: { unsafe: true } } },
    ]) expect(CharacterBuilderDraftSchema.safeParse(invalid).success).toBe(false);
    expect(SaveCharacterBuilderSchema.safeParse({ commandId: 'save', expectedRevision: -1, draft: draft() }).success).toBe(false);
    expect(SaveCharacterBuilderSchema.safeParse({ commandId: 'save', expectedRevision: 0, draft: draft(), ownerId: 'another' }).success).toBe(false);
  });

  it('bounds draft size in UTF-8 bytes, including extension values', () => {
    const extensions = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [String(i), '界'.repeat(2000)]));
    expect(CharacterBuilderDraftSchema.safeParse({ ...draft(), extensions }).success).toBe(false);
  });

  it('accepts only explicit, bounded player instructions when creating a link', () => {
    expect(CreateCharacterBuilderSchema.parse({ commandId: 'create', label: '  Avery  ' })).toEqual({ commandId: 'create', label: 'Avery', instructions: '' });
    expect(CreateCharacterBuilderSchema.safeParse({ commandId: 'create', label: ' ', instructions: '' }).success).toBe(false);
    expect(CreateCharacterBuilderSchema.safeParse({ commandId: 'create', label: 'Avery', instructions: 'a'.repeat(4001) }).success).toBe(false);
    expect(CreateCharacterBuilderSchema.safeParse({ commandId: 'create', label: 'Avery', scenarioId: 'private' }).success).toBe(false);
  });

  it('keeps unfinished private cards out of director summaries and ownership out of player snapshots', () => {
    const dates = { expiresAt: '2026-11-22T00:00:00.000Z' };
    const summary = { id: 'builder', label: 'Avery', instructions: 'A desert explorer.', createdAt: '2026-10-23T00:00:00.000Z', ...dates, revokedAt: null, submittedAt: null, submittedTemplate: null };
    expect(CharacterBuilderSummarySchema.parse(summary)).toEqual(summary);
    expect(CharacterBuilderSummarySchema.safeParse({ ...summary, draft: draft() }).success).toBe(false);
    const snapshot = { id: 'builder', label: 'Avery', instructions: 'A desert explorer.', ...dates, revision: 0, draft: draft(), submittedTemplate: null };
    expect(CharacterBuilderSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(CharacterBuilderSnapshotSchema.safeParse({ ...snapshot, ownerId: 'host' }).success).toBe(false);
  });
});
