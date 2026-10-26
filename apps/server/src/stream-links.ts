import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { CreateStreamLinkSchema, IdSchema, StreamAccessRequestSchema, StreamAccessResponseSchema, StreamLinkSchema, StreamLinkSummarySchema, type CreateStreamLink } from '@rpg/contracts';
import { transaction } from './database';
import { AppError, authorize, conflict, type Actor } from './repository';
import { digest, recordEvent } from './commands';
import type { AccessRouteDeps } from './credentials';

interface LinkRow {
  id: string;
  session_id: string;
  subject: 'show' | 'host' | 'producer' | 'player';
  character_id: string | null;
  producer_grant_id: string | null;
  label: string;
  can_present: boolean;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const streamToken = (hostToken: string, id: string) => createHmac('sha256', hostToken).update(JSON.stringify(['rpg-stream-v1', id])).digest('base64url');
export const streamLinkSummary = (row: LinkRow) => StreamLinkSummarySchema.parse({
  id: row.id, sessionId: row.session_id, subject: row.subject, label: row.label,
  characterId: row.character_id, producerGrantId: row.producer_grant_id, canPresent: row.can_present,
  createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null,
});
const notFound = (): never => { throw new AppError(404, 'not_found', 'That stream link was not found.'); };
const isActiveRow = (row: LinkRow) => row.revoked_at === null && row.expires_at.getTime() > Date.now();

async function previousCommand(client: PoolClient, actorId: string, commandId: string, requestHash: string) {
  const previous = (await client.query('SELECT request_hash,response FROM command_receipts WHERE actor_id=$1 AND command_id=$2', [actorId, commandId])).rows[0];
  if (previous && previous.request_hash !== requestHash) conflict('This command ID was already used for a different operation.');
  return previous?.response;
}
async function saveReceipt(client: PoolClient, actorId: string, commandId: string, requestHash: string, sessionId: string, response: unknown) {
  await client.query('INSERT INTO command_receipts(actor_id,command_id,request_hash,session_id,response) VALUES($1,$2,$3,$4,$5)', [actorId, commandId, requestHash, sessionId, response]);
}
async function loadLink(client: PoolClient, sessionId: string, linkId: string) {
  return (await client.query<LinkRow>('SELECT * FROM stream_links WHERE id=$1 AND session_id=$2', [linkId, sessionId])).rows[0];
}
const mayManage = (actor: Actor, row: LinkRow) => actor.role === 'host' || (actor.role === 'player' && row.subject === 'player' && row.character_id === actor.character_id);
const defaultLabel = async (client: PoolClient, sessionId: string, command: CreateStreamLink) => {
  if (command.subject === 'show') return (command.label ?? 'Main show').slice(0, 80);
  if (command.subject === 'host') return 'Host view';
  if (command.subject === 'producer') {
    const grant = (await client.query('SELECT label FROM producer_grants WHERE id=$1', [command.producerGrantId])).rows[0];
    return `${grant.label} view`.slice(0, 80);
  }
  const character = (await client.query("SELECT data->>'displayName' AS name FROM characters WHERE id=$1 AND session_id=$2", [command.characterId, sessionId])).rows[0];
  return `${character?.name ?? 'Player'} view`.slice(0, 80);
};

export function registerStreamLinks(app: FastifyInstance, deps: AccessRouteDeps) {
  const tokenFor = (id: string) => streamToken(deps.hostToken, id);
  const caller = async (request: FastifyRequest) => {
    const actor = await deps.authenticate(request);
    if (actor.role === 'stage') throw new AppError(403, 'forbidden', 'Stream views cannot manage stream links.');
    return actor;
  };
  const visible = (actor: Actor, row: LinkRow | undefined) => row && mayManage(actor, row) ? row : undefined;

  app.post('/api/stream/access', async (request, reply: FastifyReply) => {
    const { token } = StreamAccessRequestSchema.parse(request.body);
    const { link, credential, expiresAt } = await transaction(deps.pool, async (client) => {
      const row = (await client.query<LinkRow>('SELECT * FROM stream_links WHERE token_hash=$1 FOR UPDATE', [hash(token)])).rows[0];
      const active = row && (await client.query('SELECT revoked_at IS NULL AND expires_at>clock_timestamp() AS active FROM stream_links WHERE id=$1', [row.id])).rows[0]?.active === true;
      if (!row || !active) throw new AppError(401, 'unauthorized', 'This stream link has been turned off.');
      const credential = await deps.persistCredential({ actor_id: `stream:${row.id}`, role: 'stage', session_id: row.session_id, character_id: null, stream_link_id: row.id }, client, { expiresAt: row.expires_at });
      const expiresAt = (await client.query<{ expires_at: Date }>('SELECT expires_at FROM credentials WHERE token_hash=$1', [hash(credential)])).rows[0]!.expires_at;
      return { link: row, credential, expiresAt };
    });
    const identityId = hash(`rpg-stream-identity-v1:${link.id}`).slice(0, 32);
    deps.issueCookie(credential, reply, identityId, Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)));
    return StreamAccessResponseSchema.parse({
      identityId, sessionId: link.session_id,
      link: { id: link.id, label: link.label, subject: link.subject, characterId: link.character_id, canPresent: link.can_present },
      expiresAt: expiresAt.toISOString(),
    });
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/stream-links', async (request) => {
    const actor = await caller(request);
    return transaction(deps.pool, async (client) => {
      await authorize(client, request.params.id, actor);
      const rows = actor.role === 'host'
        ? await client.query<LinkRow>('SELECT * FROM stream_links WHERE session_id=$1 ORDER BY created_at DESC,id', [request.params.id])
        : await client.query<LinkRow>("SELECT * FROM stream_links WHERE session_id=$1 AND subject='player' AND character_id=$2 ORDER BY created_at DESC,id", [request.params.id, actor.character_id]);
      return { links: rows.rows.map(streamLinkSummary) };
    });
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/stream-links', async (request) => {
    const actor = await caller(request);
    const command = CreateStreamLinkSchema.parse(request.body);
    if (actor.role === 'player' && !(command.subject === 'player' && command.characterId === actor.character_id)) {
      throw new AppError(403, 'forbidden', 'Players can only create a stream link for their own character.');
    }
    const sessionId = request.params.id;
    const requestHash = digest({ operation: 'stream_link.create', sessionId, command });
    return transaction(deps.pool, async (client) => {
      await authorize(client, sessionId, actor);
      const session = (await client.query('SELECT version FROM sessions WHERE id=$1 FOR UPDATE', [sessionId])).rows[0];
      const previous = await previousCommand(client, actor.actor_id, command.commandId, requestHash);
      if (previous) {
        const row = visible(actor, await loadLink(client, sessionId, previous.linkId));
        if (!row || !isActiveRow(row)) return notFound();
        return StreamLinkSchema.parse({ link: streamLinkSummary(row), token: tokenFor(row.id) });
      }
      if (command.subject === 'player') {
        const character = await client.query('SELECT 1 FROM characters WHERE id=$1 AND session_id=$2', [command.characterId, sessionId]);
        if (!character.rowCount) throw new AppError(404, 'not_found', 'That character is not assigned to this session.');
      }
      if (command.subject === 'producer') {
        const grant = await client.query("SELECT 1 FROM producer_grants WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE", [command.producerGrantId, actor.actor_id]);
        if (!grant.rowCount) throw new AppError(404, 'not_found', 'That producer link was not found.');
      }
      const characterId = command.subject === 'player' ? command.characterId : null;
      const grantId = command.subject === 'producer' ? command.producerGrantId : null;
      let row: LinkRow | undefined;
      if (command.subject !== 'show') {
        const same = 'subject=$2 AND character_id IS NOT DISTINCT FROM $3 AND producer_grant_id IS NOT DISTINCT FROM $4';
        await client.query(`UPDATE stream_links SET revoked_at=clock_timestamp() WHERE session_id=$1 AND ${same} AND revoked_at IS NULL AND expires_at<=clock_timestamp()`, [sessionId, command.subject, characterId, grantId]);
        row = (await client.query<LinkRow>(`SELECT * FROM stream_links WHERE session_id=$1 AND ${same} AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [sessionId, command.subject, characterId, grantId])).rows[0];
      }
      if (!row) {
        const id = randomUUID();
        const canPresent = command.subject === 'show' ? command.canPresent ?? true : false;
        const label = await defaultLabel(client, sessionId, command);
        row = (await client.query<LinkRow>("INSERT INTO stream_links(id,session_id,subject,character_id,producer_grant_id,label,can_present,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '2160 hours') RETURNING *",
          [id, sessionId, command.subject, characterId, grantId, label, canPresent, hash(tokenFor(id))])).rows[0]!;
        await recordEvent(client, sessionId, actor, command.commandId, 'stream_link.created', session.version, { linkId: id, subject: command.subject, characterId, producerGrantId: grantId });
      }
      await saveReceipt(client, actor.actor_id, command.commandId, requestHash, sessionId, { linkId: row.id });
      return StreamLinkSchema.parse({ link: streamLinkSummary(row), token: tokenFor(row.id) });
    });
  });

  app.get<{ Params: { id: string; linkId: string } }>('/api/sessions/:id/stream-links/:linkId/link', async (request) => {
    const actor = await caller(request);
    return transaction(deps.pool, async (client) => {
      await authorize(client, request.params.id, actor);
      const row = visible(actor, await loadLink(client, request.params.id, request.params.linkId));
      if (!row || !isActiveRow(row)) return notFound();
      return StreamLinkSchema.parse({ link: streamLinkSummary(row), token: tokenFor(row.id) });
    });
  });

  app.post<{ Params: { id: string; linkId: string } }>('/api/sessions/:id/stream-links/:linkId/revoke', async (request) => {
    const actor = await caller(request);
    const command = z.strictObject({ commandId: IdSchema }).parse(request.body);
    const { id: sessionId, linkId } = request.params;
    const requestHash = digest({ operation: 'stream_link.revoke', sessionId, linkId, command });
    return transaction(deps.pool, async (client) => {
      await authorize(client, sessionId, actor);
      const session = (await client.query('SELECT version FROM sessions WHERE id=$1 FOR UPDATE', [sessionId])).rows[0];
      const previous = await previousCommand(client, actor.actor_id, command.commandId, requestHash);
      if (previous) return previous;
      const row = visible(actor, await loadLink(client, sessionId, linkId));
      if (!row) return notFound();
      await client.query('UPDATE stream_links SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1', [row.id]);
      await client.query('UPDATE credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE stream_link_id=$1', [row.id]);
      if (row.revoked_at === null) {
        await recordEvent(client, sessionId, actor, command.commandId, 'stream_link.revoked', session.version, { linkId: row.id, subject: row.subject, characterId: row.character_id, producerGrantId: row.producer_grant_id });
      }
      const response = streamLinkSummary((await loadLink(client, sessionId, row.id))!);
      await saveReceipt(client, actor.actor_id, command.commandId, requestHash, sessionId, response);
      return response;
    });
  });
}
