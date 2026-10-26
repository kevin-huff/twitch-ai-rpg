import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  CardGenerationInputSchema, FieldGenerationRequestSchema, MAX_FIELD_GENERATION_REQUEST_BYTES,
  SeatCardGenerationRequestSchema, SeatFieldGenerationRequestSchema, allowsPremise, type AiProvider,
} from '@rpg/contracts';
import { transaction } from './database';
import { AppError, authorize, conflict, readState, type Actor } from './repository';
import { executeFieldGeneration } from './field-generation';
import { executeCardGeneration } from './card-generation';

interface SeatGenerationOptions {
  pool: Pool;
  authenticate(request: FastifyRequest, client?: PoolClient): Promise<Actor>;
  provider: AiProvider;
  timeoutMs?: number;
}
type Params = { Params: { sessionId: string } };

export const STALE_BEFORE = 'Your card changed. Load the latest card, then try again.';
const STALE_AFTER = 'Your card changed while the AI was writing. Load the latest card, then try again.';

export function createSeatGuard(authenticate: SeatGenerationOptions['authenticate']) {
  const player = async (request: FastifyRequest, client?: PoolClient) => {
    const actor = await authenticate(request, client);
    if (actor.role !== 'player') throw new AppError(403, 'forbidden', 'Use your own player seat to write a card.');
    return actor;
  };
  const guard = async (client: PoolClient, request: FastifyRequest<Params>, expectedRevision: number, staleMessage: string, original?: Actor) => {
    const actor = await player(request, client);
    if (original && (actor.actor_id !== original.actor_id || actor.character_id !== original.character_id)) {
      throw new AppError(401, 'unauthorized', 'Sign in again before continuing.');
    }
    const sessionId = request.params.sessionId;
    const session = await authorize(client, sessionId, actor);
    const state = await readState(client, sessionId);
    if (!state.setup) conflict('This session uses the original rehearsal cast rather than an editable lobby.');
    if (state.setup!.started || state.session.status !== 'lobby') conflict('Cards can only change before the show starts.');
    const character = state.characters.find(item => item.id === actor.character_id);
    if (!character) throw new AppError(404, 'not_found', 'That character is not assigned to this session.');
    if (character.cardRevision !== expectedRevision) conflict(staleMessage);
    return {
      actor, premise: state.session.brief?.premise.trim() ?? '', ownerId: session.owner_id as string,
      state,
    };
  };
  return { player, guard };
}

export function registerSeatGeneration(app: FastifyInstance, options: SeatGenerationOptions) {
  const { player, guard } = createSeatGuard(options.authenticate);

  app.post<Params>('/api/sessions/:sessionId/character/generate-card', { bodyLimit: MAX_FIELD_GENERATION_REQUEST_BYTES }, async (request) => {
    await player(request);
    const body = SeatCardGenerationRequestSchema.parse(request.body);
    const { actor, input } = await transaction(options.pool, async (client) => {
      const { actor, premise } = await guard(client, request, body.expectedCharacterRevision, STALE_BEFORE);
      return {
        actor,
        input: CardGenerationInputSchema.parse({ prompt: body.prompt, keepFilled: body.keepFilled, current: body.current, ...(premise ? { premise } : {}) }),
      };
    });
    const output = await executeCardGeneration(options.provider, input, options.timeoutMs);
    await transaction(options.pool, client => guard(client, request, body.expectedCharacterRevision, STALE_AFTER, actor));
    return output;
  });

  app.post<Params>('/api/sessions/:sessionId/character/generate-field', { bodyLimit: MAX_FIELD_GENERATION_REQUEST_BYTES }, async (request) => {
    await player(request);
    const body = SeatFieldGenerationRequestSchema.parse(request.body);
    const { actor, input } = await transaction(options.pool, async (client) => {
      const { actor, premise } = await guard(client, request, body.expectedCharacterRevision, STALE_BEFORE);
      const sendPremise = body.usePremise && allowsPremise(body.field) && premise !== '';
      return {
        actor,
        input: FieldGenerationRequestSchema.parse({ field: body.field, seed: body.seed, characterContext: body.characterContext, ...(sendPremise ? { premise } : {}) }),
      };
    });
    const output = await executeFieldGeneration(options.provider, input, options.timeoutMs);
    await transaction(options.pool, client => guard(client, request, body.expectedCharacterRevision, STALE_AFTER, actor));
    return output;
  });
}
