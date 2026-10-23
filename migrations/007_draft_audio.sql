CREATE TABLE draft_audio_preparations (
  id uuid PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id),
  beat_id text NOT NULL REFERENCES beats(id),
  draft_revision integer NOT NULL,
  generation integer NOT NULL,
  source_hash text NOT NULL,
  config_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('preparing','ready','failed')),
  lease_until timestamptz NOT NULL,
  segments jsonb NOT NULL,
  manifest jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX draft_audio_current ON draft_audio_preparations(session_id,beat_id,draft_revision,generation,source_hash,config_hash,created_at DESC);
CREATE TABLE draft_audio_receipts (
  actor_id text NOT NULL,
  command_id text NOT NULL,
  request_hash text NOT NULL,
  session_id text NOT NULL REFERENCES sessions(id),
  beat_id text NOT NULL REFERENCES beats(id),
  preparation_id uuid NOT NULL REFERENCES draft_audio_preparations(id),
  PRIMARY KEY(actor_id,command_id)
);
