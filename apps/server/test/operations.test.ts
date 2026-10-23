import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { SessionOperationsSchema } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool } from '../src/database';
import { finishUsageAttempt, recordSpeechHit, startUsageAttempt } from '../src/operations';
import { FakeAiProvider } from '../src/fake-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
suite('director operations status and recorded provider usage', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let hostToken: string;
  let host: string;
  let stage: string;
  let player: string;
  let sessionId: string;
  let provider: FakeAiProvider;
  let snapshot: any;
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (id = sessionId, credential = host) => app.inject({ url: `/api/sessions/${id}/operations`, headers: { cookie: credential } });
  async function status() {
    const result = await request();
    expect(result.statusCode, result.body).toBe(200);
    return SessionOperationsSchema.parse(result.json());
  }
  async function command(type: string, fields: Record<string, unknown> = {}, credential = host) {
    const response = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/commands`, headers: { origin, cookie: credential }, payload: { commandId: randomUUID(), type, ...fields } });
    expect(response.statusCode, response.body).toBe(200);
    if (credential === host) snapshot = response.json().snapshot;
    return response;
  }
  async function collect() {
    await command('open_beat', { kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    const saved = await command('save_submission', { expectedSubmissionRevision: 0, contextBeatId: snapshot.activeBeat.id, expectedInputEpoch: snapshot.session.inputEpoch, kind: 'say', text: 'A private sentence excluded from operations.', recipientNpcIds: [snapshot.npcs[0].id] }, player);
    return { beatId: snapshot.activeBeat.id, expectedBeatRevision: snapshot.activeBeat.revision, submissionIds: saved.json().snapshot.submissions.map((submission: any) => submission.id) };
  }
  async function waitFor(check: () => Promise<boolean>) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) { if (await check()) return; await new Promise(done => setTimeout(done, 5)); }
    throw new Error('The expected asynchronous checkpoint was not reached.');
  }
  beforeEach(async () => {
    hostToken = `operations-host-${randomUUID()}`;
    pool = createPool(databaseUrl!);
    provider = new FakeAiProvider();
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, provider });
    host = cookie(await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } }));
    const created = (await app.inject({ method: 'POST', url: '/api/sessions', headers: { origin, cookie: host }, payload: { commandId: randomUUID() } })).json();
    sessionId = created.sessionId;
    for (const role of ['stage', 'player']) {
      const credential = cookie(await app.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token: created.invites.find((invite: any) => invite.role === role).token } }));
      if (role === 'stage') stage = credential; else player = credential;
    }
    snapshot = (await app.inject({ url: `/api/sessions/${sessionId}`, headers: { cookie: host } })).json();
  });
  afterEach(async () => { await app?.close(); await pool?.end(); });

  it('shows unlimited limits and honest empty usage without inventing token or cost estimates', async () => {
    const result = await status();
    expect(result).toMatchObject({ sessionId, limits: { ai: 'unlimited', speech: 'unlimited' }, progress: [], failures: [], speech: { configured: false, draft: null, published: null }, usage: { partial: false, ai: { attempts: 0, succeeded: 0, failed: 0, pending: 0, interrupted: 0 }, speech: { attempts: 0, succeeded: 0, failed: 0, pending: 0, interrupted: 0, characters: 0, cacheHits: 0, sharedHits: 0 }, inputTokens: null, outputTokens: null, costUsd: null } });
    expect(result.lastSavedAt).not.toBeNull();
  });

  it('restricts operational details to the owning host', async () => {
    expect((await request(sessionId, '')).statusCode).toBe(401);
    for (const credential of [stage, player]) expect((await request(sessionId, credential)).statusCode).toBe(403);
    expect((await request(randomUUID())).statusCode).toBe(404);
    await pool.query('UPDATE sessions SET owner_id=$2 WHERE id=$1', [sessionId, 'another-director']);
    expect((await request()).statusCode).toBe(404);
  });

  it('does not change saved session timestamps or canonical data when polling', async () => {
    const before = (await pool.query('SELECT row_to_json(s)::text AS data FROM sessions s WHERE id=$1', [sessionId])).rows[0].data;
    const first = await status(), second = await status();
    expect(second.lastSavedAt).toBe(first.lastSavedAt);
    expect(second.usage).toEqual(first.usage);
    expect((await pool.query('SELECT row_to_json(s)::text AS data FROM sessions s WHERE id=$1', [sessionId])).rows[0].data).toBe(before);
  });

  it('tracks a real deferred plan once and leaves exact receipts and polling out of provider counts', async () => {
    const fields = await collect();
    let finish!: () => void;
    const gate = new Promise<void>(done => { finish = done; }), original = provider.plan.bind(provider);
    const planning = vi.spyOn(provider, 'plan').mockImplementationOnce(async context => { await gate; return original(context); });
    const payload = { commandId: randomUUID(), type: 'plan_beat', ...fields };
    const pending = app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/commands`, headers: { origin, cookie: host }, payload }).then(response => response);
    await waitFor(async () => planning.mock.calls.length === 1);
    const running = await status();
    expect(running.usage.ai).toEqual({ attempts: 1, succeeded: 0, failed: 0, pending: 1, interrupted: 0 });
    expect(running.progress).toEqual([expect.objectContaining({ beatId: fields.beatId, kind: 'plan', status: 'running', finishedAt: null, completedSegments: null, totalSegments: null })]);
    expect(JSON.stringify(running)).not.toMatch(/private sentence|brass key|archive safe/);
    finish(); const completed = await pending; expect(completed.statusCode, completed.body).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/commands`, headers: { origin, cookie: host }, payload })).json()).toEqual(completed.json());
    const final = await status();
    expect(final.usage.ai).toEqual({ attempts: 1, succeeded: 1, failed: 0, pending: 0, interrupted: 0 });
    expect(final.progress[0]).toMatchObject({ status: 'succeeded', startedAt: running.progress[0].startedAt });
    expect(final.progress[0].finishedAt).not.toBeNull();
    expect(planning).toHaveBeenCalledOnce();
  });

  it('projects unknown overdue outcomes as interrupted and allows a later recorded completion to settle them', async () => {
    const before = await status();
    const attemptId = await startUsageAttempt(pool, { sessionId, beatId: 'a-beat', operationId: randomUUID(), kind: 'speech', characters: 3, timeoutMs: 1 });
    await pool.query('SELECT pg_sleep(0.01)');
    expect((await status()).usage.speech).toMatchObject({ attempts: 1, interrupted: 1, pending: 0, characters: 3 });
    await finishUsageAttempt(pool, { attemptId, status: 'succeeded' });
    await finishUsageAttempt(pool, { attemptId, status: 'failed' });
    await recordSpeechHit(pool, { sessionId, beatId: 'a-beat', operationId: randomUUID(), kind: 'cache' });
    await recordSpeechHit(pool, { sessionId, beatId: 'a-beat', operationId: randomUUID(), kind: 'shared' });
    const settled = await status();
    expect(settled.usage.speech).toEqual({ attempts: 1, succeeded: 1, failed: 0, pending: 0, interrupted: 0, characters: 3, cacheHits: 1, sharedHits: 1 });
    expect((await pool.query('SELECT 1 FROM usage_attempt_results WHERE attempt_id=$1', [attemptId])).rowCount).toBe(1);
    await app.close(); app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    expect((await status()).usage).toEqual(settled.usage);
    expect(settled.usage.since).toBe(before.usage.since);
  });

  it('fails open on telemetry write errors and retains a durable warning that usage is partial', async () => {
    const original = pool.query;
    const startFailure = vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('Usage writer unavailable.'));
    expect(await startUsageAttempt(pool, { sessionId, beatId: 'a-beat', operationId: randomUUID(), kind: 'plan', timeoutMs: 30_000 })).toBeNull();
    startFailure.mockRestore();
    expect((await status()).usage).toMatchObject({ partial: true, ai: { attempts: 0 } });
    const attemptId = await startUsageAttempt(pool, { sessionId, beatId: 'a-beat', operationId: randomUUID(), kind: 'render', timeoutMs: 30_000 });
    const finishFailure = vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('Usage completion unavailable.'));
    await expect(finishUsageAttempt(pool, { attemptId, status: 'succeeded' })).resolves.toBeUndefined();
    finishFailure.mockRestore();
    await finishUsageAttempt(pool, { attemptId, status: 'succeeded' });
    expect((await status()).usage).toMatchObject({ partial: true, ai: { attempts: 1, succeeded: 1 } });
    expect(pool.query).toBe(original);
    await app.close(); app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    expect((await status()).usage.partial).toBe(true);
  });

  it('uses safe failure messages and excludes superseded generation jobs from current progress', async () => {
    const fields = await collect();
    vi.spyOn(provider, 'plan').mockRejectedValueOnce(new Error('https://secret-provider/key/private sentence'));
    await command('plan_beat', fields);
    const failed = await status();
    expect(failed.usage.ai).toMatchObject({ attempts: 1, failed: 1 });
    expect(failed.failures).toEqual([expect.objectContaining({ kind: 'plan', message: 'Planning failed. Retry planning or use the manual controls.' })]);
    expect(JSON.stringify(failed)).not.toMatch(/secret-provider|private sentence/);
    await command('plan_beat', { ...fields, expectedBeatRevision: snapshot.activeBeat.revision });
    const succeeded = await status();
    expect(succeeded.usage.ai).toMatchObject({ attempts: 2, succeeded: 1, failed: 1 });
    expect(succeeded.progress).toHaveLength(1);
    expect(succeeded.progress[0].status).toBe('succeeded');
    expect(succeeded.progress[0].id).not.toBe(failed.progress[0].id);
  });

  it('rechecks the selected host credential after a session read lock wait', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [sessionId]);
      const pending = request().then(response => response);
      await waitFor(async () => Boolean((await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FOR SHARE%' AND pid<>pg_backend_pid()")).rowCount));
      await pool.query('UPDATE credentials SET revoked_at=clock_timestamp() WHERE token_hash=$1', [createHash('sha256').update(decodeURIComponent(host.slice(host.indexOf('=') + 1))).digest('hex')]);
      await client.query('COMMIT'); expect((await pending).statusCode).toBe(401);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('stops showing an overdue provider request as active while preserving its unknown outcome', async () => {
    const fields = await collect();
    let finish!: () => void;
    const gate = new Promise<void>(done => { finish = done; });
    const original = provider.plan.bind(provider);
    const planning = vi.spyOn(provider, 'plan').mockImplementationOnce(async context => { await gate; return original(context); });
    const pending = command('plan_beat', fields);
    try {
      await waitFor(async () => planning.mock.calls.length === 1);
      await pool.query("UPDATE usage_attempts SET deadline_at=clock_timestamp()-interval '1 second' WHERE session_id=$1", [sessionId]);
      const expired = await status();
      expect(expired.usage.ai).toMatchObject({ pending: 0, interrupted: 1 });
      expect(expired.progress[0]).toMatchObject({ status: 'expired' });
      expect(expired.progress[0].finishedAt).not.toBeNull();
    } finally { finish(); await pending; }
  });

  it('retains recorded provider failures when the mutable job no longer holds that failure', async () => {
    const fields = await collect();
    vi.spyOn(provider, 'plan').mockRejectedValueOnce(new Error('Private provider details.'));
    await command('plan_beat', fields);
    await pool.query("UPDATE generation_jobs SET id=$2,status='succeeded',error=NULL WHERE session_id=$1", [sessionId, randomUUID()]);
    const result = await status();
    expect(result.usage.ai.failed).toBe(1);
    expect(result.failures).toEqual([expect.objectContaining({ kind: 'plan' })]);
    expect(JSON.stringify(result)).not.toContain('Private provider details');
  });

  it('preserves a successful command and makes one provider call when its attempt cannot be recorded', async () => {
    const fields = await collect();
    const planning = vi.spyOn(provider, 'plan');
    const prototype = Object.getPrototypeOf(pool), original = prototype.query;
    const query = vi.spyOn(prototype, 'query').mockImplementation(function (this: unknown, ...args: any[]) {
      if (typeof args[0] === 'string' && args[0].startsWith('INSERT INTO usage_attempts(') && args[1]?.[1] === sessionId) return Promise.reject(new Error('Simulated accounting failure.'));
      return original.apply(this, args);
    });
    try { await command('plan_beat', fields); } finally { query.mockRestore(); }
    expect(planning).toHaveBeenCalledOnce();
    expect(snapshot.activeBeat.phase).toBe('stakes_review');
    expect(snapshot.activeBeat.lastError).toBeNull();
    expect((await status()).usage).toMatchObject({ partial: true, ai: { attempts: 0 } });
  });
});
