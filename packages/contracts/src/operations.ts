import { z } from 'zod';

const id = z.string().min(1).max(128);
const count = z.number().int().nonnegative();
const timestamp = z.iso.datetime();
const counts = { attempts: count, succeeded: count, failed: count, pending: count, interrupted: count };
const attempts = z.strictObject(counts);
const consistentCounts = (value: z.infer<typeof attempts>) => value.attempts === value.succeeded + value.failed + value.pending + value.interrupted;
const readiness = z.strictObject({
  beatId: id, status: z.enum(['missing', 'preparing', 'ready', 'failed', 'expired', 'unavailable']),
  completedSegments: count, totalSegments: count,
}).refine(value => value.completedSegments <= value.totalSegments, 'Completed clips cannot exceed the total.');

export const SessionOperationsSchema = z.strictObject({
  sessionId: id, sampledAt: timestamp, lastSavedAt: timestamp.nullable(),
  limits: z.strictObject({ ai: z.literal('unlimited'), speech: z.literal('unlimited') }),
  progress: z.array(z.strictObject({
    id, beatId: id, kind: z.enum(['plan', 'render', 'draft_audio', 'published_audio']),
    status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'expired']),
    startedAt: timestamp, finishedAt: timestamp.nullable(),
    completedSegments: count.nullable(), totalSegments: z.number().int().positive().nullable(),
  }).refine(value => value.totalSegments === null ? value.completedSegments === null : value.completedSegments !== null && value.completedSegments <= value.totalSegments, 'Clip progress must use a complete, bounded pair of counts.')).max(10),
  speech: z.strictObject({ configured: z.boolean(), draft: readiness.nullable(), published: readiness.nullable() }),
  failures: z.array(z.strictObject({ id, kind: z.enum(['plan', 'render', 'speech']), occurredAt: timestamp, message: z.string().min(1).max(500) })).max(5),
  usage: z.strictObject({
    since: timestamp, partial: z.boolean(),
    ai: attempts.refine(consistentCounts, 'Attempt outcomes must add up to the recorded attempts.'),
    speech: z.strictObject({ ...counts, characters: count, cacheHits: count, sharedHits: count }).refine(consistentCounts, 'Attempt outcomes must add up to the recorded attempts.'),
    inputTokens: z.null(), outputTokens: z.null(), costUsd: z.null(),
  }),
});
export type SessionOperations = z.infer<typeof SessionOperationsSchema>;
