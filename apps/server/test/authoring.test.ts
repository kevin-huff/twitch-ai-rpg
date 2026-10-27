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
  async function producerCredential() {
    const grant = await request('/api/producers', { commandId: crypto.randomUUID(), label: 'Night producer' });
    expect(grant.statusCode, grant.body).toBe(200);
    const signedIn = await app.inject({ method: 'POST', url: '/api/auth/producer', headers: { origin }, payload: { token: grant.json().token } });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    return cookie(signedIn.headers);
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

  it('starts seats that came from saved cards approved, with the card applied and no draft', async () => {
    const seat = state.characterDetails[0]!;
    expect(seat).toMatchObject({ displayName: starter.characters[0]!.displayName, secret: starter.characters[0]!.secret, approved: true, draft: null, cardRevision: 0, cardSource: 'host' });
    expect(state.characterDetails[1]).toMatchObject({ displayName: starter.characters[1]!.displayName, approved: true, draft: null });
    const publicView = (await request(`/api/sessions/${sessionId}`, undefined, stage)).json();
    expect(publicView).not.toHaveProperty('setup');
    expect(JSON.stringify(publicView)).not.toContain(starter.characters[0]!.secret);
  });

  it('applies a player save at once, keeps the secret private and counts one revision on the card and the show', async () => {
    const card = { ...starter.characters[0]!, displayName: 'Private draft name', secret: 'only-the-owner-and-director-see-this', backstory: '<script>not executed</script>' };
    const revision = state.session.stateRevision;
    const saved = await succeed({ type: 'save_character', expectedCharacterRevision: 0, card }, players[0]);
    expect(saved.role).toBe('player');
    expect(state.characterDetails[0]).toMatchObject({ displayName: card.displayName, secret: card.secret, approved: true, draft: null, cardRevision: 1, cardSource: 'player' });
    expect(state.session.stateRevision).toBe(revision + 1);
    const other = (await request(`/api/sessions/${sessionId}`, undefined, players[1]!)).json();
    expect(JSON.stringify(other)).not.toContain(card.secret);
    const publicAfter = (await request(`/api/sessions/${sessionId}`, undefined, stage)).json();
    expect(publicAfter.characters[0].displayName).toBe(card.displayName);
    expect(JSON.stringify(publicAfter)).not.toContain(card.secret);
    expect(JSON.stringify(publicAfter)).not.toContain('cardSource');
    expect((await command({ type: 'save_character', expectedCharacterRevision: 1, card: { ...card, approved: true } }, players[0])).statusCode).toBe(400);
  });

  it('lets a host save a card into any seat with characterId and marks it as the host card', async () => {
    const target = state.characterDetails[1]!;
    const card = { ...starter.characters[1]!, displayName: 'Written by the host' };
    const revision = state.session.stateRevision;
    await succeed({ type: 'save_character', characterId: target.id, expectedCharacterRevision: target.cardRevision, card });
    expect(state.characterDetails[1]).toMatchObject({ displayName: card.displayName, approved: true, draft: null, cardRevision: target.cardRevision + 1, cardSource: 'host' });
    expect(state.session.stateRevision).toBe(revision + 1);
    expect((await command({ type: 'save_character', characterId: target.id, expectedCharacterRevision: target.cardRevision, card })).statusCode).toBe(409);
    expect((await command({ type: 'save_character', characterId: crypto.randomUUID(), expectedCharacterRevision: 0, card })).statusCode).toBe(404);
  });

  it('lets a producer save a card into a seat as the host card', async () => {
    const producer = await producerCredential();
    const target = state.characterDetails[0]!;
    await succeed({ type: 'save_character', characterId: target.id, expectedCharacterRevision: target.cardRevision, card: { ...starter.characters[0]!, displayName: 'Written by a producer' } }, producer);
    expect(state.characterDetails[0]).toMatchObject({ displayName: 'Written by a producer', approved: true, draft: null, cardSource: 'host' });
    const missing = await command({ type: 'save_character', expectedCharacterRevision: 1, card: starter.characters[0] }, producer);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().message).toBe('Choose the seat to write this card into.');
  });

  it('refuses a host save without a seat, stage saves and a player saving into another seat', async () => {
    const withoutSeat = await command({ type: 'save_character', expectedCharacterRevision: 0, card: starter.characters[0] });
    expect(withoutSeat.statusCode).toBe(400);
    expect(withoutSeat.json().code).toBe('invalid_input');
    expect(withoutSeat.json().message).toBe('Choose the seat to write this card into.');
    const other = await command({ type: 'save_character', characterId: state.characterDetails[1]!.id, expectedCharacterRevision: 0, card: starter.characters[0] }, players[0]);
    expect(other.statusCode).toBe(403);
    expect(other.json().message).toBe('Players can only save their own card.');
    const own = await command({ type: 'save_character', characterId: state.characterDetails[0]!.id, expectedCharacterRevision: 0, card: starter.characters[0] }, players[0]);
    expect(own.statusCode, own.body).toBe(200);
    expect((await command({ type: 'save_character', characterId: state.characterDetails[0]!.id, expectedCharacterRevision: 1, card: starter.characters[0] }, stage)).statusCode).toBe(403);
    await refresh();
    expect(state.characterDetails[1]!.cardRevision).toBe(0);
  });

  it('allows independent seat edits while rejecting ownership and stale revision changes', async () => {
    const saved = await Promise.all(players.map((credential, index) => command({ type: 'save_character', expectedCharacterRevision: 0, card: { ...starter.characters[index]!, displayName: `Draft ${index}` } }, credential)));
    expect(saved.map((response) => response.statusCode)).toEqual([200, 200]);
    await refresh();
    expect(state.characterDetails.map((character) => character.cardRevision)).toEqual([1, 1]);
    expect(state.characterDetails.map((character) => character.displayName)).toEqual(['Draft 0', 'Draft 1']);
    expect(state.session.stateRevision).toBe(2);
    expect((await command({ type: 'save_character', expectedCharacterRevision: 0, card: starter.characters[0] }, players[0])).statusCode).toBe(409);
    expect((await command({ type: 'approve_character', characterId: state.characterDetails[1]!.id, expectedCharacterRevision: 1 }, players[0])).statusCode).toBe(403);
  });

  it('keeps approve_character working for a pending draft and refuses it when there is none', async () => {
    const seat = state.characterDetails[0]!;
    expect((await command({ type: 'approve_character', characterId: seat.id, expectedCharacterRevision: seat.cardRevision })).statusCode).toBe(409);
  });

  it('approve_character makes a pending draft the card', async () => {
    const seat = state.characterDetails[0]!;
    const draft = { ...starter.characters[1]!, displayName: 'Pending Draft Name', appearance: 'Drawn from the pending draft.' };
    const pool = createPool(databaseUrl!);
    try {
      await pool.query("UPDATE characters SET data=jsonb_set(data,'{draft}',$2::jsonb) WHERE id=$1", [seat.id, JSON.stringify(draft)]);
    } finally { await pool.end(); }
    await refresh();
    expect(state.characterDetails[0]!.draft).not.toBeNull();
    const response = await command({ type: 'approve_character', characterId: seat.id, expectedCharacterRevision: seat.cardRevision });
    expect(response.statusCode, response.body).toBe(200);
    await refresh();
    expect(state.characterDetails[0]).toMatchObject({ approved: true, draft: null, displayName: 'Pending Draft Name', appearance: 'Drawn from the pending draft.', secret: draft.secret });
  });

  it('sends players an empty boundaries list while the director keeps the saved list, with the same revision', async () => {
    const boundaries = ['No permanent death.', 'Pause whenever a player asks.'];
    await succeed({ type: 'set_boundaries', expectedStateRevision: state.session.stateRevision, boundaries });
    const player = (await request(`/api/sessions/${sessionId}`, undefined, players[0]!)).json() as PlayerSnapshot;
    expect(state.setup!.boundaries).toEqual(boundaries);
    expect(player.setup!.boundaries).toEqual([]);
    expect(player.setup!.boundariesRevision).toBe(state.setup!.boundariesRevision);
    expect(JSON.stringify(player)).not.toContain('No permanent death.');
  });

  it('starts without any readiness once every seat has a card, and set_boundaries leaves readiness and card revisions alone', async () => {
    await ready(0);
    await refresh();
    const before = state.characterDetails.map(({ ready: isReady, acceptedBoundariesRevision, cardRevision }) => ({ isReady, acceptedBoundariesRevision, cardRevision }));
    expect(before[0]!.isReady).toBe(true);
    const previousBoundaryRevision = state.setup!.boundariesRevision;
    await succeed({ type: 'set_boundaries', expectedStateRevision: state.session.stateRevision, boundaries: ['No permanent death.', 'Pause whenever a player asks.'] });
    expect(state.setup!.boundariesRevision).toBe(previousBoundaryRevision + 1);
    expect(state.setup!.boundaries).toEqual(['No permanent death.', 'Pause whenever a player asks.']);
    expect(state.characterDetails.map(({ ready: isReady, acceptedBoundariesRevision, cardRevision }) => ({ isReady, acceptedBoundariesRevision, cardRevision }))).toEqual(before);
    expect(state.characterDetails[1]!.ready).toBe(false);
    await succeed({ type: 'start_session', expectedStateRevision: state.session.stateRevision });
    expect(state.setup!.started).toBe(true); expect(state.session.status).toBe('live');
  });

  it('refuses to start while a seat still has no card', async () => {
    players = await createSeats([{ playerWritten: true }, characterRefs[0]]);
    const refused = await command({ type: 'start_session', expectedStateRevision: state.session.stateRevision, overrideUnreadyReason: 'Start anyway.' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toBe('Every seat needs a card before the show can start.');
    await refresh();
    expect(state.setup!.started).toBe(false);
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

  it('records an optional start note and lets a seat that never marked ready join in-character play', async () => {
    const reason = 'The second player will arrive after the introduction.';
    await succeed({ type: 'start_session', expectedStateRevision: state.session.stateRevision, overrideUnreadyReason: reason });
    expect(state.characterDetails.every((character) => !character.ready && character.acceptedBoundariesRevision === null)).toBe(true);
    await succeed({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: state.session.inputEpoch, contextBeatId: null, kind: 'say', text: 'I have arrived.' }, players[1]);
    const pool = createPool(databaseUrl!);
    try {
      const audit = (await pool.query("SELECT data FROM audit_events WHERE session_id=$1 AND kind='start_session'", [sessionId])).rows[0].data;
      expect(audit.overrideUnreadyReason).toBe(reason);
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

  it('keeps cards fixed after starting, even when the table is paused', async () => {
    await succeed({ type: 'start_session', expectedStateRevision: state.session.stateRevision });
    await succeed({ type: 'set_status', status: 'paused', expectedStateRevision: state.session.stateRevision });
    const target = state.characterDetails[0]!;
    expect((await command({ type: 'save_character', expectedCharacterRevision: target.cardRevision, card: starter.characters[0] }, players[0])).statusCode).toBe(409);
    expect((await command({ type: 'save_character', characterId: target.id, expectedCharacterRevision: target.cardRevision, card: starter.characters[0] })).statusCode).toBe(409);
    expect((await command({ type: 'approve_character', characterId: target.id, expectedCharacterRevision: target.cardRevision })).statusCode).toBe(409);
    expect((await command({ type: 'set_boundaries', expectedStateRevision: state.session.stateRevision, boundaries: [] })).statusCode).toBe(409);
    await refresh(); expect(state.setup!.started).toBe(true);
    expect(state.characterDetails[0]!.cardRevision).toBe(target.cardRevision);
  });

  async function createSeats(seats: unknown[]) {
    const creation = await request('/api/sessions', { commandId: crypto.randomUUID(), scenario: scenarioRef, characters: seats });
    expect(creation.statusCode, creation.body).toBe(200);
    const id = creation.json().sessionId as string;
    const credentials: string[] = [];
    for (const invite of creation.json().invites) {
      if (invite.role !== 'player') continue;
      credentials.push(cookie((await request('/api/auth/redeem', { token: invite.token }, '')).headers));
    }
    sessionId = id;
    await refresh();
    return credentials;
  }

  it('creates an empty seat for a player-written choice that the player writes, which applies at once, before the show starts', async () => {
    players = await createSeats([{ playerWritten: true }, characterRefs[0]]);
    expect(state.characterDetails).toHaveLength(2);
    const seat = state.characterDetails[0]!;
    expect(seat.displayName).toBe('Seat 1');
    expect(seat.draft).toBeNull();
    expect(seat.templateRef).toBeNull();
    expect(seat.approved).toBe(false);
    expect(seat.cardSource).toBeUndefined();
    expect(state.characterDetails[1]!.templateRef).toEqual(characterRefs[0]);
    expect(state.characterDetails[1]).toMatchObject({ approved: true, draft: null, cardSource: 'host' });
    expect((await command({ type: 'approve_character', characterId: seat.id, expectedCharacterRevision: seat.cardRevision })).statusCode).toBe(409);
    expect((await command({ type: 'start_session', expectedStateRevision: state.session.stateRevision })).statusCode).toBe(409);
    await succeed({ type: 'save_character', expectedCharacterRevision: seat.cardRevision, card: { ...starter.characters[0]!, displayName: 'Written at the table' } }, players[0]);
    expect(state.characterDetails[0]).toMatchObject({ displayName: 'Written at the table', approved: true, draft: null, cardSource: 'player' });
    await succeed({ type: 'start_session', expectedStateRevision: state.session.stateRevision });
    expect(state.setup!.started).toBe(true);
  });

  it('lets a show use only player-written seats without any saved cards and stores null snapshots for them', async () => {
    players = await createSeats([{ playerWritten: true }, { playerWritten: true }]);
    expect(players).toHaveLength(2);
    expect(state.characterDetails.every((item) => item.draft === null && item.templateRef === null)).toBe(true);
    const pool = createPool(databaseUrl!);
    try {
      const row = (await pool.query('SELECT character_snapshots FROM sessions WHERE id=$1', [sessionId])).rows[0];
      expect(row.character_snapshots).toEqual([{ ref: null, definition: null }, { ref: null, definition: null }]);
    } finally { await pool.end(); }
  });
});
