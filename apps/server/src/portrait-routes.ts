import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  BuilderPortraitRequestSchema, LibraryPortraitRequestSchema, PORTRAIT_SIZE, SeatPortraitRequestSchema,
  type PortraitDetails,
} from '@rpg/contracts';
import { transaction } from './database';
import { AppError, authorize, type Actor } from './repository';
import { createSeatGuard, STALE_BEFORE } from './seat-generation';
import { builderSession, requireEditable } from './character-builder';
import { readImageFile } from './image-files';
import { PICTURE_MESSAGES } from './picture-limits';
import { namesInState, portraitPrompt } from './picture-prompts';
import { effectivePictureSettings, pictureSettingsOf } from './picture-settings';
import { imageVisibleTo, type ImageRow, type PictureEngine } from './picture-views';

interface PortraitRouteOptions {
  pool: Pool;
  authenticate(request: FastifyRequest, client?: PoolClient): Promise<Actor>;
  images: PictureEngine;
  assetDir: string;
}
type SessionParams = { Params: { sessionId: string } };
type ImageParams = { Params: { imageId: string } };
type SessionImageParams = { Params: { sessionId: string; imageId: string } };

const STALE_AFTER = 'Your card changed while the portrait was being made. Load the latest card, then try again.';
const NEEDS_LOOK = 'Describe how this character looks first, then press Create portrait.';
const NEEDS_LOOK_OR_ROLE = 'Give this character an appearance or a role first.';
const NOT_FOUND = 'Picture was not found.';

const pictureNotFound = () => new AppError(404, 'not_found', NOT_FOUND);
const picturesOff = () => new AppError(503, 'pictures_off', PICTURE_MESSAGES.off);
const isImageId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
// Something to draw is a non-blank appearance or role; pronouns and the name alone are not enough.
const hasSomethingToDraw = (details: PortraitDetails) => details.appearance.trim() !== '' || details.role.trim() !== '';

async function readyImage(client: PoolClient, imageId: string, extra = '', values: unknown[] = []) {
  if (!isImageId(imageId)) throw pictureNotFound();
  const result = await client.query<ImageRow>(`SELECT * FROM images WHERE id=$1 AND status='ready' ${extra}`, [imageId, ...values]);
  return result.rows[0] ?? null;
}

async function sendImage(reply: FastifyReply, assetDir: string, row: ImageRow | null) {
  if (!row?.file_hash || !row.content_type) throw pictureNotFound();
  let bytes: Buffer;
  try { bytes = await readImageFile(assetDir, { file_hash: row.file_hash, content_type: row.content_type }); }
  catch { throw pictureNotFound(); }
  return reply.type(row.content_type).send(bytes);
}

export function registerPortraitRoutes(app: FastifyInstance, options: PortraitRouteOptions) {
  const { pool, images, assetDir } = options;
  const { player, guard } = createSeatGuard(options.authenticate);
  const host = async (request: FastifyRequest) => {
    const actor = await options.authenticate(request);
    if (actor.role !== 'host') throw new AppError(403, 'forbidden', 'Only the host can manage reusable templates.');
    return actor;
  };
  // A reservation that cannot be made without a limit error is a plain failure sentence for the card.
  const reserved = (imageId: string | null) => {
    if (!imageId) throw new AppError(502, 'picture_failed', PICTURE_MESSAGES.cardFailed);
    return imageId;
  };

  app.get<SessionImageParams>('/api/sessions/:sessionId/images/:imageId', async (request, reply) => {
    const actor = await options.authenticate(request);
    const { sessionId, imageId } = request.params;
    const row = await transaction(pool, async (client) => {
      const session = await authorize(client, sessionId, actor);
      const image = await readyImage(client, imageId);
      if (!image || !await imageVisibleTo(client, actor, sessionId, session.owner_id as string, image)) throw pictureNotFound();
      return image;
    });
    return sendImage(reply, assetDir, row);
  });

  app.post<SessionParams>('/api/sessions/:sessionId/character/portrait', async (request) => {
    await player(request);
    if (!images.enabled) throw picturesOff();
    const body = SeatPortraitRequestSchema.parse(request.body);
    const sessionId = request.params.sessionId;
    const { actor, imageId } = await transaction(pool, async (client) => {
      const { actor, ownerId, state } = await guard(client, request, body.expectedCharacterRevision, STALE_BEFORE);
      if (!hasSomethingToDraw(body.details)) throw new AppError(400, 'invalid_input', NEEDS_LOOK);
      const characterId = actor.character_id!;
      const settings = await pictureSettingsOf(client, state, images.defaultModel!);
      const prompt = portraitPrompt(body.details, { style: settings.style, names: [...namesInState(state), body.details.name] });
      const imageId = reserved(await images.reserve(client, {
        ownerId, sessionId, builderId: null, purpose: 'character', subjectId: characterId, limitKey: `seat:${sessionId}:${characterId}`,
        attach: false, prompt, model: settings.model, ...PORTRAIT_SIZE, requestedBy: { actor_id: actor.actor_id, producer_grant_id: actor.producer_grant_id ?? null },
      }, 'request'));
      return { actor, imageId };
    });
    await images.generateNow(imageId);
    await transaction(pool, client => guard(client, request, body.expectedCharacterRevision, STALE_AFTER, actor));
    return { imageId };
  });

  app.post('/api/character-builder/portrait', async (request) => {
    const { body, imageId } = await transaction(pool, async (client) => {
      const { row } = await builderSession(client, request);
      if (!images.enabled) throw picturesOff();
      const body = BuilderPortraitRequestSchema.parse(request.body);
      requireEditable(row, body.expectedRevision);
      if (!hasSomethingToDraw(body.details)) throw new AppError(400, 'invalid_input', NEEDS_LOOK);
      const prompt = portraitPrompt(body.details, { style: effectivePictureSettings(null, undefined, images.defaultModel!).style, names: [body.details.name] });
      const imageId = reserved(await images.reserve(client, {
        ownerId: row.owner_id, sessionId: null, builderId: row.id, purpose: 'card', subjectId: row.id, limitKey: `builder:${row.id}`,
        attach: false, prompt, ...PORTRAIT_SIZE, requestedBy: { actor_id: `builder:${row.id}` },
      }, 'request'));
      return { body, imageId };
    });
    await images.generateNow(imageId);
    await transaction(pool, async (client) => requireEditable((await builderSession(client, request)).row, body.expectedRevision));
    return { imageId };
  });

  app.get<ImageParams>('/api/character-builder/images/:imageId', async (request, reply) => {
    const row = await transaction(pool, async (client) => {
      const { row: builder } = await builderSession(client, request);
      const image = await readyImage(client, request.params.imageId, 'AND builder_id=$2', [builder.id]);
      if (!image) throw pictureNotFound();
      return image;
    });
    return sendImage(reply, assetDir, row);
  });

  app.post('/api/library/portraits', async (request) => {
    const actor = await host(request);
    if (!images.enabled) throw picturesOff();
    const body = LibraryPortraitRequestSchema.parse(request.body);
    if (!hasSomethingToDraw(body.details)) throw new AppError(400, 'invalid_input', body.subject === 'npc' ? NEEDS_LOOK_OR_ROLE : NEEDS_LOOK);
    const settings = body.subject === 'npc'
      ? effectivePictureSettings({ style: body.pictureStyle, model: body.pictureModel ?? null }, undefined, images.defaultModel!)
      : effectivePictureSettings(null, undefined, images.defaultModel!);
    const prompt = portraitPrompt(body.details, { style: settings.style, names: [body.details.name] });
    const imageId = await transaction(pool, async (client) => reserved(await images.reserve(client, {
      ownerId: actor.actor_id, sessionId: null, builderId: null, purpose: body.subject, subjectId: body.subjectKey,
      limitKey: `library:${actor.actor_id}:${body.subjectKey}`, attach: false, prompt, model: settings.model, ...PORTRAIT_SIZE,
      requestedBy: { actor_id: actor.actor_id, producer_grant_id: actor.producer_grant_id ?? null },
    }, 'request')));
    await images.generateNow(imageId);
    return { imageId };
  });

  app.get<ImageParams>('/api/library/images/:imageId', async (request, reply) => {
    const actor = await host(request);
    const row = await transaction(pool, client => readyImage(client, request.params.imageId, 'AND owner_id=$2', [actor.actor_id]));
    return sendImage(reply, assetDir, row);
  });
}
