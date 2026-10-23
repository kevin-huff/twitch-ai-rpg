CREATE TABLE session_playback (
  session_id text PRIMARY KEY REFERENCES sessions(id),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision >= 0),
  sample_revision bigint NOT NULL DEFAULT 0 CHECK(sample_revision >= revision),
  playback_id uuid,
  status text NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','playing','paused','stopped','complete')),
  manifest jsonb,
  segment_index integer CHECK(segment_index >= 0 AND segment_index < 30),
  position_ms integer NOT NULL DEFAULT 0 CHECK(position_ms >= 0 AND position_ms <= 3600000),
  anchor_time_ms bigint,
  presenter_actor_id text,
  presenter_client_id uuid,
  presenter_lease_id uuid,
  presenter_expires_at_ms bigint,
  renewal_sequence bigint NOT NULL DEFAULT 0,
  telemetry_sequence bigint NOT NULL DEFAULT 0,
  CHECK ((presenter_actor_id IS NULL AND presenter_client_id IS NULL AND presenter_lease_id IS NULL AND presenter_expires_at_ms IS NULL)
    OR (presenter_actor_id IS NOT NULL AND presenter_client_id IS NOT NULL AND presenter_lease_id IS NOT NULL AND presenter_expires_at_ms IS NOT NULL))
);

CREATE TABLE playback_receipts (
  actor_id text NOT NULL,
  command_id text NOT NULL,
  request_hash text NOT NULL,
  session_id text NOT NULL REFERENCES sessions(id),
  response jsonb NOT NULL,
  PRIMARY KEY(actor_id,command_id)
);
