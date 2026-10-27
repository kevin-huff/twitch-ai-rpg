import type { PoolClient } from 'pg';

// Host and producer sign-ins renew on use: under 6 of their 12 hours left, they run 12 hours from now, never past a producer's grant.
// A host sign-in renews only while it belongs to the current host credential, so one minted under an old HOST_TOKEN lapses.
export async function renewSignIn(db: Pick<PoolClient, 'query'>, tokenHash: string, hostActorId: string): Promise<number | null> {
  const result = await db.query<{ seconds: number }>(`UPDATE credentials c SET expires_at=n.renewed
    FROM (SELECT c2.token_hash,LEAST(clock_timestamp()+interval '12 hours',CASE WHEN c2.role='producer' THEN g.expires_at END) AS renewed
      FROM credentials c2 LEFT JOIN producer_grants g ON g.id=c2.producer_grant_id
      WHERE c2.token_hash=$1 AND c2.revoked_at IS NULL AND c2.expires_at>clock_timestamp()
      AND c2.expires_at<clock_timestamp()+interval '6 hours'
      AND ((c2.role='host' AND c2.actor_id=$2) OR (c2.role='producer' AND g.id IS NOT NULL AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()))) n
    WHERE c.token_hash=n.token_hash AND n.renewed>c.expires_at
    RETURNING GREATEST(1,floor(extract(epoch FROM c.expires_at-clock_timestamp())))::int AS seconds`, [tokenHash, hostActorId]);
  return result.rows[0]?.seconds ?? null;
}
