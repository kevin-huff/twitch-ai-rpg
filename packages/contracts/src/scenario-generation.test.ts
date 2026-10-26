import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ScenarioDraftJobSchema, ScenarioDraftNpcSchema, ScenarioDraftSchema, ScenarioGenerationRequestSchema,
  ScenarioDefinitionSchema,
} from './index';

const minimal = { locations: [{ key: 'a', title: 'A' }], openingScene: { title: 'Open', locationKey: 'a' } };
const definition = ScenarioDefinitionSchema.parse({
  schemaVersion: 1, title: 'T', locations: [{ id: 'l1', title: 'L' }],
  openingScene: { id: 's1', title: 'S', description: '', locationId: 'l1' },
});
const running = { status: 'running', jobId: 'j', size: 'small', startedAt: '2026-10-28T10:00:00.000Z', deadlineAt: '2026-10-28T10:03:00.000Z' };

describe('scenario generation contracts', () => {
  it('fills request defaults and rejects unknown keys', () => {
    expect(ScenarioGenerationRequestSchema.parse({ prompt: ' hi ' })).toEqual({ prompt: 'hi', size: 'medium', boundaries: [] });
    expect(ScenarioGenerationRequestSchema.safeParse({ prompt: 'x', extra: 1 }).success).toBe(false);
    expect(ScenarioGenerationRequestSchema.safeParse({ prompt: '  ' }).success).toBe(false);
    expect(ScenarioGenerationRequestSchema.safeParse({ prompt: 'x', size: 'huge' }).success).toBe(false);
  });
  it('parses a minimal draft with defaults and strips unknown keys', () => {
    const draft = ScenarioDraftSchema.parse({ ...minimal, bogus: 1 });
    expect(draft).not.toHaveProperty('bogus');
    expect(draft.npcs).toEqual([]);
    expect(draft.suggestedBoundaries).toEqual([]);
    expect(draft.title).toBe('');
    expect(draft.openingScene.description).toBe('');
    const npc = ScenarioDraftNpcSchema.parse({ name: 'N', extra: true });
    expect(npc).toMatchObject({ presence: 'offstage', hiddenIdentity: null, communicationChannel: null, partyStance: null, knowledge: [] });
    expect(npc).not.toHaveProperty('extra');
  });
  it('rejects over-limit values', () => {
    const bad = (patch: object) => ScenarioDraftSchema.safeParse({ ...minimal, ...patch }).success;
    expect(bad({})).toBe(true);
    expect(bad({ title: 'x'.repeat(161) })).toBe(false);
    expect(bad({ npcs: Array.from({ length: 21 }, () => ({})) })).toBe(false);
    expect(bad({ locations: [] })).toBe(false);
    expect(bad({ locations: Array.from({ length: 31 }, (_, i) => ({ key: `k${i}`, title: 't' })) })).toBe(false);
    expect(bad({ tracks: [{ label: 'a', kind: 'progress', max: 9 }] })).toBe(false);
    expect(bad({ suggestedBoundaries: Array.from({ length: 11 }, (_, i) => `b${i}`) })).toBe(false);
    expect(bad({ locations: [{ key: 'k'.repeat(41), title: 't' }] })).toBe(false);
  });
  it('converts to JSON Schema and supports pick and omit', () => {
    expect(() => z.toJSONSchema(ScenarioDraftSchema)).not.toThrow();
    const picked = ScenarioDraftNpcSchema.pick({ motivation: true, secrets: true });
    expect(() => z.toJSONSchema(picked)).not.toThrow();
    expect(Object.keys(picked.shape)).toEqual(['motivation', 'secrets']);
    expect(ScenarioDraftSchema.omit({ npcs: true }).shape).not.toHaveProperty('npcs');
  });
  it('validates the job union', () => {
    const ok = (v: unknown) => ScenarioDraftJobSchema.safeParse(v).success;
    expect(ok(running)).toBe(true);
    expect(ok({ status: 'succeeded', jobId: 'j', definition, adjustments: [], warnings: [], suggestedBoundaries: [] })).toBe(true);
    expect(ok({ status: 'failed', jobId: 'j', code: 'generation_timeout', message: 'm' })).toBe(true);
    expect(ok({ ...running, status: 'queued' })).toBe(false);
    expect(ok({ ...running, extra: 1 })).toBe(false);
    expect(ok({ status: 'failed', jobId: 'j', code: 'other', message: 'm' })).toBe(false);
    expect(ok({ status: 'succeeded', jobId: 'j', definition: { ...definition, locations: [] }, adjustments: [], warnings: [], suggestedBoundaries: [] })).toBe(false);
  });
});
