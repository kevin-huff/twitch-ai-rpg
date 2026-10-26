import { randomUUID } from 'node:crypto';
import { ProviderError } from '@rpg/providers';
import type { ScenarioDefinition, ScenarioDraftJob, ScenarioSize } from '@rpg/contracts';
import { AppError } from './repository';

export interface ScenarioDraftResult {
  definition: ScenarioDefinition; adjustments: string[]; warnings: string[]; suggestedBoundaries: string[];
}
export type ScenarioDraftRun = (deadlineAt: number) => Promise<ScenarioDraftResult>;

const BUSY_MESSAGE = 'A scenario draft is still being written. Wait for it to finish.';
const FAILURE_MESSAGES = {
  generation_timeout: 'The AI took too long. Try again, or fill in the form yourself.',
  generation_failed: "The AI's draft did not fit the form. Try again, or fill in the form yourself.",
} as const;

interface JobEntry { ownerKey: string; job: ScenarioDraftJob; finishedAt: number | null; timer: ReturnType<typeof setTimeout> | null }

export class ScenarioDraftJobs {
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxJobs: number;
  private readonly jobs = new Map<string, JobEntry>();
  private closed = false;

  constructor({ now = Date.now, retentionMs = 900_000, maxJobs = 20 }: { now?: () => number; retentionMs?: number; maxJobs?: number } = {}) {
    this.now = now;
    this.retentionMs = retentionMs;
    this.maxJobs = maxJobs;
  }

  start(ownerKey: string, size: ScenarioSize, deadlineMs: number, run: ScenarioDraftRun): ScenarioDraftJob {
    this.dropExpired();
    for (const entry of this.jobs.values()) {
      if (entry.ownerKey === ownerKey && entry.job.status === 'running') throw new AppError(409, 'conflict', BUSY_MESSAGE);
    }
    if (this.jobs.size >= this.maxJobs) {
      let oldest: [string, JobEntry] | undefined;
      for (const item of this.jobs) {
        if (item[1].finishedAt === null) continue;
        if (!oldest || item[1].finishedAt < oldest[1].finishedAt!) oldest = item;
      }
      if (!oldest) throw new AppError(409, 'conflict', BUSY_MESSAGE);
      this.jobs.delete(oldest[0]);
    }
    const startedAt = this.now();
    const deadlineAt = startedAt + deadlineMs;
    const jobId = randomUUID();
    const job: ScenarioDraftJob = {
      status: 'running', jobId, size, startedAt: new Date(startedAt).toISOString(), deadlineAt: new Date(deadlineAt).toISOString(),
    };
    const entry: JobEntry = { ownerKey, job, finishedAt: null, timer: null };
    this.jobs.set(jobId, entry);
    entry.timer = setTimeout(() => this.fail(entry, 'generation_timeout'), deadlineMs);
    let promise: Promise<ScenarioDraftResult>;
    try { promise = Promise.resolve(run(deadlineAt)); } catch (error) { promise = Promise.reject(error); }
    promise.then(
      (result) => this.succeed(entry, result),
      (error) => this.fail(entry, error instanceof ProviderError && error.code === 'timeout' ? 'generation_timeout' : 'generation_failed'),
    );
    return { ...job };
  }

  get(ownerKey: string, jobId: string): ScenarioDraftJob | undefined {
    this.dropExpired();
    const entry = this.jobs.get(jobId);
    if (!entry || entry.ownerKey !== ownerKey) return undefined;
    return entry.job;
  }

  close(): void {
    this.closed = true;
    for (const entry of this.jobs.values()) if (entry.timer) clearTimeout(entry.timer);
    this.jobs.clear();
  }

  private settle(entry: JobEntry): boolean {
    if (this.closed || entry.finishedAt !== null) return false;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.finishedAt = this.now();
    return true;
  }

  private succeed(entry: JobEntry, result: ScenarioDraftResult): void {
    if (!this.settle(entry)) return;
    entry.job = {
      status: 'succeeded', jobId: entry.job.jobId, definition: result.definition,
      adjustments: result.adjustments, warnings: result.warnings, suggestedBoundaries: result.suggestedBoundaries,
    };
  }

  private fail(entry: JobEntry, code: keyof typeof FAILURE_MESSAGES): void {
    if (!this.settle(entry)) return;
    entry.job = { status: 'failed', jobId: entry.job.jobId, code, message: FAILURE_MESSAGES[code] };
  }

  private dropExpired(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [id, entry] of this.jobs) if (entry.finishedAt !== null && entry.finishedAt <= cutoff) this.jobs.delete(id);
  }
}
