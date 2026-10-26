import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { CreateProducerSchema, IdSchema, ProducerLinkSchema, ProducerSignInResponseSchema, ProducerSummarySchema, ViewerSchema } from '@rpg/contracts';
import { transaction } from './database';
import { AppError, conflict, isHostOnly } from './repository';
import { digest } from './commands';
import type { AccessRouteDeps } from './credentials';

interface GrantRow {
  id: string;
  owner_id: string;
  label: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_signed_in_at: Date | null;
  active_sign_ins: number;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const producerToken = (hostToken: string, id: string) => createHmac('sha256', hostToken).update(JSON.stringify(['rpg-producer-v1', id])).digest('base64url');
export const producerSummary = (row: GrantRow) => ProducerSummarySchema.parse({
  id: row.id, label: row.label, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(),
  revokedAt: row.revoked_at?.toISOString() ?? null, lastSignedInAt: row.last_signed_in_at?.toISOString() ?? null,
  activeSignIns: Number(row.active_sign_ins),
});
const notFound = (): never => { throw new AppError(404, 'not_found', 'That producer link was not found.'); };
const GRANT = `SELECT g.*,(SELECT count(*) FROM credentials c WHERE c.producer_grant_id=g.id AND c.role='producer' AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp())::int AS active_sign_ins FROM producer_grants g`;

async function previousCommand(client: PoolClient, actorId: string, commandId: string, requestHash: string) {
  const previous = (await client.query('SELECT request_hash,response FROM command_receipts WHERE actor_id=$1 AND command_id=$2', [actorId, commandId])).rows[0];
  if (previous && previous.request_hash !== requestHash) conflict('This command ID was already used for a different operation.');
  return previous?.response;
}
async function saveReceipt(client: PoolClient, actorId: string, commandId: string, requestHash: string, response: unknown) {
  await client.query('INSERT INTO command_receipts(actor_id,command_id,request_hash,response) VALUES($1,$2,$3,$4)', [actorId, commandId, requestHash, response]);
}
async function ownedGrant(client: PoolClient, id: string, ownerId: string, lock = false) {
  if (lock) await client.query('SELECT 1 FROM producer_grants WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, ownerId]);
  const row = (await client.query<GrantRow>(`${GRANT} WHERE g.id=$1 AND g.owner_id=$2`, [id, ownerId])).rows[0];
  return row ?? notFound();
}
const isActive = async (client: PoolClient, id: string) =>
  (await client.query('SELECT expires_at>clock_timestamp() AND revoked_at IS NULL AS active FROM producer_grants WHERE id=$1', [id])).rows[0]?.active === true;

export function registerProducers(app: FastifyInstance, deps: AccessRouteDeps) {
  const tokenFor = (id: string) => producerToken(deps.hostToken, id);
  const hostOnly = async (request: FastifyRequest) => {
    const actor = await deps.authenticate(request);
    if (!isHostOnly(actor)) throw new AppError(403, 'forbidden', 'Only the host can manage producer access.');
    return actor;
  };

  app.get('/api/producers', async (request) => {
    const actor = await hostOnly(request);
    const rows = await deps.pool.query<GrantRow>(`${GRANT} WHERE g.owner_id=$1 ORDER BY g.created_at DESC,g.id`, [actor.actor_id]);
    return { producers: rows.rows.map(producerSummary) };
  });

  app.post('/api/producers', async (request) => {
    const actor = await hostOnly(request);
    const command = CreateProducerSchema.parse(request.body);
    const requestHash = digest({ operation: 'producer.create', command });
    return transaction(deps.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [actor.actor_id]);
      const previous = await previousCommand(client, actor.actor_id, command.commandId, requestHash);
      let id: string;
      if (previous) {
        id = previous.producerId;
        await ownedGrant(client, id, actor.actor_id);
        if (!await isActive(client, id)) return notFound();
      } else {
        id = randomUUID();
        await client.query("INSERT INTO producer_grants(id,owner_id,label,token_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '720 hours')", [id, actor.actor_id, command.label, hash(tokenFor(id))]);
        await saveReceipt(client, actor.actor_id, command.commandId, requestHash, { producerId: id });
      }
      return ProducerLinkSchema.parse({ producer: producerSummary(await ownedGrant(client, id, actor.actor_id)), token: tokenFor(id) });
    });
  });

  app.get<{ Params: { id: string } }>('/api/producers/:id/link', async (request) => {
    const actor = await hostOnly(request);
    return transaction(deps.pool, async (client) => {
      const row = await ownedGrant(client, request.params.id, actor.actor_id);
      if (!await isActive(client, row.id)) return notFound();
      return ProducerLinkSchema.parse({ producer: producerSummary(row), token: tokenFor(row.id) });
    });
  });

  app.post<{ Params: { id: string } }>('/api/producers/:id/revoke', async (request) => {
    const actor = await hostOnly(request);
    const command = z.strictObject({ commandId: IdSchema }).parse(request.body);
    const requestHash = digest({ operation: 'producer.revoke', producerId: request.params.id, command });
    return transaction(deps.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [actor.actor_id]);
      const locked = await ownedGrant(client, request.params.id, actor.actor_id, true);
      const previous = await previousCommand(client, actor.actor_id, command.commandId, requestHash);
      if (previous) return previous;
      await client.query('UPDATE producer_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1', [locked.id]);
      await client.query('UPDATE credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE producer_grant_id=$1', [locked.id]);
      await client.query('UPDATE stream_links SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE producer_grant_id=$1', [locked.id]);
      await client.query('UPDATE credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE stream_link_id IN (SELECT id FROM stream_links WHERE producer_grant_id=$1)', [locked.id]);
      const response = producerSummary(await ownedGrant(client, locked.id, actor.actor_id));
      await saveReceipt(client, actor.actor_id, command.commandId, requestHash, response);
      return response;
    });
  });

  const signInBody = z.strictObject({ token: z.string().min(1).max(1024), tab: z.literal(true).optional() });
  const SIGN_IN_FAILED = 'This producer link is expired, revoked, or invalid. Ask the host for a new link.';
  app.post('/api/auth/producer', async (request, reply) => {
    const { token, tab } = signInBody.parse(request.body);
    const identityId = tab ? randomBytes(16).toString('hex') : undefined;
    const { credential, expiresAt, maxAge, label } = await transaction(deps.pool, async (client) => {
      const grant = (await client.query<GrantRow & { live: boolean }>('SELECT *,(revoked_at IS NULL AND expires_at>clock_timestamp()) AS live FROM producer_grants WHERE token_hash=$1 FOR UPDATE', [hash(token)])).rows[0];
      if (!grant || !grant.live || grant.owner_id !== hash(deps.hostToken)) throw new AppError(401, 'unauthorized', SIGN_IN_FAILED);
      await client.query('UPDATE producer_grants SET last_signed_in_at=clock_timestamp() WHERE id=$1', [grant.id]);
      const credential = await deps.persistCredential({ actor_id: grant.owner_id, role: 'producer', session_id: null, character_id: null, producer_grant_id: grant.id }, client, { expiresAt: grant.expires_at });
      const issued = (await client.query('SELECT expires_at,GREATEST(1,floor(extract(epoch FROM expires_at-clock_timestamp())))::int AS max_age FROM credentials WHERE token_hash=$1', [hash(credential)])).rows[0];
      return { credential, expiresAt: issued.expires_at as Date, maxAge: issued.max_age as number, label: grant.label };
    });
    deps.issueCookie(credential, reply, identityId, maxAge);
    return ProducerSignInResponseSchema.parse({ role: 'producer', label, expiresAt: expiresAt.toISOString(), ...(identityId ? { identityId } : {}) });
  });

  app.get('/api/auth/me', async (request) => {
    const actor = await deps.authenticate(request);
    if (!actor.expires_at) throw new AppError(401, 'unauthorized', 'Sign in or redeem an invitation first.');
    const producerHost = actor.role === 'host' && !!actor.producer_grant_id;
    const grant = producerHost
      ? (await deps.pool.query<{ id: string; label: string; expires_at: Date }>('SELECT id,label,expires_at FROM producer_grants WHERE id=$1', [actor.producer_grant_id])).rows[0]
      : undefined;
    if (producerHost && !grant) throw new AppError(401, 'unauthorized', 'Sign in or redeem an invitation first.');
    return ViewerSchema.parse({
      role: producerHost ? 'producer' : actor.role, sessionId: actor.session_id, characterId: actor.character_id,
      producer: grant ? { grantId: grant.id, label: grant.label, expiresAt: grant.expires_at.toISOString() } : null,
      streamLinkId: actor.stream_link_id ?? null, expiresAt: actor.expires_at.toISOString(),
    });
  });
}
