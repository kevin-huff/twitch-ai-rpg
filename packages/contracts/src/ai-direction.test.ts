import { describe, expect, it } from 'vitest';
import { AiSegmentSchema, ScenarioDefinitionSchema, ScenarioDraftSchema, placePlayerLines } from './index';
import { FIELD_GENERATION_FIELDS } from './field-generation';

const definition = {
  schemaVersion: 1, title: 'The Signal', locations: [{ id: 'dock', title: 'Dock', description: 'A platform.' }],
  openingScene: { id: 'arrival', title: 'Arrival', description: 'Beacon.', locationId: 'dock' },
};
const seg = (answersSubmissionId?: string) => ({ answersSubmissionId });

describe('aiPlan on scenarios', () => {
  it('parses without aiPlan and adds no key', () => {
    expect('aiPlan' in ScenarioDefinitionSchema.parse(definition)).toBe(false);
  });
  it('allows 12,000 characters and refuses 12,001', () => {
    expect(ScenarioDefinitionSchema.safeParse({ ...definition, aiPlan: 'a'.repeat(12000) }).success).toBe(true);
    expect(ScenarioDefinitionSchema.safeParse({ ...definition, aiPlan: 'a'.repeat(12001) }).success).toBe(false);
  });
  it('defaults the draft plan to an empty string', () => {
    const draft = ScenarioDraftSchema.parse({ locations: [{ key: 'a' }], openingScene: {} });
    expect(draft.aiPlan).toBe('');
  });
  it('has a field spec right after director notes', () => {
    const keys = Object.keys(FIELD_GENERATION_FIELDS);
    expect(keys[keys.indexOf('scenario.directorNotes') + 1]).toBe('scenario.aiPlan');
    const spec = FIELD_GENERATION_FIELDS['scenario.aiPlan'] as { label: string; maxChars: number };
    expect(spec.label).toBe('For the AI');
    expect(spec.maxChars).toBe(12000);
  });
});

describe('answersSubmissionId', () => {
  const base = { text: 'Hello.', recipientCharacterIds: [], delivery: 'neutral' };
  it('is kept on both kinds and refuses a number', () => {
    expect(AiSegmentSchema.parse({ kind: 'narration', ...base, answersSubmissionId: 's1' }).answersSubmissionId).toBe('s1');
    expect(AiSegmentSchema.parse({ kind: 'npc_dialogue', speakerNpcId: 'n1', ...base, answersSubmissionId: 's2' }).answersSubmissionId).toBe('s2');
    expect(AiSegmentSchema.safeParse({ kind: 'narration', ...base, answersSubmissionId: 5 }).success).toBe(false);
  });
});

describe('placePlayerLines', () => {
  it('keeps today\'s order with no marks', () => {
    expect(placePlayerLines(['a', 'b'], [seg(), seg()])).toEqual({ first: ['a', 'b'], before: [null, null] });
  });
  it('keeps today\'s order when any mark is unknown', () => {
    expect(placePlayerLines(['a', 'b'], [seg('a'), seg('zzz')])).toEqual({ first: ['a', 'b'], before: [null, null] });
  });
  it('plays unanswered lines first', () => {
    expect(placePlayerLines(['a', 'b', 'c'], [seg('b'), seg()])).toEqual({ first: ['a', 'c'], before: ['b', null] });
  });
  it('places a line answered twice before the first answer', () => {
    expect(placePlayerLines(['a'], [seg(), seg('a'), seg('a')])).toEqual({ first: [], before: [null, 'a', null] });
  });
  it('follows the pieces when answers are in a different order', () => {
    expect(placePlayerLines(['a', 'b'], [seg('b'), seg('a')])).toEqual({ first: [], before: ['b', 'a'] });
  });
  it('handles an empty line list', () => {
    expect(placePlayerLines([], [seg(), seg()])).toEqual({ first: [], before: [null, null] });
    expect(placePlayerLines([], [seg('a')])).toEqual({ first: [], before: [null] });
  });
});
