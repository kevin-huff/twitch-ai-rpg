import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  CharacterCardDefinitionSchema, CharacterSchema, NpcSchema, ScenarioDefinitionSchema, SessionStateSchema, SaveCharacterTemplateSchema, SaveScenarioSchema,
  type CharacterCardDefinition, type ScenarioDefinition, type SeatChoice, type SessionState, type TemplateRef,
} from '@rpg/contracts';
import { createLedgerState } from '@rpg/test-fixtures';
import { transaction } from './database';
import { AppError, conflict, type Actor } from './repository';
import { applyCard, digest } from './commands';
import { scenarioPictureSettings } from './picture-settings';

type LibraryKind = 'scenarios' | 'characters';
export interface VersionedDefinition<T> { id: string; version: number; definition: T }
interface LibraryOptions { pool: Pool; authenticate(request: FastifyRequest): Promise<Actor>; picturesEnabled?: boolean }

export function starterDefinitions(): { scenario: ScenarioDefinition; characters: CharacterCardDefinition[] } {
  let sequence = 0;
  const fixture = createLedgerState('ledger-template', () => `ledger-${++sequence}`);
  const scene = fixture.session.scene;
  const corridorId = fixture.npcs.find((npc) => npc.displayName === 'Biscuit')!.locationId;
  const scenario = ScenarioDefinitionSchema.parse({
    schemaVersion: 1, title: fixture.session.title,
    premise: 'Recover a missing club owner’s ledger before a buyer arrives.', genre: 'Comedy heist', tone: 'Dry humor, intrigue, and consequences the cast can see coming.',
    boundaries: ['No permanent player-character death.', 'Players decide their own character’s words, choices, and feelings.'],
    locations: [
      { id: scene.locationId, title: 'Public bar', description: scene.description },
      { id: corridorId, title: 'Service corridor', description: 'A narrow passage links the bar to the club’s offices.' },
      { id: 'ledger-archive', title: 'Archive office', description: 'A locked office holds the club’s records.' },
    ],
    openingScene: scene,
    npcs: fixture.npcs.map(({ version: _version, knowledge, relationships, ...npc }) => ({
      ...npc, knowledge: knowledge.map(({ statement, category }) => ({ statement, category })),
      partyRelationship: relationships.find((relationship) => relationship.targetCharacterId === null)
        ? { stance: relationships[0]!.stance, reason: relationships[0]!.reason } : null,
    })),
    tracks: fixture.tracks, facts: fixture.facts.map(({ id, text, visibility }) => ({ id, text, visibility })),
    playerHooks: ['Each character has a reason to investigate the missing owner.'],
    objectives: ['Find the ledger and learn what happened to the owner.'],
    discoveries: ['The club’s accounts may explain the owner’s disappearance.'],
    opportunities: ['Earn Mara’s trust.', 'Distract Inspector Dax.', 'Find a route into the archive.'],
    directorNotes: fixture.directorNotes, rulesVersion: '0.1', pacing: { conversationWords: 90, actionWords: 120 }, extensions: {},
  });
  const characters = fixture.characters.map((character) => CharacterCardDefinitionSchema.parse({
    schemaVersion: 1, displayName: character.displayName, pronouns: '', appearance: character.appearance,
    personality: '', backstory: '', traits: character.traits, specialty: character.specialty,
    flaw: character.flaw, possessions: character.possessions, connection: character.connection, secret: character.secret, extensions: {},
  }));
  return { scenario, characters };
}

export async function ownedVersion<T extends ScenarioDefinition | CharacterCardDefinition>(client: PoolClient, ownerId: string, kind: LibraryKind, ref: TemplateRef): Promise<VersionedDefinition<T>> {
  const result = await client.query('SELECT t.id,v.version,v.definition FROM library_templates t JOIN library_versions v ON v.template_id=t.id WHERE t.owner_id=$1 AND t.kind=$2 AND t.id=$3 AND v.version=$4', [ownerId, kind, ref.templateId, ref.version]);
  if (!result.rowCount) throw new AppError(404, 'not_found', 'That owned template version was not found.');
  const row = result.rows[0];
  const definition = kind === 'scenarios' ? ScenarioDefinitionSchema.parse(row.definition) : CharacterCardDefinitionSchema.parse(row.definition);
  return { id: row.id, version: row.version, definition: definition as T };
}


export async function materializeSession(client: PoolClient, ownerId: string, sessionId: string, scenarioRef: TemplateRef, seats: SeatChoice[]) {
  const scenario = (await ownedVersion<ScenarioDefinition>(client, ownerId, 'scenarios', scenarioRef)).definition;
  const definitions: (CharacterCardDefinition | null)[] = [];
  const characterRefs: (TemplateRef | null)[] = [];
  for (const seat of seats) {
    if ('templateId' in seat) {
      definitions.push((await ownedVersion<CharacterCardDefinition>(client, ownerId, 'characters', seat)).definition);
      characterRefs.push(seat);
    } else {
      definitions.push(null);
      characterRefs.push(null);
    }
  }
  const ids = new Map<string, string>();
  const remap = (id: string) => {
    if (!ids.has(id)) ids.set(id, randomUUID());
    return ids.get(id)!;
  };
  for (const entity of [scenario.openingScene, ...scenario.locations, ...scenario.npcs, ...scenario.tracks, ...scenario.facts]) remap(entity.id);
  const sourceEventId = `seed:${sessionId}`;
  const state: SessionState = SessionStateSchema.parse({
    schemaVersion: 1, rulesVersion: scenario.rulesVersion,
    session: {
      id: sessionId, title: scenario.title, status: 'lobby', mode: 'conversation', stateRevision: 0, beatNumber: 0, actionRoundNumber: 0, inputEpoch: 0,
      scene: { ...scenario.openingScene, id: remap(scenario.openingScene.id), locationId: remap(scenario.openingScene.locationId) },
      brief: { premise: scenario.premise, genre: scenario.genre, tone: scenario.tone, objectives: scenario.objectives, playerHooks: scenario.playerHooks, pacing: scenario.pacing, ...(scenario.pictureStyle ? { pictureStyle: scenario.pictureStyle } : {}) },
    },
    characters: definitions.map((definition, index) => {
      const character = CharacterSchema.parse({ id: randomUUID(), displayName: `Seat ${index + 1}`, traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, strain: 0, approved: false, draft: null, templateRef: characterRefs[index] });
      if (definition) applyCard(character, definition, 'host');
      return character;
    }),
    locations: scenario.locations.map(location => ({ ...location, id: remap(location.id) })),
    npcs: scenario.npcs.map(({ knowledge, partyRelationship, ...npc }) => NpcSchema.parse({
      ...npc, id: remap(npc.id), locationId: remap(npc.locationId),
      knowledge: knowledge.map((item) => ({ ...item, id: randomUUID(), acquisition: 'scenario', sourceEventId, sourceEntityId: null, learnedBeatNumber: 0 })),
      relationships: partyRelationship ? [{ ...partyRelationship, targetCharacterId: null, sourceEventId }] : [],
    })),
    tracks: scenario.tracks.map((track) => ({ ...track, id: remap(track.id), completionEffects: track.completionEffects.map((effect) => {
      const incident = effect.incidentId ? { incidentId: remap(`incident:${effect.incidentId}`) } : {};
      if (effect.kind === 'track_delta') return { ...effect, trackId: remap(effect.trackId), ...incident };
      if (effect.kind === 'fact_add') return { ...effect, factId: remap(effect.factId), ...incident };
      throw new AppError(400, 'invalid_input', 'Reusable scenario effects cannot target player seats.');
    }) })),
    facts: scenario.facts.map((fact) => ({ ...fact, id: remap(fact.id), sourceEventId })),
    directorNotes: scenario.directorNotes,
    setup: { boundaries: scenario.boundaries, boundariesRevision: 1, started: false, scenario: scenarioRef },
  });
  return {
    state,
    scenarioSnapshot: { ref: scenarioRef, definition: scenario },
    characterSnapshots: definitions.map((definition, index) => ({ ref: characterRefs[index], definition })),
    pictureSettings: scenarioPictureSettings(scenario),
  };
}

export function registerLibrary(app: FastifyInstance, options: LibraryOptions) {
  const host = async (request: FastifyRequest) => {
    const actor = await options.authenticate(request);
    if (actor.role !== 'host') throw new AppError(403, 'forbidden', 'Only the host can manage reusable templates.');
    return actor;
  };
  app.get('/api/library/starter', async (request) => { await host(request); return starterDefinitions(); });
  app.get('/api/library', async (request) => {
    const actor = await host(request);
    const result = await options.pool.query('SELECT t.id,t.kind,v.version,v.definition FROM library_templates t JOIN library_versions v ON v.template_id=t.id AND v.version=t.current_version WHERE t.owner_id=$1 ORDER BY t.created_at,t.id', [actor.actor_id]);
    return {
      scenarios: result.rows.filter((row) => row.kind === 'scenarios').map(({ id, version, definition }) => ({ id, version, definition: ScenarioDefinitionSchema.parse(definition) })),
      characters: result.rows.filter((row) => row.kind === 'characters').map(({ id, version, definition }) => ({ id, version, definition: CharacterCardDefinitionSchema.parse(definition) })),
      ...(options.picturesEnabled ? { picturesEnabled: true } : {}),
    };
  });
  app.get<{ Params: { kind: string; templateId: string; version: string } }>('/api/library/:kind/:templateId/versions/:version', async (request) => {
    const actor = await host(request);
    const kind = z.enum(['scenarios', 'characters']).parse(request.params.kind);
    const version = z.coerce.number().int().positive().parse(request.params.version);
    return transaction(options.pool, (client) => ownedVersion(client, actor.actor_id, kind, { templateId: request.params.templateId, version }));
  });
  for (const kind of ['scenarios', 'characters'] as const) {
    app.post(`/api/library/${kind}`, async (request) => {
      const actor = await host(request);
      const command = kind === 'scenarios' ? SaveScenarioSchema.parse(request.body) : SaveCharacterTemplateSchema.parse(request.body);
      const requestHash = digest({ operation: 'library.save', kind, command });
      return transaction(options.pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [actor.actor_id]);
        const previous = (await client.query('SELECT request_hash,response FROM command_receipts WHERE actor_id=$1 AND command_id=$2', [actor.actor_id, command.commandId])).rows[0];
        if (previous) {
          if (previous.request_hash !== requestHash) conflict('This command ID was already used for a different operation.');
          return previous.response;
        }
        let id = command.templateId;
        let version = 1;
        if (id) {
          const template = (await client.query('SELECT current_version FROM library_templates WHERE id=$1 AND owner_id=$2 AND kind=$3 FOR UPDATE', [id, actor.actor_id, kind])).rows[0];
          if (!template) throw new AppError(404, 'not_found', 'That owned template was not found.');
          if (template.current_version !== command.expectedVersion) conflict('The template changed. Load the latest version before saving.');
          version = template.current_version + 1;
          await client.query('UPDATE library_templates SET current_version=$2 WHERE id=$1', [id, version]);
        } else {
          if (command.expectedVersion !== 0) conflict('A new template starts at version zero.');
          id = randomUUID();
          await client.query('INSERT INTO library_templates(id,owner_id,kind,current_version) VALUES($1,$2,$3,$4)', [id, actor.actor_id, kind, version]);
        }
        await client.query('INSERT INTO library_versions(template_id,version,definition) VALUES($1,$2,$3)', [id, version, command.definition]);
        const response = { id, version, definition: command.definition };
        await client.query('INSERT INTO command_receipts(actor_id,command_id,request_hash,response) VALUES($1,$2,$3,$4)', [actor.actor_id, command.commandId, requestHash, response]);
        return response;
      });
    });
  }
}
