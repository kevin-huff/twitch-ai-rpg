CREATE TABLE audio_assets (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id),
  content_type text NOT NULL, byte_length integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audio_manifests (
  session_id text NOT NULL REFERENCES sessions(id), beat_id text NOT NULL REFERENCES published_beats(id),
  config_hash text NOT NULL, status text NOT NULL CHECK(status IN ('preparing','ready','failed')),
  lease_id text NOT NULL, lease_until timestamptz NOT NULL, manifest jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(session_id,beat_id,config_hash)
);
