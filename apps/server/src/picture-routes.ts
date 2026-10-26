import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { PICTURE_MODELS, PictureSettingsSchema } from '@rpg/contracts';
import { transaction } from './database';
import { AppError, authorize, conflict, readState, type Actor } from './repository';
import { recordEvent } from './commands';
import { PICTURE_MESSAGES } from './picture-limits';
import { pictureSettingsOf, savePictureSettings } from './picture-settings';
import { lastBeatInScene, type PictureEngine } from './picture-views';

export interface PictureRouteOptions {
  pool: Pool;
  authenticate(request: FastifyRequest, client?: PoolClient): Promise<Actor>;
  images: PictureEngine;
}
type SessionParams = { Params: { sessionId: string } };
type NpcParams = { Params: { sessionId: string; npcId: string } };

const SCENE_ONLY = 'Only the director can change scene pictures.';
const SETTINGS_ONLY = 'Only the director can change picture settings.';
const NPC_ONLY = 'Only the director can change portraits of non-player characters.';
const NPC_MISSING = 'That character is not in this session.';
const NPC_NOTHING_TO_DRAW = 'Give this character an appearance or a role first.';
const NPC_MAKING = 'A portrait for this character is already being made. Wait for it to finish.';
const MODEL_UNKNOWN = 'Choose a picture model from the list.';

export function registerPictureRoutes(app: FastifyInstance, options: PictureRouteOptions) {
  const { pool, authenticate, images } = options;
  const noBody = (request: FastifyRequest) => z.strictObject({}).parse(request.body ?? {});
  // Role and switch checks come first, so a player or a server with pictures off is turned away before any database work.
  const director = async (request: FastifyRequest, forbidden: string) => {
    const actor = await authenticate(request);
    if (actor.role !== 'host') throw new AppError(403, 'forbidden', forbidden);
    if (!images.enabled) throw new AppError(503, 'pictures_off', PICTURE_MESSAGES.off);
    return actor;
  };
  // The session row is locked before anything is reserved; the credential is read again under the lock.
  const locked = async (client: PoolClient, request: FastifyRequest, sessionId: string, original: Actor, forbidden: string) => {
    const actor = await authenticate(request, client);
    if (actor.actor_id !== original.actor_id || actor.role !== original.role) throw new AppError(401, 'unauthorized', 'Sign in again before continuing.');
    if (actor.role !== 'host') throw new AppError(403, 'forbidden', forbidden);
    await authorize(client, sessionId, actor);
    await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [sessionId]);
    return actor;
  };

  app.post<SessionParams>('/api/sessions/:sessionId/scene-picture', async (request, reply) => {
    noBody(request);
    const original = await director(request, SCENE_ONLY);
    const { sessionId } = request.params;
    const imageId = await transaction(pool, async (client) => {
      const actor = await locked(client, request, sessionId, original, SCENE_ONLY);
      const state = await readState(client, sessionId);
      if (state.session.status === 'ended') conflict('This session has ended.');
      if (!['live', 'paused'].includes(state.session.status) || (state.setup && !state.setup.started)) conflict('Start the show before you make a new picture.');
      const sceneId = state.session.scene.id;
      await images.startOver(client, sessionId, sceneId);
      const id = await images.reserveScene(client, state, actor, 'request');
      if (!id) throw new AppError(502, 'picture_failed', PICTURE_MESSAGES.sceneFailed);
      await recordEvent(client, sessionId, actor, randomUUID(), 'picture.making', state.session.stateRevision, { imageId: id, purpose: 'scene', subjectId: sceneId });
      return id;
    });
    images.run([imageId]);
    return reply.code(202).send({ imageId });
  });

  app.post<SessionParams>('/api/sessions/:sessionId/beat-picture', async (request, reply) => {
    noBody(request);
    const original = await director(request, SCENE_ONLY);
    const { sessionId } = request.params;
    const imageId = await transaction(pool, async (client) => {
      const actor = await locked(client, request, sessionId, original, SCENE_ONLY);
      const state = await readState(client, sessionId);
      if (state.session.status === 'ended') conflict('This session has ended.');
      if (!['live', 'paused'].includes(state.session.status) || (state.setup && !state.setup.started)) conflict('Start the show before you make a new picture.');
      const beatId = await lastBeatInScene(client, sessionId);
      if (!beatId) return conflict('No beat has been published in this scene yet.');
      const sceneId = state.session.scene.id;
      await images.startOver(client, sessionId, sceneId);
      const id = await images.reserveBeatPicture(client, state, beatId, actor);
      if (!id) throw new AppError(502, 'picture_failed', PICTURE_MESSAGES.beatFailed);
      await recordEvent(client, sessionId, actor, randomUUID(), 'picture.making', state.session.stateRevision, { imageId: id, purpose: 'scene', subjectId: sceneId });
      return id;
    });
    images.run([imageId]);
    return reply.code(202).send({ imageId });
  });

  app.post<SessionParams>('/api/sessions/:sessionId/picture-settings', async (request) => {
    const original = await director(request, SETTINGS_ONLY);
    const body = PictureSettingsSchema.parse(request.body);
    const { sessionId } = request.params;
    return transaction(pool, async (client) => {
      const actor = await locked(client, request, sessionId, original, SETTINGS_ONLY);
      const state = await readState(client, sessionId);
      if (state.session.status === 'ended') conflict('This session has ended.');
      if (body.model !== images.defaultModel && !PICTURE_MODELS.some(entry => entry.id === body.model)) throw new AppError(400, 'invalid_input', MODEL_UNKNOWN);
      await savePictureSettings(client, sessionId, body);
      await recordEvent(client, sessionId, actor, randomUUID(), 'picture.settings_saved', state.session.stateRevision, { model: body.model });
      return pictureSettingsOf(client, state, images.defaultModel!);
    });
  });

  for (const hidden of [true, false]) {
    app.post<SessionParams>(`/api/sessions/:sessionId/scene-picture/${hidden ? 'hide' : 'show'}`, async (request) => {
      noBody(request);
      const original = await director(request, SCENE_ONLY);
      const { sessionId } = request.params;
      await transaction(pool, async (client) => {
        const actor = await locked(client, request, sessionId, original, SCENE_ONLY);
        const session = (await client.query('SELECT scene, version FROM sessions WHERE id=$1', [sessionId])).rows[0];
        const sceneId = session.scene.id as string;
        // Hide works while a picture is being made; show always works, so a hidden scene can be put back even if its picture failed.
        if (hidden) {
          const drawn = await client.query("SELECT 1 FROM images WHERE session_id=$1 AND purpose='scene' AND subject_id=$2 AND status IN ('making','ready') LIMIT 1", [sessionId, sceneId]);
          if (!drawn.rowCount) conflict('There is no picture for this scene yet.');
        }
        const changed = await client.query("UPDATE images SET hidden=$3 WHERE session_id=$1 AND purpose='scene' AND subject_id=$2", [sessionId, sceneId, hidden]);
        if (!changed.rowCount) conflict('There is no picture for this scene yet.');
        await recordEvent(client, sessionId, actor, randomUUID(), hidden ? 'picture.hidden' : 'picture.shown', session.version, { sceneId, hidden });
      });
      return { ok: true };
    });
  }

  app.post<NpcParams>('/api/sessions/:sessionId/npcs/:npcId/portrait', async (request, reply) => {
    noBody(request);
    const original = await director(request, NPC_ONLY);
    const { sessionId, npcId } = request.params;
    const imageId = await transaction(pool, async (client) => {
      const actor = await locked(client, request, sessionId, original, NPC_ONLY);
      const state = await readState(client, sessionId);
      if (state.session.status === 'ended') conflict('This session has ended.');
      const npc = state.npcs.find(item => item.id === npcId);
      if (!npc) throw new AppError(404, 'not_found', NPC_MISSING);
      if (!npc.appearance.trim() && !npc.role.trim()) throw new AppError(400, 'invalid_input', NPC_NOTHING_TO_DRAW);
      const making = await client.query("SELECT 1 FROM images WHERE session_id=$1 AND purpose='npc' AND subject_id=$2 AND attach AND status='making' LIMIT 1", [sessionId, npcId]);
      if (making.rowCount) throw new AppError(409, 'picture_making', NPC_MAKING);
      const id = await images.reserveNpcPortrait(client, state, npcId, actor, 'request');
      if (!id) throw new AppError(502, 'picture_failed', PICTURE_MESSAGES.npcFailed);
      await recordEvent(client, sessionId, actor, randomUUID(), 'portrait.making', state.session.stateRevision, { imageId: id, purpose: 'npc', subjectId: npcId });
      return id;
    });
    images.run([imageId]);
    return reply.code(202).send({ imageId });
  });

  app.post<NpcParams>('/api/sessions/:sessionId/npcs/:npcId/portrait/remove', async (request) => {
    noBody(request);
    const original = await director(request, NPC_ONLY);
    const { sessionId, npcId } = request.params;
    await transaction(pool, async (client) => {
      const actor = await locked(client, request, sessionId, original, NPC_ONLY);
      const session = (await client.query('SELECT version FROM sessions WHERE id=$1', [sessionId])).rows[0];
      const npc = await client.query("SELECT data->>'portraitId' AS portrait_id FROM npcs WHERE session_id=$1 AND id=$2", [sessionId, npcId]);
      if (!npc.rowCount) throw new AppError(404, 'not_found', NPC_MISSING);
      await client.query("UPDATE npcs SET data = data - 'portraitId' WHERE session_id=$1 AND id=$2", [sessionId, npcId]);
      await client.query("UPDATE images SET attach=false WHERE session_id=$1 AND purpose='npc' AND subject_id=$2 AND status='making'", [sessionId, npcId]);
      await recordEvent(client, sessionId, actor, randomUUID(), 'portrait.removed', session.version, { imageId: npc.rows[0].portrait_id ?? null, purpose: 'npc', subjectId: npcId });
    });
    return { ok: true };
  });
}
