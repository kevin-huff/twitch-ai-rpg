import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from './repository';

export type CredentialRow = {
  actor_id: string;
  role: 'host' | 'producer' | 'player' | 'stage';
  session_id: string | null;
  character_id: string | null;
  producer_grant_id?: string | null;
  stream_link_id?: string | null;
};

export interface AccessRouteDeps {
  pool: Pool;
  authenticate(request: FastifyRequest, client?: PoolClient): Promise<Actor>;
  hostToken: string;
  origin: string;
  persistCredential(row: CredentialRow, client?: Pick<PoolClient, 'query'>, options?: { expiresAt?: Date }): Promise<string>;
  issueCookie(credential: string, reply: FastifyReply, identityId?: string, maxAgeSeconds?: number): void;
}

const ACTIVE = `FROM credentials c
  LEFT JOIN producer_grants g ON g.id=c.producer_grant_id
  LEFT JOIN stream_links l ON l.id=c.stream_link_id
  WHERE c.expires_at>clock_timestamp() AND c.revoked_at IS NULL
  AND (c.producer_grant_id IS NULL OR (g.revoked_at IS NULL AND g.expires_at>clock_timestamp()))
  AND (c.stream_link_id IS NULL OR (l.revoked_at IS NULL AND l.expires_at>clock_timestamp()))`;

export async function findActiveActor(db: Pick<PoolClient, 'query'>, tokenHash: string): Promise<Actor | null> {
  const row = (await db.query(`SELECT c.actor_id,c.role,c.session_id,c.character_id,c.producer_grant_id,c.stream_link_id,c.expires_at,COALESCE(l.can_present,true) AS can_present ${ACTIVE} AND c.token_hash=$1`, [tokenHash])).rows[0];
  if (!row) return null;
  if (row.role === 'producer') {
    return { actor_id: row.actor_id, role: 'host', session_id: null, character_id: null, producer_grant_id: row.producer_grant_id, can_present: true, expires_at: row.expires_at };
  }
  return {
    actor_id: row.actor_id, role: row.role, session_id: row.session_id, character_id: row.character_id,
    producer_grant_id: row.producer_grant_id, stream_link_id: row.stream_link_id, can_present: row.can_present, expires_at: row.expires_at,
  };
}

export async function activeTokenHashes(db: Pick<PoolClient, 'query'>, hashes: string[]): Promise<Set<string>> {
  if (!hashes.length) return new Set();
  const result = await db.query(`SELECT c.token_hash ${ACTIVE} AND c.token_hash=ANY($1::text[])`, [hashes]);
  return new Set(result.rows.map((row) => row.token_hash as string));
}
