import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { InviteLinkSchema, InviteSummarySchema, ReissueInviteSchema } from '@rpg/contracts';
import { transaction } from './database';
import { AppError, authorize, conflict, type Actor } from './repository';
import { digest, recordEvent } from './commands';
import type { AccessRouteDeps } from './credentials';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export const invitationToken = (hostToken: string, invite: { id: string; session_id: string; role: string; character_id: string | null }) =>
  createHmac('sha256', hostToken).update(JSON.stringify(['rpg-invite-v1', invite.id, invite.session_id, invite.role, invite.character_id])).digest('base64url');

interface InviteRow {
  id: string;
  session_id: string;
  role: 'player' | 'stage';
  character_id: string | null;
  created_at: Date;
  expires_at: Date;
  redeemed_at: Date | null;
  revoked_at: Date | null;
  replaced_by: string | null;
  is_expired: boolean;
  signed_in: boolean;
}

const SELECT_INVITES = `SELECT i.*,
    (SELECT r.id FROM invites r WHERE r.replaces_invite_id=i.id ORDER BY r.created_at DESC,r.id LIMIT 1) AS replaced_by,
    i.expires_at<=clock_timestamp() AS is_expired,
    EXISTS(SELECT 1 FROM credentials c WHERE c.actor_id=i.id AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()) AS signed_in
  FROM invites i`;

const inviteStatus = (row: InviteRow) => row.replaced_by ? 'replaced' : row.revoked_at ? 'revoked' : row.redeemed_at ? 'joined' : row.is_expired ? 'expired' : 'waiting';
const inviteSummary = (row: InviteRow) => InviteSummarySchema.parse({
  id: row.id, role: row.role, characterId: row.character_id, status: inviteStatus(row),
  createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(),
  redeemedAt: row.redeemed_at?.toISOString() ?? null, revokedAt: row.revoked_at?.toISOString() ?? null,
  replacedBy: row.replaced_by, signedIn: row.signed_in,
});
const notFound = (): never => { throw new AppError(404, 'not_found', 'That invitation was not found.'); };
const loadInvite = async (client: PoolClient, sessionId: string, inviteId: string) =>
  (await client.query<InviteRow>(`${SELECT_INVITES} WHERE i.id=$1 AND i.session_id=$2`, [inviteId, sessionId])).rows[0];

export function registerInvites(app: FastifyInstance, deps: AccessRouteDeps) {
  const tokenFor = (row: InviteRow) => invitationToken(deps.hostToken, row);
  const linkOf = (row: InviteRow) => InviteLinkSchema.parse({ invite: inviteSummary(row), token: tokenFor(row) });
  const director = async (request: FastifyRequest, client?: PoolClient): Promise<Actor> => {
    const actor = await deps.authenticate(request, client);
    if (actor.role !== 'host') throw new AppError(403, 'forbidden', 'Only the host or a producer can manage invitations.');
    return actor;
  };

  app.get<{ Params: { id: string } }>('/api/sessions/:id/invites', async (request) => {
    const actor = await director(request);
    return transaction(deps.pool, async (client) => {
      await authorize(client, request.params.id, actor);
      const rows = await client.query<InviteRow>(`${SELECT_INVITES} LEFT JOIN characters ch ON ch.id=i.character_id WHERE i.session_id=$1 ORDER BY CASE WHEN i.role='player' THEN 0 ELSE 1 END,ch.ordinal,i.created_at,i.id`, [request.params.id]);
      return { invites: rows.rows.map(inviteSummary) };
    });
  });

  app.get<{ Params: { id: string; inviteId: string } }>('/api/sessions/:id/invites/:inviteId/link', async (request) => {
    const actor = await director(request);
    return transaction(deps.pool, async (client) => {
      await authorize(client, request.params.id, actor);
      const row = await loadInvite(client, request.params.id, request.params.inviteId);
      if (!row) return notFound();
      if (inviteStatus(row) !== 'waiting') conflict('This invitation was already used or replaced. Reissue it to get a new link.');
      return linkOf(row);
    });
  });

  app.post<{ Params: { id: string; inviteId: string } }>('/api/sessions/:id/invites/:inviteId/reissue', async (request) => {
    const actor = await director(request);
    const command = ReissueInviteSchema.parse(request.body);
    const { id: sessionId, inviteId } = request.params;
    const requestHash = digest({ operation: 'invite.reissue', sessionId, inviteId, command });
    return transaction(deps.pool, async (client) => {
      await authorize(client, sessionId, actor);
      const session = (await client.query('SELECT version FROM sessions WHERE id=$1 FOR UPDATE', [sessionId])).rows[0];
      const previous = (await client.query('SELECT request_hash,response FROM command_receipts WHERE actor_id=$1 AND command_id=$2', [actor.actor_id, command.commandId])).rows[0];
      if (previous) {
        if (previous.request_hash !== requestHash) conflict('This command ID was already used for a different operation.');
        const replay = await loadInvite(client, sessionId, previous.response.inviteId);
        if (!replay) return notFound();
        return linkOf(replay);
      }
      const old = await loadInvite(client, sessionId, inviteId);
      if (!old) return notFound();
      if (old.replaced_by) conflict('This invitation was already replaced. Reissue the newest link for this seat.');
      await client.query('UPDATE invites SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1', [old.id]);
      if (command.signOutCurrent) {
        await client.query(
          'UPDATE credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE revoked_at IS NULL AND actor_id IN (SELECT id FROM invites WHERE session_id=$1 AND role=$2 AND character_id IS NOT DISTINCT FROM $3)',
          [sessionId, old.role, old.character_id]);
      }
      const replacement = { id: randomUUID(), session_id: sessionId, role: old.role, character_id: old.character_id };
      await client.query("INSERT INTO invites(id,token_hash,session_id,role,character_id,expires_at,replaces_invite_id) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '7 days',$6)",
        [replacement.id, hash(invitationToken(deps.hostToken, replacement)), sessionId, replacement.role, replacement.character_id, old.id]);
      await recordEvent(client, sessionId, actor, command.commandId, 'invite.reissued', session.version, { inviteId: old.id, replacementId: replacement.id, role: old.role, characterId: old.character_id, signOutCurrent: command.signOutCurrent });
      await client.query('INSERT INTO command_receipts(actor_id,command_id,request_hash,session_id,response) VALUES($1,$2,$3,$4,$5)', [actor.actor_id, command.commandId, requestHash, sessionId, { inviteId: replacement.id }]);
      return linkOf((await loadInvite(client, sessionId, replacement.id))!);
    });
  });
}
