import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { PinPictureRequestSchema } from '@rpg/contracts';
import { transaction } from './database';
import { AppError, authorize, conflict, readState, type Actor } from './repository';
import { recordEvent } from './commands';
import { PICTURE_MESSAGES } from './picture-limits';
import { shelfPictures } from './picture-list';
import type { PictureRouteOptions } from './picture-routes';

type SessionParams = { Params: { sessionId: string } };

const LIST_ONLY = 'Only the director can see the picture list.';
const PIN_ONLY = 'Only the director can pin pictures.';
const HELD = 'This picture waits for its beat to be published.';
const NOT_FINISHED = 'Only a finished picture from this show can go on the stream.';
const NOTHING_PINNED = 'No picture is pinned right now.';
const ENDED = 'This session has ended.';

// The director's picture list, and the pin that puts one picture on the stream and the seats until it is released.
export function registerShelfRoutes(app: FastifyInstance, options: PictureRouteOptions) {
  const { pool, authenticate, images } = options;
  const noBody = (request: FastifyRequest) => z.strictObject({}).parse(request.body ?? {});
  // Role and switch checks come first, so a player or a server with pictures off is turned away before any database work.
  const director = async (request: FastifyRequest, forbidden: string) => {
    const actor = await authenticate(request);
    if (actor.role !== 'host') throw new AppError(403, 'forbidden', forbidden);
    if (!images.enabled) throw new AppError(503, 'pictures_off', PICTURE_MESSAGES.off);
    return actor;
  };
  // The session row is locked before anything changes; the credential is read again under the lock.
  const locked = async (client: PoolClient, request: FastifyRequest, sessionId: string, original: Actor, forbidden: string) => {
    const actor = await authenticate(request, client);
    if (actor.actor_id !== original.actor_id || actor.role !== original.role) throw new AppError(401, 'unauthorized', 'Sign in again before continuing.');
    if (actor.role !== 'host') throw new AppError(403, 'forbidden', forbidden);
    await authorize(client, sessionId, actor);
    await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [sessionId]);
    return actor;
  };

  app.get<SessionParams>('/api/sessions/:sessionId/pictures', async (request) => {
    const original = await director(request, LIST_ONLY);
    const { sessionId } = request.params;
    return transaction(pool, async (client) => {
      const actor = await authenticate(request, client);
      if (actor.actor_id !== original.actor_id || actor.role !== original.role) throw new AppError(401, 'unauthorized', 'Sign in again before continuing.');
      if (actor.role !== 'host') throw new AppError(403, 'forbidden', LIST_ONLY);
      await authorize(client, sessionId, actor);
      return shelfPictures(client, sessionId);
    });
  });

  app.post<SessionParams>('/api/sessions/:sessionId/pinned-picture', async (request) => {
    const original = await director(request, PIN_ONLY);
    const body = PinPictureRequestSchema.parse(request.body);
    const { sessionId } = request.params;
    return transaction(pool, async (client) => {
      const actor = await locked(client, request, sessionId, original, PIN_ONLY);
      const state = await readState(client, sessionId);
      if (state.session.status === 'ended') conflict(ENDED);
      const listed = (await shelfPictures(client, sessionId)).pictures.find(picture => picture.imageId === body.imageId);
      if (!listed) return conflict(NOT_FINISHED);
      if (listed.held) return conflict(HELD);
      if (listed.status !== 'ready') return conflict(NOT_FINISHED);
      // The stream shows a beat's picture only once publishing released it (pinnedRow), so a pin must ask the same.
      if (!(await client.query('SELECT 1 FROM images WHERE id=$1 AND NOT (beat_id IS NOT NULL AND released_at IS NULL)', [body.imageId])).rowCount) return conflict(HELD);
      if (listed.pinned) return { ok: true };
      await client.query('UPDATE sessions SET pinned_image_id=$2 WHERE id=$1', [sessionId, body.imageId]);
      await recordEvent(client, sessionId, actor, randomUUID(), 'picture.pinned', state.session.stateRevision, { imageId: body.imageId });
      return { ok: true };
    });
  });

  app.post<SessionParams>('/api/sessions/:sessionId/pinned-picture/release', async (request) => {
    noBody(request);
    const original = await director(request, PIN_ONLY);
    const { sessionId } = request.params;
    return transaction(pool, async (client) => {
      const actor = await locked(client, request, sessionId, original, PIN_ONLY);
      const state = await readState(client, sessionId);
      if (state.session.status === 'ended') conflict(ENDED);
      const pinned = (await client.query<{ pinned_image_id: string | null }>('SELECT pinned_image_id FROM sessions WHERE id=$1', [sessionId])).rows[0]?.pinned_image_id ?? null;
      if (!pinned) conflict(NOTHING_PINNED);
      await client.query('UPDATE sessions SET pinned_image_id=NULL WHERE id=$1', [sessionId]);
      await recordEvent(client, sessionId, actor, randomUUID(), 'picture.unpinned', state.session.stateRevision, { imageId: pinned });
      return { ok: true };
    });
  });
}
