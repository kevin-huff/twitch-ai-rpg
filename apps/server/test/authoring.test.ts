import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createPool, migrate } from '../src/database';
import { AppError } from '../src/repository';
import { registerLibrary } from '../src/library';
import { buildApp } from '../src/app';
import type { CharacterCardDefinition, DirectorSnapshot, PlayerSnapshot, ScenarioDefinition, TemplateRef } from '@rpg/contracts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite('immutable owned scenario and character libraries', () => {
  let app: FastifyInstance;
  let pool: ReturnType<typeof createPool>;
  const owner = crypto.randomUUID();
  const otherOwner = crypto.randomUUID();
  let starter: { scenario: Record<string, any>; characters: Array<Record<string, any>> };
  const request = (url: string, payload?: Record<string, unknown>, actor = owner, role = 'host') => app.inject({ method: payload ? 'POST' : 'GET', url, headers: { 'x-test-owner': actor, 'x-test-role': role }, ...(payload ? { payload } : {}) });
  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    await migrate(pool);
    app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) return reply.code(error.status).send({ code: error.code });
      if (error instanceof z.ZodError) return reply.code(400).send({ code: 'invalid_input' });
      return reply.code(500).send({ code: 'unexpected_failure' });
    });
    registerLibrary(app, { pool, authenticate: async (request) => ({ actor_id: String(request.headers['x-test-owner']), role: request.headers['x-test-role'] === 'player' ? 'player' : 'host', session_id: null, character_id: null }) });
    const response = await request('/api/library/starter');
    expect(response.statusCode, response.body).toBe(200);
    starter = response.json();
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  it('provides native starter definitions with template-local references and no session ownership', () => {
    expect(starter.scenario.schemaVersion).toBe(1);
    expect(starter.scenario.title).toBe('The Ledger Job');
    expect(starter.scenario.npcs.find((npc: { displayName: string }) => npc.displayName === 'Mara Vale').knowledge[0]).toEqual({ statement: 'The club owner is missing. The ledger may explain why.', category: 'fact' });
    expect(starter.characters).toHaveLength(4);
    expect(starter.characters[0]).not.toHaveProperty('id');
    expect(starter.characters[0]).not.toHaveProperty('approved');
    expect(starter.scenario.npcs[0]).not.toHaveProperty('version');
  });

  it('appends immutable versions, returns idempotent results, and rejects stale edits or changed command payloads', async () => {
    const initial = { commandId: crypto.randomUUID(), expectedVersion: 0, definition: starter.scenario };
    const created = await request('/api/library/scenarios', initial);
    expect(created.statusCode, created.body).toBe(200);
    const first = created.json();
    expect(first.version).toBe(1);
    expect(first.definition).toEqual(starter.scenario);
    expect((await request('/api/library/scenarios', initial)).json()).toEqual(first);
    const edited = { ...starter.scenario, title: 'A Different Ledger Job' };
    const next = await request('/api/library/scenarios', { commandId: crypto.randomUUID(), templateId: first.id, expectedVersion: 1, definition: edited });
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json()).toEqual({ id: first.id, version: 2, definition: edited });
    expect((await request(`/api/library/scenarios/${first.id}/versions/1`)).json()).toEqual(first);
    expect((await request('/api/library/scenarios', { commandId: crypto.randomUUID(), templateId: first.id, expectedVersion: 1, definition: edited })).statusCode).toBe(409);
    expect((await request('/api/library/scenarios', { ...initial, definition: edited })).statusCode).toBe(409);
    const library = (await request('/api/library')).json();
    expect(library.scenarios.find((template: { id: string }) => template.id === first.id).version).toBe(2);
  });

  it('scopes listing, exact-version reads, and edits to the owning host', async () => {
    const created = (await request('/api/library/characters', { commandId: crypto.randomUUID(), expectedVersion: 0, definition: starter.characters[0] })).json();
    expect((await request('/api/library', undefined, otherOwner)).json()).toEqual({ scenarios: [], characters: [] });
    expect((await request(`/api/library/characters/${created.id}/versions/1`, undefined, otherOwner)).statusCode).toBe(404);
    expect((await request('/api/library/characters', { commandId: crypto.randomUUID(), templateId: created.id, expectedVersion: 1, definition: starter.characters[0] }, otherOwner)).statusCode).toBe(404);
    expect((await request('/api/library', undefined, owner, 'player')).statusCode).toBe(403);
    expect((await request('/api/library/starter', undefined, owner, 'player')).statusCode).toBe(403);
    expect((await request('/api/library/characters', { commandId: crypto.randomUUID(), expectedVersion: 0, definition: starter.characters[0] }, owner, 'player')).statusCode).toBe(403);
  });

  it('serializes concurrent version updates and scopes idempotency hashes to the operation kind', async () => {
    const created = (await request('/api/library/characters', { commandId: crypto.randomUUID(), expectedVersion: 0, definition: starter.characters[0] })).json();
    const updates = await Promise.all(['one', 'two'].map((suffix) => request('/api/library/characters', { commandId: crypto.randomUUID(), templateId: created.id, expectedVersion: 1, definition: { ...starter.characters[0], displayName: `Rook ${suffix}` } })));
    expect(updates.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const commandId = crypto.randomUUID();
    expect((await request('/api/library/scenarios', { commandId, expectedVersion: 0, definition: starter.scenario })).statusCode).toBe(200);
    expect((await request('/api/library/characters', { commandId, expectedVersion: 0, definition: starter.characters[0] })).statusCode).toBe(409);
  });

  it('validates native character and scenario imports without fetching or executing extension data', async () => {
    const invalidTraits = { ...starter.characters[0], traits: { force: 2, finesse: 2, wits: 2, presence: 2 } };
    expect((await request('/api/library/characters', { commandId: crypto.randomUUID(), expectedVersion: 0, definition: invalidTraits })).statusCode).toBe(400);
    expect((await request('/api/library/characters', { commandId: crypto.randomUUID(), expectedVersion: 0, definition: { ...starter.characters[0], approved: true } })).statusCode).toBe(400);
    expect((await request('/api/library/scenarios', { commandId: crypto.randomUUID(), expectedVersion: 0, definition: { ...starter.scenario, schemaVersion: 99 } })).statusCode).toBe(400);
    const safeText = { ...starter.characters[0], backstory: '<script>window.pwned=true</script> https://example.invalid/private', extensions: {} };
    const saved = await request('/api/library/characters', { commandId: crypto.randomUUID(), expectedVersion: 0, definition: safeText });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().definition.backstory).toBe(safeText.backstory);
  });
});


suite('custom session casting and approval', () => {
  const origin = 'http://localhost:3000';
  const hostToken = 'authoring-session-host-credential';
  let app: Awaited<ReturnType<typeof buildApp>>;
  let host: string;
  let players: string[];
  let stage: string;
  let sessionId: string;
  let state: DirectorSnapshot;
  let starter: { scenario: ScenarioDefinition; characters: CharacterCardDefinition[] };
  let scenarioRef: TemplateRef;
  let characterRefs: TemplateRef[];
  const request = (url: string, payload?: Record<string, unknown>, credential = host) => app.inject({ method: payload ? 'POST' : 'GET', url, headers: { origin, cookie: credential }, ...(payload ? { payload } : {}) });
  const cookie = (headers: Record<string, unknown>) => String(headers['set-cookie']).split(';')[0]!;
  async function refresh() {
    const response = await request(`/api/sessions/${sessionId}`);
    expect(response.statusCode, response.body).toBe(200);
    state = response.json();
    return state;
  }
  async function command(payload: Record<string, unknown>, credential = host) {
    return request(`/api/sessions/${sessionId}/commands`, { commandId: crypto.randomUUID(), ...payload }, credential);
  }
  async function succeed(payload: Record<string, unknown>, credential = host) {
    const response = await command(payload, credential);
    expect(response.statusCode, response.body).toBe(200);
    await refresh();
    return response.json().snapshot as DirectorSnapshot | PlayerSnapshot;
  }
  async function approveAll() {
    for (const character of [...state.characterDetails]) await succeed({ type: 'approve_character', characterId: character.id, expectedCharacterRevision: character.cardRevision });
  }
  async function ready(index: number) {
    const own = (await request(`/api/sessions/${sessionId}`, undefined, players[index]!)).json() as PlayerSnapshot;
    return succeed({ type: 'set_ready', expectedCharacterRevision: own.ownCharacter!.cardRevision, expectedBoundariesRevision: own.setup!.boundariesRevision, ready: true }, players[index]);
  }
  beforeEach(async () => {
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    host = cookie((await request('/api/auth/host', { token: hostToken }, '')).headers);
    const response = await request('/api/library/starter');
    expect(response.statusCode, response.body).toBe(200);
    starter = response.json();
    const countdown = starter.scenario.tracks.find((track) => track.kind === 'countdown')!;
    countdown.completionEffects = [{ kind: 'track_delta', trackId: starter.scenario.tracks.find((track) => track.kind === 'danger')!.id, delta: 1 }, { kind: 'fact_add', factId: 'buyer-arrived', text: 'The buyer has arrived.', visibility: 'public' }];
    const scenario = (await request('/api/library/scenarios', { commandId: crypto.randomUUID(), expectedVersion: 0, definition: starter.scenario })).json();
    scenarioRef = { templateId: scenario.id, version: scenario.version };
    characterRefs = [];
    for (const definition of starter.characters.slice(0, 2)) {
      const saved = (await request('/api/library/characters', { commandId: crypto.randomUUID(), expectedVersion: 0, definition })).json();
      characterRefs.push({ templateId: saved.id, version: saved.version });
    }
    const creation = await request('/api/sessions', { commandId: crypto.randomUUID(), scenario: scenarioRef, characters: characterRefs });
    expect(creation.statusCode, creation.body).toBe(200);
    sessionId = creation.json().sessionId;
    players = [];
    for (const invite of creation.json().invites) {
      const credential = cookie((await request('/api/auth/redeem', { token: invite.token }, '')).headers);
      if (invite.role === 'player') players.push(credential); else stage = credential;
    }
    await refresh();
  });
  afterEach(async () => { await app?.close(); });

  it('creates two or six seats and remaps template identifiers and effect targets into independent sessions', async () => {
    expect(players).toHaveLength(2);
    expect(state.characterDetails).toHaveLength(2);
    expect(state.setup).toMatchObject({ started: false, scenario: scenarioRef, boundaries: starter.scenario.boundaries });
    expect(state.session.brief!.premise).toBe(starter.scenario.premise);
    const importedIds = [starter.scenario.openingScene.id, ...starter.scenario.locations.map((location) => location.id), ...starter.scenario.npcs.map((npc) => npc.id), ...starter.scenario.tracks.map((track) => track.id), ...starter.scenario.facts.map((fact) => fact.id), 'buyer-arrived'];
    for (const entity of [...state.npcs, ...state.tracks, ...state.facts, state.session.scene]) expect(importedIds).not.toContain(entity.id);
    expect(importedIds).not.toContain(state.session.scene.locationId);
    const six = await request('/api/sessions', { commandId: crypto.randomUUID(), scenario: scenarioRef, characters: Array.from({ length: 6 }, (_, index) => characterRefs[index % 2]) });
    expect(six.statusCode, six.body).toBe(200);
    expect(six.json().invites.filter((invite: { role: string }) => invite.role === 'player')).toHaveLength(6);
    const other = (await request(`/api/sessions/${six.json().sessionId}`)).json() as DirectorSnapshot;
    expect(other.characterDetails).toHaveLength(6);
    const ids = new Set([...state.npcs, ...state.tracks, ...state.facts, ...state.characters].map((entity) => entity.id));
    expect([...other.npcs, ...other.tracks, ...other.facts, ...other.characters].every((entity) => !ids.has(entity.id))).toBe(true);
    const pool = createPool(databaseUrl!);
    try {
      const tracks = (await pool.query('SELECT data FROM tracks WHERE session_id=$1', [sessionId])).rows.map((row) => row.data);
      const effects = tracks.find((track) => track.kind === 'countdown').completionEffects;
      expect(effects[0].trackId).toBe(tracks.find((track) => track.kind === 'danger').id);
      expect(importedIds).not.toContain(effects[1].factId);
    } finally { await pool.end(); }
  });

  it('keeps unapproved and edited card bodies private until exact-version director approval', async () => {
    expect(state.characterDetails[0]!.displayName).toBe('Seat 1');
    expect(state.characterDetails[0]!.draft!.displayName).toBe(starter.characters[0]!.displayName);
    const publicBefore = (await request(`/api/sessions/${sessionId}`, undefined, stage)).json();
    expect(publicBefore.characters).toEqual([]);
    expect(publicBefore).not.toHaveProperty('setup');
    expect(JSON.stringify(publicBefore)).not.toContain(starter.characters[0]!.secret);
    const card = { ...starter.characters[0]!, displayName: 'Private draft name', secret: 'only-the-owner-and-director-see-this', backstory: '<script>not executed</script>' };
    const saved = await succeed({ type: 'save_character', expectedCharacterRevision: 0, card }, players[0]);
    expect(saved.role).toBe('player');
    expect(state.characterDetails[0]!.displayName).toBe('Seat 1');
    expect(state.characterDetails[0]!.approved).toBe(false);
    expect(state.session.stateRevision).toBe(0);
    const other = (await request(`/api/sessions/${sessionId}`, undefined, players[1]!)).json();
    expect(JSON.stringify(other)).not.toContain(card.displayName);
    expect(JSON.stringify(other)).not.toContain(card.secret);
    expect((await command({ type: 'save_character', expectedCharacterRevision: 1, card: { ...card, approved: true } }, players[0])).statusCode).toBe(400);
    expect((await command({ type: 'approve_character', characterId: state.characterDetails[0]!.id, expectedCharacterRevision: 0 })).statusCode).toBe(409);
    await succeed({ type: 'approve_character', characterId: state.characterDetails[0]!.id, expectedCharacterRevision: 1 });
    expect(state.characterDetails[0]).toMatchObject({ displayName: card.displayName, secret: card.secret, approved: true, draft: null, cardRevision: 2 });
    const publicAfter = (await request(`/api/sessions/${sessionId}`, undefined, stage)).json();
    expect(publicAfter.characters[0].displayName).toBe(card.displayName);
    expect(JSON.stringify(publicAfter)).not.toContain(card.secret);
  });

  it('allows independent seat edits while rejecting ownership and stale revision changes', async () => {
    const saved = await Promise.all(players.map((credential, index) => command({ type: 'save_character', expectedCharacterRevision: 0, card: { ...starter.characters[index]!, displayName: `Draft ${index}` } }, credential)));
    expect(saved.map((response) => response.statusCode)).toEqual([200, 200]);
    await refresh();
    expect(state.characterDetails.map((character) => character.cardRevision)).toEqual([1, 1]);
    expect(state.session.stateRevision).toBe(0);
    expect((await command({ type: 'save_character', expectedCharacterRevision: 0, card: starter.characters[0] }, players[0])).statusCode).toBe(409);
    expect((await command({ type: 'save_character', expectedCharacterRevision: 1, characterId: state.characterDetails[1]!.id, card: starter.characters[0] }, players[0])).statusCode).toBe(400);
    expect((await command({ type: 'approve_character', characterId: state.characterDetails[1]!.id, expectedCharacterRevision: 1 }, players[0])).statusCode).toBe(403);
  });

  it('requires approval and current boundary acknowledgement, and invalidates readiness when boundaries change', async () => {
    expect((await command({ type: 'start_session', expectedStateRevision: 0, overrideUnreadyReason: 'An absent player is holding.' })).statusCode).toBe(409);
    expect((await command({ type: 'set_ready', expectedCharacterRevision: 0, expectedBoundariesRevision: state.setup!.boundariesRevision, ready: true }, players[0])).statusCode).toBe(409);
    await approveAll(); await ready(0); await ready(1);
    const previousBoundaryRevision = state.setup!.boundariesRevision;
    await succeed({ type: 'set_boundaries', expectedStateRevision: state.session.stateRevision, boundaries: ['No permanent death.', 'Pause whenever a player asks.'] });
    expect(state.setup!.boundariesRevision).toBe(previousBoundaryRevision + 1);
    expect(state.characterDetails.every((character) => !character.ready && character.acceptedBoundariesRevision === null)).toBe(true);
    expect((await command({ type: 'set_ready', expectedCharacterRevision: state.characterDetails[0]!.cardRevision, expectedBoundariesRevision: previousBoundaryRevision, ready: true }, players[0])).statusCode).toBe(409);
    expect((await command({ type: 'start_session', expectedStateRevision: state.session.stateRevision })).statusCode).toBe(409);
    await ready(0); await ready(1);
    await succeed({ type: 'start_session', expectedStateRevision: state.session.stateRevision });
    expect(state.setup!.started).toBe(true); expect(state.session.status).toBe('live');
  });

  it('blocks gameplay and status bypasses before start while allowing out-of-character pause requests', async () => {
    expect((await command({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: state.session.inputEpoch })).statusCode).toBe(409);
    expect((await command({ type: 'set_status', status: 'live', expectedStateRevision: state.session.stateRevision })).statusCode).toBe(409);
    const paused = await command({ type: 'set_status', status: 'paused', expectedStateRevision: state.session.stateRevision });
    if (paused.statusCode === 200) await refresh();
    expect((await command({ type: 'set_status', status: 'live', expectedStateRevision: state.session.stateRevision })).statusCode).toBe(409);
    expect((await command({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: state.session.inputEpoch, contextBeatId: null, kind: 'say', text: 'Bypass the lobby.' }, players[0])).statusCode).toBe(409);
    await succeed({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: state.session.inputEpoch, contextBeatId: null, kind: 'ooc', text: 'Pause requested.' }, players[0]);
    expect(state.setup!.started).toBe(false);
  });

  it('audits an explicit missing-seat override and lets that seat acknowledge boundaries before joining play', async () => {
    await approveAll(); await ready(0);
    const absentId = state.characterDetails[1]!.id;
    const reason = 'The second player will arrive after the introduction.';
    await succeed({ type: 'start_session', expectedStateRevision: state.session.stateRevision, overrideUnreadyReason: reason });
    const speech = { type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: state.session.inputEpoch, contextBeatId: null, kind: 'say', text: 'I have arrived.' };
    expect((await command(speech, players[1])).statusCode).toBe(409);
    await ready(1);
    await succeed(speech, players[1]);
    const pool = createPool(databaseUrl!);
    try {
      const audit = (await pool.query("SELECT data FROM audit_events WHERE session_id=$1 AND kind='start_session'", [sessionId])).rows[0].data;
      expect(audit.overrideUnreadyReason).toBe(reason);
      expect(audit.unreadyCharacterIds).toEqual([absentId]);
    } finally { await pool.end(); }
  });

  it('pins selected definitions through later template edits and a process restart', async () => {
    const original = structuredClone(state);
    expect((await request('/api/library/scenarios', { commandId: crypto.randomUUID(), templateId: scenarioRef.templateId, expectedVersion: 1, definition: { ...starter.scenario, title: 'Edited future package', npcs: starter.scenario.npcs.map((npc) => ({ ...npc, secrets: ['Changed future secret'] })) } })).statusCode).toBe(200);
    await app.close();
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false });
    await refresh();
    expect(state.setup).toEqual(original.setup);
    expect(state.npcDetails).toEqual(original.npcDetails);
    expect(state.characterDetails).toEqual(original.characterDetails);
    const pool = createPool(databaseUrl!);
    try {
      const snapshots = (await pool.query('SELECT scenario_snapshot,character_snapshots FROM sessions WHERE id=$1', [sessionId])).rows[0];
      expect(snapshots.scenario_snapshot).toEqual({ ref: scenarioRef, definition: starter.scenario });
      expect(snapshots.character_snapshots.map((item: { ref: TemplateRef }) => item.ref)).toEqual(characterRefs);
    } finally { await pool.end(); }
  });

  it('rejects character and boundary edits after starting even when the table is paused', async () => {
    await approveAll(); await ready(0); await ready(1);
    await succeed({ type: 'start_session', expectedStateRevision: state.session.stateRevision });
    await succeed({ type: 'set_status', status: 'paused', expectedStateRevision: state.session.stateRevision });
    expect((await command({ type: 'save_character', expectedCharacterRevision: state.characterDetails[0]!.cardRevision, card: starter.characters[0] }, players[0])).statusCode).toBe(409);
    expect((await command({ type: 'approve_character', characterId: state.characterDetails[0]!.id, expectedCharacterRevision: state.characterDetails[0]!.cardRevision })).statusCode).toBe(409);
    expect((await command({ type: 'set_boundaries', expectedStateRevision: state.session.stateRevision, boundaries: [] })).statusCode).toBe(409);
    await refresh(); expect(state.setup!.started).toBe(true);
  });
});
