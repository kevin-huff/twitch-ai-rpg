import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { Server } from 'socket.io';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { CommandSchema, CreateSessionSchema, type AiProvider, type CreateSessionResponse, type ImageProvider, type Role, type SessionListEntry } from '@rpg/contracts';
import { createLedgerState } from '@rpg/test-fixtures';
import { createPool, migrate, transaction } from './database';
import { AppError, authorize, project, saveState, type Actor } from './repository';
import { digest, executeCommand, recordEvent } from './commands';
import { activeTokenHashes, findActiveActor, type AccessRouteDeps, type CredentialRow } from './credentials';
import { FakeAiProvider } from './fake-provider';
import { materializeSession, registerLibrary } from './library';
import { registerFieldGeneration } from './field-generation';
import { registerSeatGeneration } from './seat-generation';
import { registerScenarioDrafts } from './scenario-drafts';
import { registerCharacterBuilders } from './character-builder';
import { registerProducers } from './producers';
import { registerStreamLinks } from './stream-links';
import { invitationToken as deriveInvitationToken, registerInvites } from './invites';
import { registerAudio, type SpeechEngine } from './audio';
import { registerDraftAudio } from './draft-audio';
import { registerPlayback } from './playback';
import { ImageService, PICTURE_MESSAGES } from './images';
import { registerPictureRoutes } from './picture-routes';
import { registerPortraitRoutes } from './portrait-routes';
import { GalleryService, galleryUrl } from './galleries';
import { registerGalleryRoutes } from './gallery-routes';
import { registerOperations } from './operations';
import { httpCredential, identityCookieName, selectCredential, requestIdentity } from './identity';

export interface AppOptions {
  databaseUrl: string;
  hostToken: string;
  origin: string;
  rollDie?: () => number;
  provider?: AiProvider;
  providerTimeoutMs?: number;
  scenarioTimeoutMs?: number;
  serveStatic?: boolean;
  speech?: SpeechEngine;
  speechModel?: string;
  speechVoiceId?: string;
  speechVoices?: Record<string, string>;
  assetDir?: string;
  images?: ImageProvider;
  imageHourlyLimit?: number;
}
// Picture bytes never change under their id, so a picture response may be cached for good.
const IMAGE_PATH = /^\/api\/(?:sessions\/[^/]+|library|character-builder)\/images\/[0-9a-f-]{36}$/;
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export async function buildApp(options: AppOptions) {
  if (options.hostToken.length < 24) throw new Error('HOST_TOKEN must be at least 24 characters.');
  const pool = createPool(options.databaseUrl);
  await migrate(pool);
  // Restarted workers expose interrupted work as retryable; accepted rolls remain stored.
  await pool.query('UPDATE generation_jobs SET status=\'failed\',error=\'The server restarted. Retry generation or write a manual script.\',finished_at=now() WHERE status=\'running\'');
  await pool.query('UPDATE images SET status=\'failed\',message=CASE WHEN moment IS NOT NULL THEN $4 ELSE CASE purpose WHEN \'scene\' THEN $1 WHEN \'npc\' THEN $2 ELSE $3 END END,finished_at=clock_timestamp() WHERE status=\'making\'', [PICTURE_MESSAGES.sceneFailed, PICTURE_MESSAGES.npcFailed, PICTURE_MESSAGES.cardFailed, PICTURE_MESSAGES.beatFailed]);
  const assetDir = options.assetDir ?? '.local/audio';
  const provider = options.provider ?? new FakeAiProvider();
  // Only a story AI the server was given describes pictures; without one the server describes each beat from its own text.
  const gallery = new GalleryService({ pool, assetDir, origin: options.origin });
  const images = new ImageService({ pool, provider: options.images, assetDir, hourlyLimit: options.imageHourlyLimit, ai: options.provider, onReady: id => { void gallery.refreshIfOn(id); } });
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 });
  await app.register(cookie);
  const authenticate = async (request: FastifyRequest, client?: PoolClient): Promise<Actor> => {
    const credential = httpCredential(request).token;
    const found = credential ? await findActiveActor(client ?? pool, hash(credential)) : null;
    if (!found) throw new AppError(401, 'unauthorized', 'Sign in or redeem an invitation first.');
    return found;
  };
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.status).send({ code: error.code, message: error.message, recoverable: error.status === 409 });
    if (error instanceof z.ZodError) return reply.code(400).send({ code: 'invalid_input', message: 'The request does not match the supported format.', recoverable: false });
    if (error instanceof Error && 'code' in error && String(error.code).match(/^[0-9A-Z]{5}$/)) return reply.code(409).send({ code: 'conflict', message: 'The state changed or a conflicting record exists. Refresh before retrying.', recoverable: true });
    return reply.code(400).send({ code: 'invalid_operation', message: error instanceof Error ? error.message : 'The request could not be completed.', recoverable: false });
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== options.origin) {
      return reply.code(403).send({ code: 'origin_forbidden', message: 'Use the configured application origin.', recoverable: false });
    }
  });
  app.addHook('onSend', async (request, reply) => {
    reply.header('Referrer-Policy', 'no-referrer'); reply.header('X-Content-Type-Options', 'nosniff');
    const immutable = request.url.split('?')[0]!.startsWith('/assets/') && reply.statusCode === 200 && !String(reply.getHeader('content-type') ?? '').startsWith('text/html');
    const picture = reply.statusCode === 200 && IMAGE_PATH.test(request.url.split('?')[0]!);
    reply.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : picture ? 'private, max-age=31536000, immutable' : 'no-store');
  });
  const tokenBody = z.strictObject({ token: z.string().min(1).max(1024), tab: z.literal(true).optional() });
  const persistCredential = async (row: CredentialRow, client: Pick<PoolClient, 'query'> = pool, credentialOptions: { expiresAt?: Date } = {}) => {
    const credential = randomBytes(32).toString('base64url');
    await client.query('INSERT INTO credentials(token_hash,actor_id,role,session_id,character_id,producer_grant_id,stream_link_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,LEAST(now()+interval \'12 hours\',$8::timestamptz))', [hash(credential), row.actor_id, row.role, row.session_id, row.character_id, row.producer_grant_id ?? null, row.stream_link_id ?? null, credentialOptions.expiresAt ?? null]);
    return credential;
  };
  const issueCookie = (credential: string, reply: FastifyReply, identityId?: string, maxAgeSeconds = 12 * 3600) => {
    reply.setCookie(identityCookieName(identityId), credential, { path: '/', httpOnly: true, sameSite: 'strict', secure: options.origin.startsWith('https:'), maxAge: maxAgeSeconds });
  };
  app.post('/api/auth/host', async (request, reply) => {
    const { token, tab } = tokenBody.parse(request.body);
    const identityId = tab ? randomBytes(16).toString('hex') : undefined;
    if (!timingSafeEqual(Buffer.from(hash(token)), Buffer.from(hash(options.hostToken)))) throw new AppError(401, 'unauthorized', 'Host credential was not accepted.');
    issueCookie(await persistCredential({ actor_id: hash(options.hostToken), role: 'host', session_id: null, character_id: null }), reply, identityId);
    return { role: 'host', ...(identityId ? { identityId } : {}) };
  });
  app.post('/api/auth/redeem', async (request, reply) => {
    const { token, tab } = tokenBody.parse(request.body);
    const identityId = tab ? randomBytes(16).toString('hex') : undefined;
    const { actor, credential } = await transaction(pool, async (client) => {
      const result = await client.query('UPDATE invites SET redeemed_at=now() WHERE token_hash=$1 AND expires_at>now() AND redeemed_at IS NULL AND revoked_at IS NULL RETURNING *', [hash(token)]);
      if (!result.rowCount) throw new AppError(401, 'unauthorized', 'This invitation is expired, already redeemed, or invalid.');
      const invite = result.rows[0];
      const actor: Actor = { actor_id: invite.id, role: invite.role, session_id: invite.session_id, character_id: invite.character_id };
      return { actor, credential: await persistCredential(actor, client) };
    });
    issueCookie(credential, reply, identityId);
    return { sessionId: actor.session_id, role: actor.role, characterId: actor.character_id, ...(identityId ? { identityId } : {}) };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const selected = httpCredential(request);
    if (selected.name !== 'rpg_session') await authenticate(request);
    if (selected.token) await pool.query('UPDATE credentials SET revoked_at=now() WHERE token_hash=$1', [hash(selected.token)]);
    reply.clearCookie(selected.name, { path: '/' }); return { ok: true };
  });
  const invitationToken = (invite: { id: string; session_id: string; role: string; character_id: string | null }) => deriveInvitationToken(options.hostToken, invite);
  app.post('/api/sessions', async (request) => {
    const actor = await authenticate(request);
    if (actor.role !== 'host') throw new AppError(403, 'forbidden', 'Only the host can create sessions.');
    const command = CreateSessionSchema.parse(request.body);
    const requestHash = digest(command);
    return transaction(pool, async (client): Promise<CreateSessionResponse> => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [actor.actor_id]);
      const receipt = (await client.query('SELECT request_hash,response FROM command_receipts WHERE actor_id=$1 AND command_id=$2', [actor.actor_id, command.commandId])).rows[0];
      if (receipt && receipt.request_hash !== requestHash) throw new AppError(409, 'conflict', 'This command ID was already used with other input.');
      let sessionId = receipt?.response.sessionId as string | undefined;
      if (!sessionId) {
        sessionId = randomUUID();
        const custom = command.scenario && command.characters ? await materializeSession(client, actor.actor_id, sessionId, command.scenario, command.characters) : null;
        const state = custom?.state ?? createLedgerState(sessionId, randomUUID);
        if (command.title) state.session.title = command.title;
        await client.query('INSERT INTO sessions(id,owner_id,title,scene,status) VALUES($1,$2,$3,$4,$5)', [sessionId, actor.actor_id, state.session.title, state.session.scene, state.session.status]);
        if (custom) await client.query('UPDATE sessions SET scenario_snapshot=$2,character_snapshots=$3,picture_settings=$4 WHERE id=$1', [sessionId, custom.scenarioSnapshot, JSON.stringify(custom.characterSnapshots), JSON.stringify(custom.pictureSettings)]);
        const seedEvent = await recordEvent(client, sessionId, actor.actor_id, command.commandId, 'session.created', 0);
        for (const npc of state.npcs) {
          for (const record of [...npc.knowledge, ...npc.relationships]) record.sourceEventId = seedEvent.eventId;
        }
        for (const fact of state.facts) fact.sourceEventId = seedEvent.eventId;
        await saveState(client, state);
        for (const seat of [...state.characters.map((character) => ({ role: 'player' as const, character_id: character.id })), { role: 'stage' as const, character_id: null }]) {
          const invite = { id: randomUUID(), session_id: sessionId, ...seat };
          await client.query('INSERT INTO invites(id,token_hash,session_id,role,character_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval \'7 days\')', [invite.id, hash(invitationToken(invite)), sessionId, invite.role, invite.character_id]);
        }
        await client.query('INSERT INTO command_receipts(actor_id,command_id,request_hash,session_id,response) VALUES($1,$2,$3,$4,$5)', [actor.actor_id, command.commandId, requestHash, sessionId, { sessionId }]);
      }
      const invites = (await client.query(`SELECT i.* FROM invites i LEFT JOIN characters c ON c.id=i.character_id WHERE i.session_id=$1 AND i.revoked_at IS NULL ORDER BY CASE WHEN i.role='player' THEN 0 ELSE 1 END,c.ordinal,i.id`, [sessionId])).rows.map((invite) => ({ role: invite.role, characterId: invite.character_id, token: invitationToken(invite) }));
      return { sessionId, invites };
    });
  });
  app.post<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/test-seat', async (request, reply) => {
    const owner = await authenticate(request);
    if (owner.role !== 'host') throw new AppError(403, 'forbidden', 'Only the owning host can open a test seat.');
    const { characterId } = z.strictObject({ characterId: z.string().min(1).max(128) }).parse(request.body);
    const sessionId = request.params.sessionId;
    const identityId = randomBytes(16).toString('hex');
    const credential = await transaction(pool, async (client) => {
      const session = await authorize(client, sessionId, owner);
      const character = await client.query('SELECT id FROM characters WHERE id=$1 AND session_id=$2', [characterId, sessionId]);
      if (!character.rowCount) throw new AppError(404, 'not_found', 'That character is not assigned to this session.');
      const credential = await persistCredential({ actor_id: randomUUID(), role: 'player', session_id: sessionId, character_id: characterId, producer_grant_id: owner.producer_grant_id ?? null }, client);
      await recordEvent(client, sessionId, owner.actor_id, randomUUID(), 'seat.test_access_granted', session.version, { characterId });
      return credential;
    });
    issueCookie(credential, reply, identityId);
    return { sessionId, role: 'player', characterId, identityId };
  });
  app.get('/api/sessions', async (request) => {
    const actor = await authenticate(request);
    if (actor.role !== 'host') throw new AppError(403, 'forbidden', 'Only the host can list sessions.');
    const rows = (await pool.query('SELECT s.id,s.title,s.status,g.slug,g.listed FROM sessions s LEFT JOIN galleries g ON g.session_id=s.id WHERE s.owner_id=$1 ORDER BY s.created_at DESC', [actor.actor_id])).rows;
    return rows.map((row): SessionListEntry => ({ id: row.id, title: row.title, status: row.status, gallery: row.slug ? { listed: row.listed, url: galleryUrl(options.origin, row.slug) } : null }));
  });
  app.get<{ Params: { sessionId: string }; Querystring: { view?: Role } }>('/api/sessions/:sessionId', async (request) => {
    const actor = await authenticate(request);
    const view = request.query.view && z.enum(['director', 'player', 'stage']).parse(request.query.view);
    return transaction(pool, (client) => project(client, request.params.sessionId, actor, view, { picturesEnabled: images.enabled, defaultPictureModel: images.defaultModel ?? undefined, gallery }));
  });
  app.post<{ Params: { sessionId: string } }>('/api/sessions/:sessionId/commands', async (request) => executeCommand({ pool, provider, rollDie: options.rollDie ?? (() => randomInt(1, 7)), providerTimeoutMs: options.providerTimeoutMs, authenticate: client => authenticate(request, client), pictures: images.enabled ? images : undefined, picturesEnabled: images.enabled, defaultPictureModel: images.defaultModel ?? undefined, gallery }, request.params.sessionId, await authenticate(request), CommandSchema.parse(request.body)));
  const accessDeps: AccessRouteDeps = { pool, authenticate, hostToken: options.hostToken, origin: options.origin, persistCredential, issueCookie };
  registerLibrary(app, { pool, authenticate, picturesEnabled: images.enabled });
  registerCharacterBuilders(app, { pool, authenticate, hostToken: options.hostToken, origin: options.origin, provider, timeoutMs: options.providerTimeoutMs, picturesEnabled: images.enabled });
  registerProducers(app, accessDeps);
  registerStreamLinks(app, accessDeps);
  registerInvites(app, accessDeps);
  registerFieldGeneration(app, { authenticate, provider, timeoutMs: options.providerTimeoutMs });
  registerSeatGeneration(app, { pool, authenticate, provider, timeoutMs: options.providerTimeoutMs });
  registerScenarioDrafts(app, { authenticate, provider, scenarioTimeoutMs: options.scenarioTimeoutMs });
  registerAudio(app, { pool, authenticate, provider: options.speech, model: options.speechModel ?? '', voiceId: options.speechVoiceId ?? '', voices: options.speechVoices, assetDir });
  registerDraftAudio(app, { pool, authenticate, provider: options.speech, model: options.speechModel ?? '', voiceId: options.speechVoiceId ?? '', voices: options.speechVoices, assetDir });
  registerOperations(app, { pool, authenticate, speechConfigured: Boolean(options.speech), model: options.speechModel ?? '', voiceId: options.speechVoiceId ?? '', voices: options.speechVoices });
  registerPlayback(app, { pool, authenticate });
  registerPictureRoutes(app, { pool, authenticate, images, gallery });
  registerPortraitRoutes(app, { pool, authenticate, images, assetDir });
  if (options.assetDir !== undefined) await gallery.start();
  await registerGalleryRoutes(app, { pool, authenticate, gallery, assetDir });
  for (const path of ['/health', '/health/ready']) app.get(path, async () => { await pool.query('SELECT 1'); return { ok: true }; });

  const io = new Server(app.server, { cors: { origin: options.origin, credentials: true }, maxHttpBufferSize: 1024 });
  io.use(async (socket, next) => {
    try {
      if (socket.handshake.headers.origin && socket.handshake.headers.origin !== options.origin) throw new Error('Origin is not allowed.');
      const identityId = requestIdentity(socket.handshake.url, socket.handshake.headers['x-rpg-identity'], socket.handshake.auth.identityId);
      const { token } = selectCredential(app.parseCookie(socket.handshake.headers.cookie ?? ''), identityId);
      const actor = token ? await findActiveActor(pool, hash(token)) : null;
      if (!actor || typeof socket.handshake.auth.sessionId !== 'string') throw new Error('Authentication is required.');
      await transaction(pool, (client) => authorize(client, socket.handshake.auth.sessionId, actor));
      socket.data.sessionId = socket.handshake.auth.sessionId; socket.data.tokenHash = hash(token!); next();
    } catch { next(new Error('Session access denied.')); }
  });
  io.on('connection', (socket) => { socket.join(socket.data.sessionId); });
  let dispatching = false;
  const dispatch = async () => {
    if (dispatching) return;
    dispatching = true;
    try {
      const connected = [...io.sockets.sockets.values()];
      if (connected.length) {
        const valid = await activeTokenHashes(pool, connected.map((socket) => socket.data.tokenHash));
        for (const socket of connected) if (!valid.has(socket.data.tokenHash)) socket.disconnect(true);
      }
      const events = (await pool.query('SELECT o.event_id,o.session_id,e.sequence FROM outbox o JOIN audit_events e ON e.id=o.event_id WHERE o.dispatched_at IS NULL ORDER BY e.sequence LIMIT 100')).rows;
      for (const event of events) {
        io.to(event.session_id).emit('session.snapshot_available', { schemaVersion: 1, eventId: event.event_id, sessionId: event.session_id, eventSeq: Number(event.sequence) });
        await pool.query('UPDATE outbox SET dispatched_at=now() WHERE event_id=$1', [event.event_id]);
      }
    } catch { /* Durable rows remain available for the next poll. */ }
    finally { dispatching = false; }
  };
  const interval = setInterval(() => { void dispatch(); }, 250); interval.unref();
  app.addHook('onClose', async () => { clearInterval(interval); io.close(); await images.close(); await gallery.close(); await pool.end(); });
  const dist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  if (options.serveStatic !== false && existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ code: 'not_found', message: 'Route was not found.', recoverable: false }) : reply.sendFile('index.html'));
  }
  return app;
}
