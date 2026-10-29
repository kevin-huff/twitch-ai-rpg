import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DirectorSnapshot, ProviderContext } from '@rpg/contracts';
import { buildApp, hash } from '../src/app';
import { createPool } from '../src/database';
import { FakeAiProvider } from '../src/fake-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://localhost:3000';
const hostToken = 'live-director-test-host-credential';
const suite = databaseUrl ? describe : describe.skip;
suite('live director controls', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const pool = createPool(databaseUrl!);
  let host: string, player: string, stage: string, sessionId: string, snapshot: DirectorSnapshot;
  let context: ProviderContext | undefined;
  const provider = new FakeAiProvider();
  const options = { databaseUrl: databaseUrl!, hostToken, origin, provider: {
    plan: async (value: ProviderContext) => { context = value; return provider.plan(value); },
    render: (value: ProviderContext) => provider.render(value),
  } };
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (path: string, credential = host, payload?: unknown) => app.inject({ method: payload ? 'POST' : 'GET', url: path, headers: { origin, cookie: credential }, ...(payload ? { payload } : {}) });
  const refresh = async () => { snapshot = (await request(`/api/sessions/${sessionId}`)).json(); };
  const command = (value: Record<string, unknown>, credential = host) => request(`/api/sessions/${sessionId}/commands`, credential, { commandId: crypto.randomUUID(), ...value });
  const live = (value: Record<string, unknown>) => ({ expectedStateRevision: snapshot.session.stateRevision, reason: 'Director adjustment', discardQueuedInput: true, ...value });
  const scene = (value: Record<string, unknown> = {}) => live({ type: 'change_scene', title: 'At the docks', description: 'Rain falls.', location: { kind: 'new', title: 'Docks', description: 'Private catalog detail' }, presentNpcIds: [snapshot.npcs[0]!.id], ...value });
  const profile = () => { const { id: _id, version: _version, knowledge: _knowledge, relationships: _relationships, ...value } = snapshot.npcDetails[0]!; return value; };
  const save = (value: Record<string, unknown> = {}) => live({ type: 'save_npc', expectedNpcVersion: 0, profile: { ...profile(), displayName: 'New visitor' }, ...value });
  const reveal = (value: Record<string, unknown> = {}) => live({ type: 'reveal_npc', npcId: snapshot.npcs[0]!.id, expectedNpcVersion: snapshot.npcDetails[0]!.version, source: { kind: 'secret', index: 0 }, publicText: 'Mara admits knowing the former owner.', witnessNpcIds: [snapshot.npcs[0]!.id], ...value });
  async function ok(value: Record<string, unknown>) { const result = await command(value); expect(result.statusCode, result.body).toBe(200); snapshot = result.json().snapshot; return result; }
  async function submit(kind = 'say') {
    const result = await command({ type: 'save_submission', expectedSubmissionRevision: 0, contextBeatId: null, expectedInputEpoch: snapshot.session.inputEpoch, kind, text: 'A pending line' }, player);
    expect(result.statusCode, result.body).toBe(200); await refresh();
  }
  beforeAll(async () => { app = await buildApp(options); host = cookie(await request('/api/auth/host', '', { token: hostToken })); });
  beforeEach(async () => {
    const created = (await request('/api/sessions', host, { commandId: crypto.randomUUID() })).json(); sessionId = created.sessionId;
    for (const invite of [created.invites[0], created.invites.at(-1)]) {
      const credential = cookie(await request('/api/auth/redeem', '', { token: invite.token }));
      if (invite.role === 'stage') stage = credential; else player = credential;
    }
    await refresh(); context = undefined;
    await pool.query("UPDATE sessions SET status='live' WHERE id=$1", [sessionId]); await refresh();
  });
  afterAll(async () => { await app?.close(); await pool.end(); });

  it('requires authentication, director role, and session ownership for each control', async () => {
    const otherToken = crypto.randomUUID();
    await pool.query('INSERT INTO credentials(token_hash,actor_id,role,expires_at) VALUES($1,$2,$3,now()+interval \'1 hour\')', [hash(otherToken), crypto.randomUUID(), 'host']);
    for (const value of [scene(), save(), reveal()]) {
      expect((await command(value, '')).statusCode).toBe(401);
      expect((await command(value, player)).statusCode).toBe(403);
      expect((await command(value, stage)).statusCode).toBe(403);
      expect((await command(value, `rpg_session=${otherToken}`)).statusCode).toBe(404);
    }
  });
  it('creates server identities, retains location catalog, moves selected cast, and cancels only pending in-character input', async () => {
    await submit(); await submit('ooc');
    await pool.query("UPDATE submissions SET status='selected',data=jsonb_set(data,'{status}',to_jsonb('selected'::text)) WHERE session_id=$1 AND data->>'kind'='say'", [sessionId]); await refresh();
    const before = snapshot; const result = await ok(scene());
    expect(snapshot.session.stateRevision).toBe(before.session.stateRevision + 1);
    expect(snapshot.session.inputEpoch).toBe(before.session.inputEpoch + 1);
    expect(snapshot.session.scene.id).not.toBe(before.session.scene.id);
    expect(snapshot.locations.some(location => location.id === before.session.scene.locationId)).toBe(true);
    expect(snapshot.locations.some(location => location.id === snapshot.session.scene.locationId)).toBe(true);
    expect(snapshot.npcDetails[0]!.locationId).toBe(snapshot.session.scene.locationId);
    for (const npc of snapshot.npcDetails.slice(1)) { expect(npc.status).toBe('offstage'); expect(npc.locationId).toBe(before.npcDetails.find(item => item.id === npc.id)!.locationId); }
    expect(snapshot.submissions.find(item => item.kind === 'say')).toMatchObject({ status: 'cancelled', revision: 2 });
    expect(snapshot.submissions.find(item => item.kind === 'ooc')).toMatchObject({ status: 'queued', revision: 1 });
    const event = (await pool.query('SELECT data FROM audit_events WHERE command_id=$1', [result.json().commandId])).rows[0].data;
    expect(event.cancelledSubmissionIds).toEqual([before.submissions.find(item => item.kind === 'say')!.id]);
    expect(event.reason).toBe('Director adjustment'); expect(event.before).toBeTruthy(); expect(event.after).toBeTruthy();
    const publicState = (await request(`/api/sessions/${sessionId}`, stage)).json();
    expect(publicState).not.toHaveProperty('locations'); expect(JSON.stringify(publicState)).not.toContain('Private catalog detail');
  });
  it('supports paused operations and returns an identical receipt for concurrent retry and after restart', async () => {
    await ok({ type: 'set_status', expectedStateRevision: snapshot.session.stateRevision, status: 'paused' });
    const value = { commandId: crypto.randomUUID(), ...scene() };
    const responses = await Promise.all([command(value), command(value)]);
    expect(responses.map(item => item.statusCode)).toEqual([200, 200]); expect(responses[0]!.json()).toEqual(responses[1]!.json());
    const expected = responses[0]!.json().snapshot;
    await app.close(); app = await buildApp(options); await refresh(); expect(snapshot).toEqual(expected);
    expect((await command(value)).json()).toEqual(responses[0]!.json());
    expect((await command({ ...value, title: 'Different' })).statusCode).toBe(409);
    expect(Number((await pool.query('SELECT count(*) FROM audit_events WHERE command_id=$1', [value.commandId])).rows[0].count)).toBe(1);
  });
  it('rejects stale state and unknown identifiers without consuming input or recording success', async () => {
    await submit(); const before = snapshot;
    for (const value of [scene({ expectedStateRevision: 999 }), scene({ presentNpcIds: ['unknown'] }), scene({ location: { kind: 'existing', locationId: 'unknown' } }), save({ profile: { ...profile(), locationId: 'unknown' } }), save({ npcId: 'unknown', expectedNpcVersion: 1 }), reveal({ npcId: 'unknown' }), reveal({ expectedNpcVersion: 999 }), reveal({ source: { kind: 'secret', index: 999 } }), reveal({ witnessNpcIds: ['unknown'] })]) {
      expect((await command(value)).statusCode).toBe(409); await refresh(); expect(snapshot).toEqual(before);
    }
  });
  it.each(['collecting', 'stakes_review', 'locked', 'draft_review'])('rejects all controls during an active %s beat', async phase => {
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    await pool.query('UPDATE beats SET phase=$2,data=jsonb_set(data,\'{phase}\',to_jsonb($2::text)) WHERE id=$1', [snapshot.activeBeat!.id, phase]);
    for (const value of [scene(), save(), reveal()]) expect((await command(value)).statusCode).toBe(409);
  });
  it.each(['lobby', 'ended', 'unstarted'])('rejects all controls for %s sessions', async status => {
    if (status === 'unstarted') await pool.query('UPDATE sessions SET setup=$2 WHERE id=$1', [sessionId, { boundaries: [], boundariesRevision: 0, started: false, scenario: { templateId: 'legacy-scenario', version: 1 } }]);
    else await pool.query('UPDATE sessions SET status=$2 WHERE id=$1', [sessionId, status]);
    for (const value of [scene(), save(), reveal()]) expect((await command(value)).statusCode).toBe(409);
  });
  it('creates and edits a full NPC profile while preserving source memories and relationships', async () => {
    await submit(); const original = snapshot.npcDetails[0]!;
    await ok(save()); const created = snapshot.npcDetails.at(-1)!;
    expect(created.id).not.toBe(original.id); expect(created.knowledge).toEqual([]); expect(created.relationships).toEqual([]); expect(created.version).toBe(1);
    expect(snapshot.submissions[0]!.status).toBe('cancelled');
    await ok(save({ npcId: original.id, expectedNpcVersion: original.version, profile: { ...profile(), displayName: 'Revised', hiddenIdentity: 'Private identity', secrets: ['Private secret'] } }));
    const edited = snapshot.npcDetails.find(npc => npc.id === original.id)!;
    expect(edited).toMatchObject({ id: original.id, knowledge: original.knowledge, relationships: original.relationships, version: original.version + 1, hiddenIdentity: 'Private identity' });
    expect((await command(save({ npcId: original.id, expectedNpcVersion: original.version }))).statusCode).toBe(409);
    const stageState = JSON.stringify((await request(`/api/sessions/${sessionId}`, stage)).json());
    expect(stageState).not.toContain('Private identity'); expect(stageState).not.toContain('Private secret');
  });
  it('reveals authored public text with one real event and physically present witness memories', async () => {
    await submit(); const original = snapshot.npcDetails[0]!;
    const result = await ok(reveal());
    const events = (await pool.query('SELECT id,data FROM audit_events WHERE command_id=$1', [result.json().commandId])).rows;
    expect(events).toHaveLength(1);
    const fact = snapshot.facts.at(-1)!; expect(fact.text).toBe('Mara admits knowing the former owner.');
    const stored = (await pool.query('SELECT data FROM facts WHERE id=$1', [fact.id])).rows[0].data;
    expect(stored.sourceEventId).toBe(events[0].id);
    const npc = snapshot.npcDetails[0]!; expect(npc.version).toBe(original.version + 1); expect(npc.secrets).toEqual(original.secrets); expect(npc.displayName).toBe(original.displayName);
    expect(npc.knowledge.at(-1)).toMatchObject({ statement: fact.text, category: 'fact', acquisition: 'witnessed', sourceEventId: events[0].id, sourceEntityId: original.id });
    expect(snapshot.submissions[0]!.status).toBe('cancelled');
    expect(JSON.stringify((await request(`/api/sessions/${sessionId}`, stage)).json())).not.toContain(original.secrets[0]!);
  });
  it('rejects offstage and channel-only witnesses and blank private sources', async () => {
    const original = snapshot.npcDetails[0]!;
    await ok(save({ npcId: original.id, expectedNpcVersion: original.version, profile: { ...profile(), status: 'offstage', communicationChannel: 'Radio', hiddenIdentity: '  ', secrets: ['  '] } }));
    expect((await command(reveal())).statusCode).toBe(409);
    expect((await command(reveal({ source: { kind: 'identity' }, witnessNpcIds: [] }))).statusCode).toBe(409);
    await ok(save({ npcId: original.id, expectedNpcVersion: snapshot.npcDetails[0]!.version, profile: { ...profile(), secrets: ['Actual private secret'] } }));
    expect((await command(reveal())).statusCode).toBe(409);
    await ok(reveal({ witnessNpcIds: [] }));
  });
  it('never supplies private catalog entries, secrets, or hidden identities to a provider', async () => {
    await ok(scene()); await submit();
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    await ok({ type: 'plan_beat', beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, submissionIds: snapshot.submissions.filter(item => item.status === 'queued').map(item => item.id) });
    expect(context).toBeTruthy(); expect(context!.state.locations).toEqual([]);
    const here = snapshot.locations.find(location => location.id === snapshot.session.scene.locationId)!;
    expect(context!.place).toBe(here.title);
    expect(JSON.stringify(context)).not.toContain('Private catalog detail');
    for (const npc of context!.state.npcs) { expect(npc.secrets).toEqual([]); expect(npc.hiddenIdentity).toBeNull(); }
  });
  it('reconstructs legacy catalog only from current scene and distinct NPC locations', async () => {
    await pool.query("UPDATE sessions SET locations='[]'::jsonb WHERE id=$1", [sessionId]); await refresh();
    expect(new Set(snapshot.locations.map(location => location.id))).toEqual(new Set([snapshot.session.scene.locationId, ...snapshot.npcDetails.map(npc => npc.locationId)]));
    await ok(scene({ location: { kind: 'existing', locationId: snapshot.session.scene.locationId } }));
    expect(snapshot.locations.length).toBeGreaterThan(0);
  });
  it('commits exactly one of two different commands using the same state revision', async () => {
    const before = snapshot;
    const responses = await Promise.all([command(scene()), command(save())]);
    expect(responses.map(result => result.statusCode).sort()).toEqual([200, 409]);
    await refresh(); expect(snapshot.session.stateRevision).toBe(before.session.stateRevision + 1);
    expect(snapshot.session.inputEpoch).toBe(before.session.inputEpoch + 1);
  });
  it('recovers a maximum-length legacy scene without copying its private description into the catalog', async () => {
    const legacyScene = { ...snapshot.session.scene, title: ' ', description: 'x'.repeat(6000) };
    await pool.query("UPDATE sessions SET locations='[]'::jsonb,scene=$2 WHERE id=$1", [sessionId, legacyScene]);
    const response = await request(`/api/sessions/${sessionId}`); expect(response.statusCode, response.body).toBe(200);
    snapshot = response.json(); expect(snapshot.session.scene).toEqual(legacyScene);
    expect(snapshot.locations.find(location => location.id === legacyScene.locationId)).toMatchObject({ title: 'Current location', description: '' });
  });
  it('rejects malformed commands and leaves queued input untouched', async () => {
    await submit(); const before = snapshot;
    for (const value of [scene({ discardQueuedInput: false }), scene({ reason: ' ' }), scene({ presentNpcIds: [snapshot.npcs[0]!.id, snapshot.npcs[0]!.id] }), save({ profile: { ...profile(), knowledge: [] } }), reveal({ witnessNpcIds: [snapshot.npcs[0]!.id, snapshot.npcs[0]!.id] })]) {
      expect((await command(value)).statusCode).toBe(400); await refresh(); expect(snapshot).toEqual(before);
    }
  });
  it('requires current location or an explicit communication channel for submissions and rendered dialogue', async () => {
    const npc = { ...snapshot.npcDetails[0]!, locationId: 'elsewhere', status: 'present' };
    await pool.query('UPDATE npcs SET data=$2 WHERE id=$1', [npc.id, npc]);
    const line = { type: 'save_submission', expectedSubmissionRevision: 0, contextBeatId: null, expectedInputEpoch: snapshot.session.inputEpoch, kind: 'say', text: 'Hello', recipientNpcIds: [npc.id] };
    expect((await command(line, player)).statusCode).toBe(409);
    npc.communicationChannel = 'Radio'; await pool.query('UPDATE npcs SET data=$2 WHERE id=$1', [npc.id, npc]);
    expect((await command(line, player)).statusCode).toBe(200); await refresh();
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    await ok({ type: 'plan_beat', beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, submissionIds: snapshot.submissions.filter(item => item.status === 'queued').map(item => item.id) });
    await ok({ type: 'approve_stakes', beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, classification: 'ordinary', contracts: [] });
    await ok({ type: 'lock_beat', beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision });
    npc.communicationChannel = null; await pool.query('UPDATE npcs SET data=$2 WHERE id=$1', [npc.id, npc]);
    const rendered = { type: 'edit_script', beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, segments: [{ kind: 'npc_dialogue', speakerNpcId: npc.id, text: 'Hello', recipientCharacterIds: [], delivery: 'neutral' }] };
    expect((await command(rendered)).statusCode).toBe(409);
  });

  it('allows an identity reveal without silently changing the public name and versions each witness once', async () => {
    const target = snapshot.npcDetails[0]!;
    await ok(save({ npcId: target.id, expectedNpcVersion: target.version, profile: { ...profile(), hiddenIdentity: 'A private hidden identity' } }));
    await ok(save({ profile: { ...profile(), displayName: 'Witness', status: 'present', locationId: snapshot.session.scene.locationId } }));
    const witness = snapshot.npcDetails.at(-1)!;
    const before = snapshot;
    await ok(reveal({ source: { kind: 'identity' }, publicText: 'Mara discloses her former occupation.', witnessNpcIds: [target.id, witness.id] }));
    for (const id of [target.id, witness.id]) {
      const previous = before.npcDetails.find(npc => npc.id === id)!; const next = snapshot.npcDetails.find(npc => npc.id === id)!;
      expect(next.version).toBe(previous.version + 1); expect(next.knowledge.length).toBe(previous.knowledge.length + 1);
      expect(next.displayName).toBe(previous.displayName);
    }
    expect(snapshot.npcDetails[0]!.hiddenIdentity).toBe('A private hidden identity');
  });
  it('enforces live NPC and location bounds while allowing edits at the limit', async () => {
    const template = snapshot.npcDetails[0]!;
    for (let count = snapshot.npcDetails.length; count < 50; count++) {
      const id = crypto.randomUUID(); await pool.query('INSERT INTO npcs(id,session_id,data,ordinal) VALUES($1,$2,$3,$4)', [id, sessionId, { ...template, id, status: 'offstage' }, count]);
    }
    const catalog = Array.from({ length: 100 }, (_, index) => ({ id: index === 0 ? snapshot.session.scene.locationId : crypto.randomUUID(), title: `Location ${index}`, description: '' }));
    await pool.query('UPDATE sessions SET locations=$2 WHERE id=$1', [sessionId, JSON.stringify(catalog)]); await refresh();
    expect((await command(save())).statusCode).toBe(409); expect((await command(scene())).statusCode).toBe(409);
    await ok(save({ npcId: template.id, expectedNpcVersion: template.version }));
    await ok(scene({ location: { kind: 'existing', locationId: catalog[1]!.id } }));
    expect(snapshot.locations).toHaveLength(100); expect(snapshot.npcDetails).toHaveLength(50);
    expect((await command(save({ npcId: template.id, expectedNpcVersion: snapshot.npcDetails[0]!.version, profile: { ...profile(), status: 'present', locationId: catalog[0]!.id } }))).statusCode).toBe(409);
  });

});
