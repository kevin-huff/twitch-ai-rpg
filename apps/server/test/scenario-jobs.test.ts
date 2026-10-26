import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '@rpg/providers';
import { ScenarioDefinitionSchema, ScenarioDraftJobSchema } from '@rpg/contracts';
import { AppError } from '../src/repository';
import { ScenarioDraftJobs, type ScenarioDraftResult } from '../src/scenario-jobs';

const definition = ScenarioDefinitionSchema.parse({
  schemaVersion: 1, title: 'Lighthouse', locations: [{ id: 'l1', title: 'Shore' }],
  openingScene: { id: 's1', title: 'Arrival', description: '', locationId: 'l1' },
});
const result = (): ScenarioDraftResult => ({ definition, adjustments: ['Changed one thing.'], warnings: [], suggestedBoundaries: ['Keep injuries off screen.'] });

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('ScenarioDraftJobs', () => {
  let clock: number;
  let jobs: ScenarioDraftJobs;
  const make = (options: { retentionMs?: number; maxJobs?: number } = {}) => new ScenarioDraftJobs({ now: () => clock, ...options });
  const advance = async (ms: number) => { clock += ms; await vi.advanceTimersByTimeAsync(ms); };

  beforeEach(() => { vi.useFakeTimers(); clock = 1_000_000; jobs = make(); });
  afterEach(() => { jobs.close(); vi.useRealTimers(); });

  it('returns a running job that parses and hands the deadline to the run', () => {
    const run = vi.fn(() => new Promise<ScenarioDraftResult>(() => {}));
    const job = jobs.start('a:host', 'medium', 240_000, run);
    expect(ScenarioDraftJobSchema.parse(job)).toEqual(job);
    expect(job.status).toBe('running');
    if (job.status !== 'running') return;
    expect(job.size).toBe('medium');
    expect(Date.parse(job.startedAt)).toBe(1_000_000);
    expect(Date.parse(job.deadlineAt)).toBe(1_240_000);
    expect(run).toHaveBeenCalledWith(1_240_000);
    expect(jobs.get('a:host', job.jobId)).toEqual(job);
  });

  it('allows one running job per owner and two owners at once', () => {
    const pending = () => new Promise<ScenarioDraftResult>(() => {});
    jobs.start('a:host', 'small', 1000, pending);
    expect(() => jobs.start('a:host', 'small', 1000, pending)).toThrowError(new AppError(409, 'conflict', 'A scenario draft is still being written. Wait for it to finish.'));
    expect(() => jobs.start('a:host', 'small', 1000, pending)).toThrow(AppError);
    expect(jobs.start('a:grant-1', 'small', 1000, pending).status).toBe('running');
  });

  it('lets an owner start again once the earlier job has finished', async () => {
    const first = jobs.start('a:host', 'small', 1000, async () => result());
    await flush();
    expect(jobs.get('a:host', first.jobId)?.status).toBe('succeeded');
    const second = jobs.start('a:host', 'small', 1000, async () => result());
    expect(second.jobId).not.toBe(first.jobId);
  });

  it('shows a job only to its owner', async () => {
    const job = jobs.start('a:host', 'small', 1000, async () => result());
    await flush();
    expect(jobs.get('a:grant-1', job.jobId)).toBeUndefined();
    expect(jobs.get('b:host', job.jobId)).toBeUndefined();
    expect(jobs.get('a:host', 'missing')).toBeUndefined();
    expect(jobs.get('a:host', job.jobId)?.status).toBe('succeeded');
  });

  it('records a successful result that parses', async () => {
    const job = jobs.start('a:host', 'small', 1000, async () => result());
    await flush();
    const done = jobs.get('a:host', job.jobId)!;
    expect(ScenarioDraftJobSchema.parse(done)).toEqual(done);
    expect(done).toMatchObject({ status: 'succeeded', jobId: job.jobId, adjustments: ['Changed one thing.'], suggestedBoundaries: ['Keep injuries off screen.'] });
  });

  it('fails a still-running job at its deadline', async () => {
    const run = deferred<ScenarioDraftResult>();
    const job = jobs.start('a:host', 'small', 180_000, () => run.promise);
    await advance(179_999);
    expect(jobs.get('a:host', job.jobId)?.status).toBe('running');
    await advance(1);
    const failed = jobs.get('a:host', job.jobId)!;
    expect(ScenarioDraftJobSchema.parse(failed)).toEqual(failed);
    expect(failed).toMatchObject({ status: 'failed', code: 'generation_timeout', message: 'The AI took too long. Try again, or fill in the form yourself.' });
  });

  it('ignores a result that arrives after the deadline', async () => {
    const run = deferred<ScenarioDraftResult>();
    const job = jobs.start('a:host', 'small', 1000, () => run.promise);
    await advance(1000);
    run.resolve(result());
    await flush();
    expect(jobs.get('a:host', job.jobId)).toMatchObject({ status: 'failed', code: 'generation_timeout' });
  });

  it('ignores a failure that arrives after success', async () => {
    const run = deferred<ScenarioDraftResult>();
    const job = jobs.start('a:host', 'small', 1000, () => run.promise);
    run.resolve(result());
    await flush();
    await advance(5000);
    expect(jobs.get('a:host', job.jobId)?.status).toBe('succeeded');
  });

  it('maps a provider timeout to generation_timeout without provider text', async () => {
    const job = jobs.start('a:host', 'small', 1000, async () => { throw new ProviderError('timeout', 'ClewdR'); });
    await flush();
    const failed = jobs.get('a:host', job.jobId)!;
    expect(failed).toMatchObject({ status: 'failed', code: 'generation_timeout' });
    expect(JSON.stringify(failed)).not.toContain('ClewdR');
  });

  it('maps any other error to generation_failed and hides its text', async () => {
    const secret = 'upstream said: key sk-secret-123 rejected';
    const first = jobs.start('a:host', 'small', 1000, async () => { throw new Error(secret); });
    const second = jobs.start('b:host', 'small', 1000, async () => { throw new ProviderError('http_error', 'ClewdR', 500); });
    const third = jobs.start('c:host', 'small', 1000, () => { throw new Error(secret); });
    await flush();
    for (const [owner, job] of [['a:host', first], ['b:host', second], ['c:host', third]] as const) {
      const failed = jobs.get(owner, job.jobId)!;
      expect(ScenarioDraftJobSchema.parse(failed)).toEqual(failed);
      expect(failed).toMatchObject({ status: 'failed', code: 'generation_failed', message: "The AI's draft did not fit the form. Try again, or fill in the form yourself." });
      expect(JSON.stringify(failed)).not.toMatch(/sk-secret|ClewdR|HTTP/);
    }
  });

  it('keeps finished jobs for the retention period, then forgets them', async () => {
    jobs = make({ retentionMs: 900_000 });
    const job = jobs.start('a:host', 'small', 1000, async () => result());
    await flush();
    clock += 899_999;
    expect(jobs.get('a:host', job.jobId)?.status).toBe('succeeded');
    clock += 1;
    expect(jobs.get('a:host', job.jobId)).toBeUndefined();
  });

  it('counts retention from when the job finished, not when it started', async () => {
    jobs = make({ retentionMs: 1000 });
    const run = deferred<ScenarioDraftResult>();
    const job = jobs.start('a:host', 'large', 360_000, () => run.promise);
    clock += 5000;
    run.resolve(result());
    await flush();
    clock += 999;
    expect(jobs.get('a:host', job.jobId)?.status).toBe('succeeded');
  });

  it('evicts the oldest finished job when the store is full', async () => {
    jobs = make({ maxJobs: 2 });
    const first = jobs.start('a:host', 'small', 1000, async () => result());
    await flush();
    clock += 10;
    const second = jobs.start('b:host', 'small', 1000, async () => result());
    await flush();
    clock += 10;
    const third = jobs.start('c:host', 'small', 1000, async () => result());
    expect(third.status).toBe('running');
    expect(jobs.get('a:host', first.jobId)).toBeUndefined();
    expect(jobs.get('b:host', second.jobId)?.status).toBe('succeeded');
  });

  it('refuses a new job with 409 when the store is full of running jobs', () => {
    jobs = make({ maxJobs: 2 });
    const pending = () => new Promise<ScenarioDraftResult>(() => {});
    jobs.start('a:host', 'small', 1000, pending);
    jobs.start('b:host', 'small', 1000, pending);
    expect(() => jobs.start('c:host', 'small', 1000, pending)).toThrowError(new AppError(409, 'conflict', 'A scenario draft is still being written. Wait for it to finish.'));
  });

  it('holds at most 20 jobs by default', async () => {
    const pending = () => new Promise<ScenarioDraftResult>(() => {});
    for (let i = 0; i < 20; i++) jobs.start(`owner-${i}`, 'small', 1000, pending);
    expect(() => jobs.start('owner-20', 'small', 1000, pending)).toThrow(AppError);
  });

  it('clears jobs and timers on close and ignores late results', async () => {
    const run = deferred<ScenarioDraftResult>();
    const job = jobs.start('a:host', 'small', 1000, () => run.promise);
    jobs.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(jobs.get('a:host', job.jobId)).toBeUndefined();
    run.resolve(result());
    await flush();
    expect(jobs.get('a:host', job.jobId)).toBeUndefined();
  });
});
