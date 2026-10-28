import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AiDraft, DirectorSnapshot, PlanResult, ProviderContext, SessionState } from '@rpg/contracts';
import { buildApp, hash } from '../src/app';
import { createPool, transaction } from '../src/database';
import { readState, saveState } from '../src/repository';
import { FakeAiProvider } from '../src/fake-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'director-corrections-steering-test-credential';

suite('director corrections and private beat steering', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let host: string, player: string, stage: string, sessionId: string;
  let snapshot: DirectorSnapshot;
  let diceCalls: number;
  let contexts: ProviderContext[];
  const fake = new FakeAiProvider();
  let plan: (context: ProviderContext) => Promise<PlanResult>;
  let render: (context: ProviderContext) => Promise<AiDraft>;
  const options = { databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, providerTimeoutMs: 2000,
    rollDie: () => { diceCalls++; return 4; },
    provider: { plan: (context: ProviderContext) => { contexts.push(context); return plan(context); }, render: (context: ProviderContext) => { contexts.push(context); return render(context); } },
  };
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (path: string, payload?: Record<string, unknown>, credential = host) => app.inject({ method: payload === undefined ? 'GET' : 'POST', url: path, headers: { origin, cookie: credential }, ...(payload === undefined ? {} : { payload }) });
  const command = (value: Record<string, unknown>, credential = host) => request(`/api/sessions/${sessionId}/commands`, { commandId: randomUUID(), ...value }, credential);
  const refresh = async () => { snapshot = (await request(`/api/sessions/${sessionId}`)).json(); };
  async function ok(value: Record<string, unknown>) {
    const response = await command(value);
    expect(response.statusCode, response.body).toBe(200);
    snapshot = response.json().snapshot;
    return response;
  }
  const beatCommand = (type: string, value: Record<string, unknown> = {}) => ({ type, beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, ...value });
  const correction = (value: Record<string, unknown> = {}) => ({ type: 'record_correction', expectedStateRevision: snapshot.session.stateRevision, publishedBeatId: snapshot.history[0]!.id, publicText: 'The director clarifies the previous scene.', reason: 'Private reason for this correction', discardQueuedInput: true, changes: [], ...value });
  const factChange = () => ({ kind: 'fact_replace', factId: snapshot.facts[0]!.id, text: 'The ledger concerns a voluntary departure.', knowledgeUpdates: snapshot.npcDetails.flatMap(npc => npc.knowledge.filter(memory => memory.category === 'fact' && memory.statement === snapshot.facts[0]!.text).map(memory => ({ npcId: npc.id, knowledgeId: memory.id, mode: 'correct' }))) });
  async function mutate(action: (state: SessionState) => void) {
    await transaction(pool, async client => { const state = await readState(client, sessionId); action(state); await saveState(client, state); });
    await refresh();
  }
  async function submit(kind = 'say') {
    const response = await command({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: snapshot.session.inputEpoch, contextBeatId: snapshot.activeBeat?.id ?? null, kind,
      text: kind === 'act' ? '' : 'A queued question', intent: kind === 'act' ? 'Open the archive' : '', approach: kind === 'act' ? 'Study the latch' : '' }, player);
    expect(response.statusCode, response.body).toBe(200);
    await refresh();
  }
  async function prepare(kind: 'action' | 'conversation' = 'action') {
    await ok({ type: 'open_beat', kind, expectedInputEpoch: snapshot.session.inputEpoch });
    await submit(kind === 'action' ? 'act' : 'say');
    await ok(beatCommand('plan_beat', { submissionIds: snapshot.submissions.filter(item => item.status === 'queued').map(item => item.id) }));
    await ok(beatCommand('approve_stakes', { classification: kind === 'action' ? 'action' : 'ordinary', contracts: kind === 'action' ? snapshot.activeBeat!.contracts : [] }));
  }
  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp(options);
    host = cookie(await request('/api/auth/host', { token: hostToken }, ''));
  });
  beforeEach(async () => {
    diceCalls = 0; contexts = []; plan = value => fake.plan(value); render = value => fake.render(value);
    const created = (await request('/api/sessions', { commandId: randomUUID() })).json(); sessionId = created.sessionId;
    player = cookie(await request('/api/auth/redeem', { token: created.invites[0].token }, ''));
    stage = cookie(await request('/api/auth/redeem', { token: created.invites.at(-1).token }, ''));
    await refresh();
    await ok({ type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });
    await prepare(); await ok(beatCommand('lock_beat')); await ok(beatCommand('render_beat'));
    await ok(beatCommand('publish_beat', { expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat!.draftRevision, textOnly: true }));
    await mutate(state => {
      for (const [index, npc] of state.npcs.entries()) npc.knowledge.push({ id: randomUUID(), statement: state.facts[0]!.text, category: index < 2 ? 'fact' : 'belief', acquisition: 'told', sourceEventId: state.facts[0]!.sourceEventId, sourceEntityId: state.characters[0]!.id, learnedBeatNumber: 1 });
    });
    contexts = [];
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  it('limits both tools to the owning director and retains origin validation', async () => {
    const otherToken = randomUUID();
    await pool.query("INSERT INTO credentials(token_hash,actor_id,role,expires_at) VALUES($1,$2,'host',now()+interval '1 hour')", [hash(otherToken), randomUUID()]);
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    for (const payload of [correction(), beatCommand('set_beat_steering', { text: 'Private direction' })]) {
      expect((await command(payload, '')).statusCode).toBe(401);
      expect((await command(payload, player)).statusCode).toBe(403);
      expect((await command(payload, stage)).statusCode).toBe(403);
      expect((await command(payload, `rpg_session=${otherToken}`)).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/commands`, headers: { origin: 'https://attacker.invalid', cookie: host }, payload: { commandId: randomUUID(), ...payload } })).statusCode).toBe(403);
    }
  });

  it('records a public clarification while cancelling only pending in-character input and preserving public/private separation', async () => {
    await submit(); await submit('ooc');
    await pool.query("UPDATE submissions SET status='selected',data=jsonb_set(data,'{status}',to_jsonb('selected'::text)) WHERE session_id=$1 AND status='queued' AND data->>'kind'='say'", [sessionId]); await refresh();
    const before = structuredClone(snapshot);
    const result = await ok(correction());
    expect(snapshot.session).toEqual({ ...before.session, stateRevision: before.session.stateRevision + 1, inputEpoch: before.session.inputEpoch + 1 });
    expect(snapshot.characterDetails).toEqual(before.characterDetails);
    expect(snapshot.npcDetails).toEqual(before.npcDetails);
    expect(snapshot.history).toEqual(before.history);
    expect(snapshot.submissions.find(item => item.kind === 'say')).toMatchObject({ status: 'cancelled', revision: 2 });
    expect(snapshot.submissions.find(item => item.kind === 'ooc')).toMatchObject({ status: 'queued', revision: 1 });
    const events = (await pool.query('SELECT id,kind,data FROM audit_events WHERE session_id=$1 AND command_id=$2', [sessionId, result.json().commandId])).rows;
    expect(events).toHaveLength(1); expect(events[0].kind).toBe('correction.recorded');
    const notice = events[0].data.public;
    expect(notice).toEqual({ id: events[0].id, publishedBeatId: before.history[0]!.id, beatNumber: before.history[0]!.beatNumber, stateRevision: snapshot.session.stateRevision, publicText: correction().publicText, recordedAt: expect.any(String) });
    expect(Number.isFinite(Date.parse(notice.recordedAt))).toBe(true);
    expect(events[0].data).toMatchObject({ reason: correction().reason, changes: [], before: expect.any(Object), after: expect.any(Object), cancelledSubmissionIds: [before.submissions.find(item => item.kind === 'say')!.id] });
    await pool.query("UPDATE audit_events SET data=jsonb_set(data,'{public,reason}',to_jsonb('Private nested trap'::text),true) WHERE id=$1", [notice.id]);
    for (const credential of [host, player, stage]) {
      const response = await request(`/api/sessions/${sessionId}`, undefined, credential);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().corrections).toEqual([notice]);
      expect(response.body).not.toContain(correction().reason);
      expect(response.body).not.toContain('Private nested trap');
      expect(response.json().history).toEqual(before.history);
    }
  });

  it('atomically replaces public facts, reconciles every factual memory, sets strain and track values, and preserves provenance metadata', async () => {
    const before = structuredClone(snapshot);
    const fact = factChange(); fact.knowledgeUpdates[1]!.mode = 'retain_belief';
    const changes = [fact, { kind: 'strain_set', characterId: snapshot.characters[0]!.id, value: 2 }, { kind: 'track_set', trackId: snapshot.tracks[0]!.id, value: 4 }];
    const result = await ok(correction({ changes }));
    const event = (await pool.query('SELECT id,data FROM audit_events WHERE command_id=$1', [result.json().commandId])).rows[0];
    expect(snapshot.facts[0]!.text).toBe(fact.text); expect(snapshot.characters[0]!.strain).toBe(2); expect(snapshot.tracks[0]!.current).toBe(4);
    expect(event.data.changes).toEqual(changes);
    for (const [index, update] of fact.knowledgeUpdates.entries()) {
      const originalNpc = before.npcDetails.find(npc => npc.id === update.npcId)!;
      const npc = snapshot.npcDetails.find(npc => npc.id === update.npcId)!;
      const original = originalNpc.knowledge.find(memory => memory.id === update.knowledgeId)!;
      expect(npc.version).toBe(originalNpc.version + 1);
      expect(npc.relationships).toEqual(originalNpc.relationships);
      expect(npc.knowledge.find(memory => memory.id === update.knowledgeId)).toEqual({ ...original, statement: index === 0 ? fact.text : original.statement, category: index === 0 ? 'fact' : 'belief', sourceEventId: event.id });
    }
    expect(snapshot.npcDetails[2]).toEqual(before.npcDetails[2]);
    const storedFact = (await pool.query('SELECT data FROM facts WHERE id=$1', [fact.factId])).rows[0].data;
    expect(storedFact.sourceEventId).toBe(event.id);
  });

  it('versions an affected NPC once across distinct fact corrections and rejects repeated memory targets across changes', async () => {
    let secondId = ''; let secondMemory = '';
    await mutate(state => {
      secondId = randomUUID(); secondMemory = randomUUID();
      state.facts.push({ id: secondId, text: 'An unrelated factual statement.', visibility: 'public', sourceEventId: 'test-source' });
      state.npcs[0]!.knowledge.push({ id: secondMemory, statement: 'An unrelated factual statement.', category: 'fact', acquisition: 'witnessed', sourceEventId: 'test-source', sourceEntityId: null, learnedBeatNumber: 1 });
    });
    const version = snapshot.npcDetails[0]!.version;
    await ok(correction({ changes: [factChange(), { kind: 'fact_replace', factId: secondId, text: 'A corrected second statement.', knowledgeUpdates: [{ npcId: snapshot.npcDetails[0]!.id, knowledgeId: secondMemory, mode: 'correct' }] }] }));
    expect(snapshot.npcDetails[0]!.version).toBe(version + 1);
    await mutate(state => { state.facts.push({ id: randomUUID(), text: state.facts[0]!.text, visibility: 'public', sourceEventId: 'test-source' }); });
    const first = { ...factChange(), text: 'A subsequent corrected statement.' };
    const before = structuredClone(snapshot);
    expect([400, 409]).toContain((await command(correction({ changes: [first, { ...first, factId: snapshot.facts.at(-1)!.id, text: 'Conflicting memory rewrite' }] }))).statusCode);
    await refresh(); expect(snapshot).toEqual(before);
  });

  it('corrects all 101 matching factual memories and versions each affected NPC only once', async () => {
    await mutate(state => {
      const original = state.npcs[0]!.knowledge.find(memory => memory.category === 'fact' && memory.statement === state.facts[0]!.text)!;
      state.npcs[0]!.knowledge.push(...Array.from({ length: 99 }, () => ({ ...original, id: randomUUID() })));
    });
    const before = structuredClone(snapshot);
    const change = factChange();
    expect(change.knowledgeUpdates).toHaveLength(101);
    const value = { commandId: randomUUID(), ...correction({ changes: [change] }) };
    await ok(value);
    const event = (await pool.query("SELECT id,data FROM audit_events WHERE command_id=$1 AND kind='correction.recorded'", [value.commandId])).rows[0];
    expect(event.data.changes[0].knowledgeUpdates).toHaveLength(101);
    expect(snapshot.npcDetails).toEqual(before.npcDetails.map(npc => {
      const affected = npc.knowledge.some(memory => memory.category === 'fact' && memory.statement === before.facts[0]!.text);
      return { ...npc, version: npc.version + Number(affected), knowledge: npc.knowledge.map(memory => memory.category === 'fact' && memory.statement === before.facts[0]!.text
        ? { ...memory, statement: change.text, sourceEventId: event.id } : memory) };
    }));
    expect(snapshot.npcDetails.flatMap(npc => npc.knowledge).filter(memory => memory.sourceEventId === event.id)).toHaveLength(101);
    const corrected = structuredClone(snapshot);
    await ok(value);
    expect(snapshot).toEqual(corrected);
  });

  it('rejects unknown, private, duplicate, out-of-range and no-op targets atomically without consuming queued input', async () => {
    await mutate(state => {
      state.facts.push({ id: randomUUID(), text: 'Private fact', visibility: 'director', sourceEventId: 'seed' });
      state.tracks.push({ ...state.tracks[0]!, id: randomUUID(), visibility: 'director' });
    });
    await submit();
    const before = structuredClone(snapshot);
    const raw = await transaction(pool, client => readState(client, sessionId));
    const sameStrain = { kind: 'strain_set', characterId: snapshot.characters[0]!.id, value: snapshot.characters[0]!.strain };
    const changedStrain = { ...sameStrain, value: 3 };
    const invalid = [
      [{ kind: 'strain_set', characterId: 'unknown', value: 2 }], [sameStrain],
      [{ kind: 'track_set', trackId: snapshot.tracks[0]!.id, value: snapshot.tracks[0]!.current }],
      [{ kind: 'track_set', trackId: snapshot.tracks[0]!.id, value: snapshot.tracks[0]!.max + 1 }],
      [{ kind: 'track_set', trackId: raw.tracks.at(-1)!.id, value: 1 }],
      [{ ...factChange(), factId: raw.facts.at(-1)!.id, knowledgeUpdates: [] }],
      [{ ...factChange(), text: snapshot.facts[0]!.text }],
      [{ ...factChange(), factId: 'unknown', knowledgeUpdates: [] }],
      [changedStrain, changedStrain], [factChange(), factChange()],
      [changedStrain, { kind: 'track_set', trackId: 'unknown', value: 1 }],
    ];
    for (const changes of invalid) {
      const id = randomUUID();
      expect([400, 409]).toContain((await command(correction({ commandId: id, changes }))).statusCode);
      await refresh(); expect(snapshot).toEqual(before);
      expect((await pool.query('SELECT 1 FROM command_receipts WHERE command_id=$1', [id])).rowCount).toBe(0);
    }
  });

  it('requires exact knowledge coverage and rejects omitted, duplicate, unknown, and unaffected memories', async () => {
    const valid = factChange();
    const unrelated = snapshot.npcDetails[0]!.knowledge.find(memory => memory.statement !== snapshot.facts[0]!.text)!;
    const invalid = [[], valid.knowledgeUpdates.slice(0, 1), [...valid.knowledgeUpdates, valid.knowledgeUpdates[0]!],
      [...valid.knowledgeUpdates, { npcId: 'unknown', knowledgeId: 'unknown', mode: 'correct' }],
      [...valid.knowledgeUpdates, { npcId: snapshot.npcDetails[0]!.id, knowledgeId: unrelated.id, mode: 'correct' }],
      valid.knowledgeUpdates.map((item, index) => index === 0 ? { ...item, knowledgeId: 'unknown' } : item),
      [...valid.knowledgeUpdates, { npcId: snapshot.npcDetails[2]!.id, knowledgeId: snapshot.npcDetails[2]!.knowledge.at(-1)!.id, mode: 'correct' }],
    ];
    const before = structuredClone(snapshot);
    for (const knowledgeUpdates of invalid) {
      expect([400, 409]).toContain((await command(correction({ changes: [{ ...valid, knowledgeUpdates }] }))).statusCode);
      await refresh(); expect(snapshot).toEqual(before);
    }
  });

  it('preserves published transcripts, rolls, accepted inputs, audio records, round counters, and completion effects', async () => {
    await mutate(state => {
      const countdown = state.tracks.find(track => track.kind === 'countdown')!;
      countdown.enabled = true; countdown.current = countdown.max - 1;
      countdown.completionEffects = [{ kind: 'strain_delta', characterId: state.characters[0]!.id, delta: 4 }];
    });
    const beatId = snapshot.history[0]!.id;
    await pool.query("INSERT INTO audio_manifests(session_id,beat_id,config_hash,status,lease_id,lease_until,manifest) VALUES($1,$2,'test-audio','ready','lease',now(),$3)", [sessionId, beatId, { preserved: 'Original cached audio' }]);
    await pool.query("INSERT INTO audio_assets(id,session_id,content_type,byte_length) VALUES($1,$2,'audio/mpeg',10)", [randomUUID(), sessionId]);
    const preserved = async () => {
      const values = [];
      for (const table of ['published_beats', 'rolls', 'action_contracts', 'beats', 'audio_manifests', 'audio_assets', 'submissions']) values.push((await pool.query(`SELECT * FROM ${table} WHERE session_id=$1 ORDER BY 1`, [sessionId])).rows);
      return values;
    };
    const beforeRecords = await preserved(); const before = structuredClone(snapshot); const beforeDice = diceCalls;
    const countdown = snapshot.tracks.find(track => track.kind === 'countdown')!;
    await ok(correction({ changes: [{ kind: 'track_set', trackId: countdown.id, value: countdown.max }] }));
    expect(await preserved()).toEqual(beforeRecords); expect(diceCalls).toBe(beforeDice);
    expect(snapshot.session.beatNumber).toBe(before.session.beatNumber); expect(snapshot.session.actionRoundNumber).toBe(before.session.actionRoundNumber);
    expect(snapshot.characters).toEqual(before.characters);
    expect(snapshot.tracks.filter(track => track.id !== countdown.id)).toEqual(before.tracks.filter(track => track.id !== countdown.id));
  });

  it('serializes correction retries, rejects stale revisions, and retains the exact receipt across restart', async () => {
    const value = { commandId: randomUUID(), ...correction() };
    const responses = await Promise.all([command(value), command(value)]);
    expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
    expect(responses[0]!.json()).toEqual(responses[1]!.json());
    snapshot = responses[0]!.json().snapshot;
    expect((await command(correction({ expectedStateRevision: snapshot.session.stateRevision - 1 }))).statusCode).toBe(409);
    expect((await command({ ...value, publicText: 'Different correction' })).statusCode).toBe(409);
    expect((await pool.query('SELECT 1 FROM audit_events WHERE command_id=$1', [value.commandId])).rowCount).toBe(1);
    await app.close(); app = await buildApp(options);
    expect((await command(value)).json()).toEqual(responses[0]!.json());
  });

  it.each(['collecting', 'stakes_review', 'locked', 'draft_review'])('rejects correction during an active %s beat', async phase => {
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    await pool.query("UPDATE beats SET phase=$2,data=jsonb_set(data,'{phase}',to_jsonb($2::text)) WHERE id=$1", [snapshot.activeBeat!.id, phase]);
    expect((await command(correction())).statusCode).toBe(409);
  });

  it.each(['lobby', 'ended', 'unstarted'])('rejects both controls in %s sessions', async status => {
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    if (status === 'unstarted') await pool.query('UPDATE sessions SET setup=$2 WHERE id=$1', [sessionId, { boundaries: [], boundariesRevision: 0, started: false, scenario: { templateId: 'test', version: 1 } }]);
    else await pool.query('UPDATE sessions SET status=$2 WHERE id=$1', [sessionId, status]);
    expect((await command(beatCommand('set_beat_steering', { text: 'No change allowed' }))).statusCode).toBe(409);
    await pool.query("UPDATE beats SET phase='aborted',data=jsonb_set(data,'{phase}',to_jsonb('aborted'::text)) WHERE id=$1", [snapshot.activeBeat!.id]);
    expect((await command(correction())).statusCode).toBe(409);
  });

  it('supports paused corrections, requires an owned published reference, and bounds correction context passed to providers', async () => {
    expect((await command(correction({ publishedBeatId: 'unknown' }))).statusCode).toBe(404);
    const other = (await request('/api/sessions', { commandId: randomUUID() })).json().sessionId;
    const foreignId = randomUUID();
    const originalBeat = (await pool.query('SELECT data FROM beats WHERE id=$1', [snapshot.history[0]!.id])).rows[0].data;
    await pool.query("INSERT INTO beats(id,session_id,kind,phase,data) VALUES($1,$2,'action','published',$3)", [foreignId, other, { ...originalBeat, id: foreignId, sessionId: other }]);
    await pool.query('INSERT INTO published_beats(id,session_id,beat_number,data) VALUES($1,$2,1,$3)', [foreignId, other, { ...snapshot.history[0], id: foreignId }]);
    expect((await command(correction({ publishedBeatId: foreignId }))).statusCode).toBe(404);
    await ok({ type: 'set_status', status: 'paused', expectedStateRevision: snapshot.session.stateRevision });
    for (let index = 0; index < 13; index++) await ok(correction({ publicText: `Public correction ${index}` }));
    await ok({ type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });
    await prepare('conversation');
    expect(contexts.at(-1)!.corrections).toHaveLength(12);
    expect(contexts.at(-1)!.corrections!.map(item => item.publicText)).toEqual(Array.from({ length: 12 }, (_, i) => `Public correction ${i + 1}`));
    expect(JSON.stringify(contexts)).not.toContain(correction().reason);
  });

  it('resets pre-lock proposals while retaining selected inputs, and keeps steering private but available to future planning', async () => {
    await prepare();
    const before = structuredClone(snapshot);
    expect(before.activeBeat!.steering).toBe('');
    const text = 'Private: focus on the locked cabinet, without deciding player actions.';
    const result = await ok(beatCommand('set_beat_steering', { text: `  ${text}  ` }));
    expect(snapshot.session).toEqual(before.session);
    expect(snapshot.activeBeat).toMatchObject({ steering: text, phase: 'collecting', classification: null, contracts: [], stakesApproved: false, draft: null, approvedContinuity: [], lastError: null, selectedSubmissionIds: before.activeBeat!.selectedSubmissionIds, revision: before.activeBeat!.revision + 1, generation: before.activeBeat!.generation + 1 });
    expect(snapshot.submissions).toEqual(before.submissions);
    const audit = (await pool.query('SELECT data FROM audit_events WHERE command_id=$1', [result.json().commandId])).rows[0].data;
    expect(audit).toMatchObject({ before: '', after: text });
    for (const credential of [player, stage]) expect((await request(`/api/sessions/${sessionId}`, undefined, credential)).body).not.toContain(text);
    await ok(beatCommand('plan_beat', { submissionIds: snapshot.activeBeat!.selectedSubmissionIds }));
    expect(contexts.at(-1)!.beat.steering).toBe(text);
  });

  it('keeps locked dice, contracts, snapshots and counters when steering invalidates a reviewed draft', async () => {
    await prepare(); await ok(beatCommand('lock_beat')); await ok(beatCommand('render_beat'));
    await ok(beatCommand('approve_continuity', { updates: [{ kind: 'world_fact', factId: randomUUID(), text: 'A proposal only', visibility: 'public', sourceSubmissionIds: snapshot.activeBeat!.lockedSubmissions.map(item => item.id) }] }));
    const before = structuredClone(snapshot); const calls = diceCalls;
    await ok(beatCommand('set_beat_steering', { text: 'Private: describe the fixed consequence calmly.' }));
    const current = snapshot.activeBeat!;
    expect(current).toMatchObject({ phase: 'locked', draft: null, approvedContinuity: [], lastError: null, revision: before.activeBeat!.revision + 1, generation: before.activeBeat!.generation + 1 });
    for (const key of ['contracts', 'resolution', 'inputSnapshotHash', 'lockedSubmissions', 'sourceStateRevision', 'selectedSubmissionIds', 'stakesApproved', 'classification'] as const) expect(current[key]).toEqual(before.activeBeat![key]);
    expect(snapshot.session).toEqual(before.session); expect(snapshot.submissions).toEqual(before.submissions); expect(diceCalls).toBe(calls);
    expect((await command(beatCommand('publish_beat', { expectedStateRevision: snapshot.session.stateRevision, draftRevision: current.draftRevision, textOnly: true }))).statusCode).toBe(409);
    await ok(beatCommand('render_beat'));
    expect(contexts.at(-1)!.beat.steering).toContain('fixed consequence'); expect(diceCalls).toBe(calls);
    await ok(beatCommand('publish_beat', { expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat!.draftRevision, textOnly: true }));
    expect(snapshot.history.at(-1)!.rolls).toEqual(before.activeBeat!.resolution!.rolls);
    expect(JSON.stringify(snapshot.history)).not.toContain('Private:');
  });

  it('supports paused steering, clear-to-empty, legacy beats, idempotent retries, and rejects stale or inactive beat references', async () => {
    expect((await command({ type: 'set_beat_steering', beatId: snapshot.history[0]!.id, expectedBeatRevision: 0, text: 'Stale' })).statusCode).toBe(409);
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    await pool.query("UPDATE beats SET data=data-'steering' WHERE id=$1", [snapshot.activeBeat!.id]); await refresh();
    await ok({ type: 'set_status', status: 'paused', expectedStateRevision: snapshot.session.stateRevision });
    const value = { commandId: randomUUID(), ...beatCommand('set_beat_steering', { text: 'Private direction' }) };
    const responses = await Promise.all([command(value), command(value)]);
    expect(responses.map(response => response.statusCode)).toEqual([200, 200]); expect(responses[0]!.json()).toEqual(responses[1]!.json());
    snapshot = responses[0]!.json().snapshot;
    expect((await command({ ...value, commandId: randomUUID() })).statusCode).toBe(409);
    expect((await command({ ...value, text: 'Changed' })).statusCode).toBe(409);
    await ok(beatCommand('set_beat_steering', { text: '   ' })); expect(snapshot.activeBeat!.steering).toBe('');
  });

  it.each(['plan', 'render'] as const)('cancels a pending %s job and rejects late output after steering changes', async task => {
    await prepare();
    if (task === 'render') await ok(beatCommand('lock_beat'));
    let finish: ((value: any) => void) | undefined;
    if (task === 'plan') plan = () => new Promise(resolve => { finish = resolve; });
    else render = () => new Promise(resolve => { finish = resolve; });
    const pending = command(beatCommand(task === 'plan' ? 'plan_beat' : 'render_beat', task === 'plan' ? { submissionIds: snapshot.activeBeat!.selectedSubmissionIds } : {}));
    try {
      await vi.waitFor(() => expect(finish).toBeDefined(), { timeout: 1000, interval: 10 });
      await refresh(); const before = structuredClone(snapshot);
      await ok(beatCommand('set_beat_steering', { text: 'Private replacement direction' }));
      expect(snapshot.jobs.at(-1)!.status).toBe('cancelled');
      finish!(task === 'plan' ? { classification: 'ordinary', contracts: [], directorSummary: 'Stale plan' } : { segments: [{ kind: 'narration', text: 'Stale generated text', recipientCharacterIds: [], delivery: 'neutral' }], continuity: [], directorSummary: '' });
      const response = await pending;
      expect(response.statusCode, response.body).toBe(409); expect(response.json().code).toBe('superseded');
      await refresh(); expect(snapshot.activeBeat!.draft).toBeNull(); expect(snapshot.activeBeat!.steering).toBe('Private replacement direction');
      expect(snapshot.activeBeat!.resolution).toEqual(before.activeBeat!.resolution);
      expect(snapshot.session).toEqual(before.session);
      expect(snapshot.jobs.at(-1)!.status).toBe('cancelled');
    } finally { finish?.({ classification: 'ordinary', contracts: [], directorSummary: '' }); await pending; }
  });
});
