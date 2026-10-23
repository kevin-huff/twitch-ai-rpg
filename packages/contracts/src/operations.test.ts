import { describe, expect, it } from 'vitest';
import { SessionOperationsSchema } from './index';

const counts = { attempts: 0, succeeded: 0, failed: 0, pending: 0, interrupted: 0 };
const sample = () => ({
  sessionId: 'show', sampledAt: '2026-10-22T10:00:00Z', lastSavedAt: null,
  limits: { ai: 'unlimited', speech: 'unlimited' }, progress: [],
  speech: { configured: true, draft: null, published: null }, failures: [],
  usage: { since: '2026-10-22T09:00:00Z', partial: false, ai: { ...counts }, speech: { ...counts, characters: 0, cacheHits: 0, sharedHits: 0 }, inputTokens: null, outputTokens: null, costUsd: null },
});
const progress = { id: 'work', beatId: 'beat', kind: 'draft_audio', status: 'running', startedAt: '2026-10-22T10:00:00Z', finishedAt: null, completedSegments: 1, totalSegments: 3 };

describe('director operations contract', () => {
  it('keeps unlimited application limits and unavailable provider accounting explicit', () => {
    expect(SessionOperationsSchema.parse(sample())).toEqual(sample());
    for (const limits of [{ ai: 100, speech: 'unlimited' }, { ai: 'unlimited', speech: null }]) expect(SessionOperationsSchema.safeParse({ ...sample(), limits }).success).toBe(false);
    for (const field of ['inputTokens', 'outputTokens', 'costUsd']) expect(SessionOperationsSchema.safeParse({ ...sample(), usage: { ...sample().usage, [field]: 0 } }).success).toBe(false);
  });
  it('requires real, bounded clip counts or explicitly unknown progress', () => {
    expect(SessionOperationsSchema.safeParse({ ...sample(), progress: [progress] }).success).toBe(true);
    expect(SessionOperationsSchema.safeParse({ ...sample(), progress: [{ ...progress, kind: 'plan', completedSegments: null, totalSegments: null }] }).success).toBe(true);
    for (const patch of [{ completedSegments: 4 }, { completedSegments: -1 }, { totalSegments: 0 }, { totalSegments: null }, { completedSegments: null }, { percent: 30 }, { startedAt: 'yesterday' }]) expect(SessionOperationsSchema.safeParse({ ...sample(), progress: [{ ...progress, ...patch }] }).success).toBe(false);
    expect(SessionOperationsSchema.safeParse({ ...sample(), progress: Array(11).fill(progress) }).success).toBe(false);
  });
  it('validates readiness counts and bounded safe failure shapes without private extras', () => {
    const draft = { beatId: 'beat', status: 'preparing', completedSegments: 1, totalSegments: 2 };
    const failure = { id: 'failure', kind: 'speech', occurredAt: '2026-10-22T10:00:00Z', message: 'Speech preparation failed. Try again.' };
    expect(SessionOperationsSchema.safeParse({ ...sample(), speech: { ...sample().speech, draft }, failures: [failure] }).success).toBe(true);
    for (const patch of [{ completedSegments: 3 }, { status: 'invented' }, { providerKey: 'secret' }]) expect(SessionOperationsSchema.safeParse({ ...sample(), speech: { ...sample().speech, draft: { ...draft, ...patch } } }).success).toBe(false);
    expect(SessionOperationsSchema.safeParse({ ...sample(), failures: Array(6).fill(failure) }).success).toBe(false);
    expect(SessionOperationsSchema.safeParse({ ...sample(), failures: [{ ...failure, stack: 'private' }] }).success).toBe(false);
  });
  it('rejects inconsistent attempt counts and extra operational data', () => {
    for (const patch of [{ attempts: -1 }, { pending: 0.5 }, { attempts: 2, succeeded: 3 }, { succeeded: 1 }, { providerUrl: 'private' }]) expect(SessionOperationsSchema.safeParse({ ...sample(), usage: { ...sample().usage, ai: { ...counts, ...patch } } }).success).toBe(false);
    expect(SessionOperationsSchema.safeParse({ ...sample(), prompt: 'private' }).success).toBe(false);
  });
});
