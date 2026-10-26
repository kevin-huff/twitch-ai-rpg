import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp, hash } from '../src/app';
import { createPool } from '../src/database';
import { FakeAiProvider } from '../src/fake-provider';
import { ProviderError } from '@rpg/providers';
import { ScenarioDefinitionSchema, type AiProvider, type ScenarioDraft } from '@rpg/contracts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const GONE = 'That scenario draft was not found. It may have expired.';

const draft = (): ScenarioDraft => ({
  title: 'The Lantern Fair', premise: 'A fair in a harbor town hides a stolen map.', genre: 'mystery', tone: 'warm', pictureStyle: 'Ink and watercolor, soft dawn light', directorNotes: 'Keep it light.',
  playerHooks: ['You came for the lantern parade.'], objectives: ['Find the missing map.'], discoveries: [], opportunities: [],
  suggestedBoundaries: ['Keep serious injuries off screen.'],
  locations: [{ key: 'opening', title: 'Fairground', description: 'Lanterns and music.' }, { key: 'second', title: 'Harbor office', description: 'Crowded and dusty.' }],
  openingScene: { title: 'Parade night', description: 'The parade starts.', locationKey: 'opening' },
  npcs: [{
    name: 'Mara Quill', role: 'Mapmaker', appearance: 'Ink-stained gloves.', locationKey: 'opening', presence: 'present',
    communicationChannel: null, hiddenIdentity: null, aliases: [], personality: ['Careful'], limits: [], dialogueExamples: [], secrets: ['Sold a false map.'],
    motivation: 'Keep her shop open.', goal: 'Find the thief.', mood: 'nervous', knowledge: [{ statement: 'The map was stolen at dusk.', category: 'fact' }],
    partyStance: null, partyReason: '',
  }],
  tracks: [{ label: 'Find the map', kind: 'progress', max: 4, visibility: 'public', ticksEachActionRound: false, completionText: 'The map is found.' }],
  facts: [{ text: 'The fair lasts one night.', visibility: 'public' }],
});

suite('scenario draft routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let hostToken: string;
  let cookie: string;
  let hostActor: string;
  let generateScenario: ReturnType<typeof vi.fn>;
  let provider: AiProvider;

  const call = (url: string, payload?: Record<string, unknown>, session = cookie, headers: Record<string, string> = {}) =>
    app.inject({ method: payload === undefined ? 'GET' : 'POST', url, headers: { origin, ...(session ? { cookie: session } : {}), ...headers }, ...(payload === undefined ? {} : { payload }) });
  const pair = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const start = (payload: Record<string, unknown> = { prompt: 'A harbor fair with a stolen map' }, session = cookie) => call('/api/authoring/scenario-drafts', payload, session);
  const poll = (id: string, session = cookie) => call(`/api/authoring/scenario-drafts/${id}`, undefined, session);
  async function untilDone(id: string, session = cookie) {
    for (let i = 0; i < 100; i++) {
      const response = await poll(id, session);
      expect(response.statusCode, response.body).toBe(200);
      if (response.json().status !== 'running') return response.json();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('The draft never finished.');
  }
  async function boot(options: { scenarioTimeoutMs?: number; withMethod?: boolean } = {}) {
    await app?.close();
    provider = new FakeAiProvider();
    provider.generateScenario = options.withMethod === false ? undefined : generateScenario as AiProvider['generateScenario'];
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, provider, serveStatic: false, ...(options.scenarioTimeoutMs ? { scenarioTimeoutMs: options.scenarioTimeoutMs } : {}) });
    const signIn = await app.inject({ method: 'POST', url: '/api/auth/host', headers: { origin }, payload: { token: hostToken } });
    expect(signIn.statusCode, signIn.body).toBe(200);
    cookie = pair(signIn);
  }
  async function counts() {
    const owned = (table: string) => pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE owner_id=$1`, [hostActor]);
    return {
      templates: (await owned('library_templates')).rows[0].n,
      versions: (await pool.query('SELECT count(*)::int AS n FROM library_versions v JOIN library_templates t ON t.id=v.template_id WHERE t.owner_id=$1', [hostActor])).rows[0].n,
      sessions: (await owned('sessions')).rows[0].n,
      receipts: (await pool.query('SELECT count(*)::int AS n FROM command_receipts WHERE actor_id=$1', [hostActor])).rows[0].n,
    };
  }

  beforeEach(async () => {
    hostToken = `scenario-drafts-test-${randomUUID()}`;
    generateScenario = vi.fn().mockImplementation(async () => draft());
    pool = createPool(databaseUrl!);
    await boot();
    hostActor = hash(hostToken);
  });
  afterEach(async () => { await app?.close(); await pool?.end(); });

  it('answers 202 with a running job and lets its owner read it', async () => {
    const response = await start({ prompt: '  A harbor fair  ', size: 'small' });
    expect(response.statusCode, response.body).toBe(202);
    const job = response.json();
    expect(job).toMatchObject({ status: 'running', size: 'small' });
    expect(Date.parse(job.deadlineAt) - Date.parse(job.startedAt)).toBe(180_000);
    const read = await poll(job.jobId);
    expect(read.statusCode).toBe(200);
    expect(read.json().jobId).toBe(job.jobId);
    await untilDone(job.jobId);
  });

  it('scales the deadline by size', async () => {
    await boot({ scenarioTimeoutMs: 60_000 });
    const gap = async (size: string) => {
      const job = (await start({ prompt: 'A story', size })).json();
      await untilDone(job.jobId);
      return Date.parse(job.deadlineAt) - Date.parse(job.startedAt);
    };
    expect(await gap('small')).toBe(60_000);
    expect(await gap('medium')).toBe(80_000);
    expect(await gap('large')).toBe(120_000);
  });

  it('refuses callers who are not signed in as the host, before reading the body', async () => {
    expect((await start({}, '')).statusCode).toBe(401);
    expect((await poll(randomUUID(), '')).statusCode).toBe(401);
    expect((await call('/api/authoring/scenario-drafts', { prompt: 'x' }, cookie, { origin: 'https://attacker.invalid' })).statusCode).toBe(403);

    const session = (await call('/api/sessions', { commandId: randomUUID() })).json();
    const roleCookies: string[] = [];
    for (const role of ['player', 'stage']) {
      const token = session.invites.find((invite: { role: string }) => invite.role === role).token;
      const redeemed = await app.inject({ method: 'POST', url: '/api/auth/redeem', headers: { origin }, payload: { token } });
      expect(redeemed.statusCode, redeemed.body).toBe(200);
      roleCookies.push(pair(redeemed));
    }
    const link = await call('/api/character-builders', { commandId: randomUUID(), label: 'Private builder', instructions: '' });
    expect(link.statusCode, link.body).toBe(200);
    const access = await app.inject({ method: 'POST', url: '/api/character-builder/access', headers: { origin }, payload: { token: link.json().token } });
    expect(access.statusCode, access.body).toBe(200);
    roleCookies.push(pair(access));

    for (const other of roleCookies) {
      const refused = await start({ prompt: 'A story' }, other);
      expect([401, 403]).toContain(refused.statusCode);
      expect([401, 403]).toContain((await poll(randomUUID(), other)).statusCode);
    }
    const player = await start({}, roleCookies[0]);
    expect(player.statusCode).toBe(403);
    expect(player.json().message).toBe('Only the director can generate scenarios.');
    expect(generateScenario).not.toHaveBeenCalled();
  });

  it('rejects unknown keys and bad bodies with 400', async () => {
    const valid = { prompt: 'A story' };
    const invalid = [
      {}, { prompt: '   ' }, { prompt: 'x'.repeat(4001) }, { ...valid, size: 'huge' }, { ...valid, boundaries: 'none' },
      { ...valid, boundaries: Array.from({ length: 31 }, (_, i) => `Boundary ${i}`) },
      ...['instructions', 'premise', 'sessionId', 'commandId', 'ownerId'].map(key => ({ ...valid, [key]: 'forged' })),
    ];
    for (const payload of invalid) expect((await start(payload)).statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
    expect(generateScenario).not.toHaveBeenCalled();
  });

  it('answers 503 when the provider cannot write scenarios', async () => {
    await boot({ withMethod: false });
    const response = await start();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'generation_unavailable', message: 'AI drafting is not available right now. You can still fill in the form yourself.' });
  });

  it('runs to a definition the editor accepts, with boundaries, suggestions and a deadline', async () => {
    const job = (await start({ prompt: 'A harbor fair', size: 'medium', boundaries: ['No gore.'] })).json();
    const done = await untilDone(job.jobId);
    expect(done.status).toBe('succeeded');
    expect(ScenarioDefinitionSchema.safeParse(done.definition).success).toBe(true);
    expect(done.definition.title).toBe('The Lantern Fair');
    expect(done.definition.pictureStyle).toBe('Ink and watercolor, soft dawn light');
    expect(done.definition.boundaries).toEqual(['No gore.', 'Keep serious injuries off screen.']);
    expect(done.suggestedBoundaries).toEqual(['Keep serious injuries off screen.']);
    expect(generateScenario).toHaveBeenCalledTimes(1);
    const [request, options] = generateScenario.mock.calls[0]!;
    expect(request).toMatchObject({ prompt: 'A harbor fair', size: 'medium', boundaries: ['No gore.'] });
    expect(options.deadlineAt).toBe(Date.parse(job.deadlineAt));
    expect((await poll(job.jobId)).json()).toEqual(done);
  });

  it('answers 409 to a second start while one is running, then allows another once it ends', async () => {
    let release!: (value: ScenarioDraft) => void;
    generateScenario.mockImplementationOnce(() => new Promise<ScenarioDraft>(resolve => { release = resolve; }));
    const first = (await start()).json();
    const second = await start();
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'conflict', message: 'A scenario draft is still being written. Wait for it to finish.' });
    expect(generateScenario).toHaveBeenCalledTimes(1);
    release(draft());
    expect((await untilDone(first.jobId)).status).toBe('succeeded');
    expect((await start()).statusCode).toBe(202);
  });

  it('gives a producer its own job slot and hides the host job from it', async () => {
    const releases: Array<(value: ScenarioDraft) => void> = [];
    const hang = () => new Promise<ScenarioDraft>(resolve => { releases.push(resolve); });
    generateScenario.mockImplementationOnce(hang).mockImplementationOnce(hang);
    const hostJob = (await start()).json();
    const grant = await call('/api/producers', { commandId: randomUUID(), label: 'Night producer' });
    expect(grant.statusCode, grant.body).toBe(200);
    const signIn = await app.inject({ method: 'POST', url: '/api/auth/producer', headers: { origin }, payload: { token: grant.json().token } });
    expect(signIn.statusCode, signIn.body).toBe(200);
    const producer = pair(signIn);

    const producerStart = await start({ prompt: 'A producer story' }, producer);
    expect(producerStart.statusCode, producerStart.body).toBe(202);
    const producerJob = producerStart.json();
    expect(producerJob.jobId).not.toBe(hostJob.jobId);
    expect((await start({ prompt: 'Again' }, producer)).statusCode).toBe(409);

    const hidden = await poll(hostJob.jobId, producer);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ code: 'not_found', message: GONE });
    expect((await poll(producerJob.jobId, cookie)).statusCode).toBe(404);
    expect((await poll(producerJob.jobId, producer)).statusCode).toBe(200);
    expect((await poll(hostJob.jobId)).statusCode).toBe(200);
    releases.forEach(release => release(draft()));
    await untilDone(hostJob.jobId);
    await untilDone(producerJob.jobId, producer);
  });

  it('answers 404 for unknown job ids', async () => {
    for (const id of [randomUUID(), 'nope']) {
      const response = await poll(id);
      expect(response.statusCode).toBe(404);
      expect(response.json().message).toBe(GONE);
    }
  });

  it('ends a hung provider as a timeout', async () => {
    await boot({ scenarioTimeoutMs: 50 });
    generateScenario.mockImplementation(() => new Promise(() => {}));
    const job = (await start({ prompt: 'A story', size: 'small' })).json();
    const done = await untilDone(job.jobId);
    expect(done).toEqual({ status: 'failed', jobId: job.jobId, code: 'generation_timeout', message: 'The AI took too long. Try again, or fill in the form yourself.' });
  });

  it('ends a throwing provider as a failure without leaking its text', async () => {
    generateScenario.mockRejectedValue(new Error('secret upstream detail sk-12345'));
    const job = (await start()).json();
    const done = await untilDone(job.jobId);
    expect(done).toEqual({ status: 'failed', jobId: job.jobId, code: 'generation_failed', message: "The AI's draft did not fit the form. Try again, or fill in the form yourself." });
    expect(JSON.stringify(done)).not.toContain('sk-12345');
    generateScenario.mockRejectedValue(new ProviderError('timeout', 'ClewdR'));
    expect((await untilDone((await start()).json().jobId)).code).toBe('generation_timeout');
  });

  it('leaves the picture style out of the definition when the draft style is blank', async () => {
    generateScenario.mockResolvedValueOnce({ ...draft(), pictureStyle: '' });
    const job = (await start()).json();
    const done = await untilDone(job.jobId);
    expect(done.status).toBe('succeeded');
    expect(ScenarioDefinitionSchema.safeParse(done.definition).success).toBe(true);
    expect('pictureStyle' in done.definition).toBe(false);
  });

  it('fails a draft that does not fit the schema or repair rules, without leaking details', async () => {
    generateScenario.mockResolvedValueOnce({ ...draft(), locations: [] });
    const bad = await untilDone((await start()).json().jobId);
    expect(bad).toMatchObject({ status: 'failed', code: 'generation_failed' });
    generateScenario.mockResolvedValueOnce({ title: 5 });
    expect(await untilDone((await start()).json().jobId)).toMatchObject({ status: 'failed', code: 'generation_failed' });
  });

  it('writes nothing to the database', async () => {
    const before = await counts();
    const job = (await start({ prompt: 'A story', boundaries: ['No gore.'] })).json();
    expect((await untilDone(job.jobId)).status).toBe('succeeded');
    generateScenario.mockRejectedValueOnce(new Error('nope'));
    expect((await untilDone((await start()).json().jobId)).status).toBe('failed');
    expect(await counts()).toEqual(before);
  });
});
