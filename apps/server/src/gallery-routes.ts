import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { GalleryActionSchema, type GalleryAction, type GalleryStatus } from '@rpg/contracts';
import { transaction } from './database';
import { AppError, authorize, type Actor } from './repository';
import type { GalleryWork } from './gallery-model';
import { galleryMissingPage } from './gallery-html';

export const GALLERY_CSP = "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const PICTURE_PATH = /^\/gallery\/[A-Za-z0-9_-]{43}\/p\/[^/]+$/;

export function galleryCacheControl(path: string, statusCode: number): string {
  if (![200, 206, 304].includes(statusCode)) return 'no-store';
  if (PICTURE_PATH.test(path)) return 'public, max-age=31536000, immutable';
  if (path === '/gallery/gallery.css' || path === '/gallery/viewer.js') return 'public, max-age=300';
  return 'public, max-age=60';
}

export interface GalleryRouteService {
  status(client: PoolClient, sessionId: string, sessionStatus: string): Promise<GalleryStatus>;
  apply(client: PoolClient, actor: Actor, sessionId: string, action: GalleryAction['action']): Promise<GalleryWork>;
  afterCommit(sessionId: string, work: GalleryWork): Promise<void>;
}

export interface GalleryRouteOptions {
  pool: Pool;
  authenticate(request: FastifyRequest, client?: PoolClient): Promise<Actor>;
  gallery: GalleryRouteService;
  assetDir: string;
}

const DIRECTOR_ONLY = 'Only the director can change the gallery.';

export async function registerGalleryRoutes(app: FastifyInstance, options: GalleryRouteOptions): Promise<void> {
  const { pool, authenticate, gallery, assetDir } = options;

  app.post<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/gallery', async (request) => {
    const { action } = GalleryActionSchema.parse(request.body);
    const original = await authenticate(request);
    if (original.role !== 'host') throw new AppError(403, 'forbidden', DIRECTOR_ONLY);
    const { sessionId } = request.params;
    const work = await transaction(pool, async (client) => {
      const actor = await authenticate(request, client);
      if (actor.actor_id !== original.actor_id || actor.role !== original.role) throw new AppError(401, 'unauthorized', 'Sign in again before continuing.');
      if (actor.role !== 'host') throw new AppError(403, 'forbidden', DIRECTOR_ONLY);
      await authorize(client, sessionId, actor);
      await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [sessionId]);
      return gallery.apply(client, actor, sessionId, action);
    });
    await gallery.afterCommit(sessionId, work);
    return transaction(pool, async (client) => {
      const row = await authorize(client, sessionId, original);
      return gallery.status(client, sessionId, row.status as string);
    });
  });

  // Everything public under /gallery lives in this one scope, so its error and not-found answers never reach the app's own handlers.
  await app.register(async (scope) => {
    const missing = (_request: FastifyRequest, reply: FastifyReply) => reply.code(404).type('text/html; charset=utf-8').send(galleryMissingPage());
    // Fastify captures a route's error handler when the route is registered, so this comes before any route.
    scope.setErrorHandler((error, request, reply) => {
      // @fastify/static reports an unsatisfiable Range as a 416 error carrying its Content-Range header; that is not a missing page.
      const failure = error as { statusCode?: number; headers?: Record<string, string> };
      if (failure.statusCode === 416) return reply.code(416).headers(failure.headers ?? {}).send();
      return missing(request, reply);
    });
    scope.setNotFoundHandler(missing);
    scope.addHook('onSend', async (request, reply) => {
      const url = request.raw.url ?? '';
      const pathOnly = url.split('?')[0] ?? '';
      reply.header('Cache-Control', galleryCacheControl(pathOnly, reply.statusCode));
      reply.header('Content-Security-Policy', GALLERY_CSP);
    });
    scope.get('', async (_request, reply) => reply.redirect('/gallery/', 301));
    await scope.register(fastifyStatic, {
      root: path.resolve(assetDir, 'galleries'),
      prefix: '/',
      decorateReply: false,
      index: ['index.html'],
      list: false,
      redirect: true,
      dotfiles: 'deny',
      cacheControl: false,
    });
  }, { prefix: '/gallery' });
}
