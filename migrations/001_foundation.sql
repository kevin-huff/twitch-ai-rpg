CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL,
  version integer NOT NULL DEFAULT 0, input_epoch integer NOT NULL DEFAULT 0,
  beat_number integer NOT NULL DEFAULT 0, action_round integer NOT NULL DEFAULT 0,
  current_beat_id text, status text NOT NULL DEFAULT 'live',
  scene jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS characters (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id),
  version integer NOT NULL DEFAULT 0, data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS npcs (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id),
  version integer NOT NULL DEFAULT 0, data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS tracks (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id),
  version integer NOT NULL DEFAULT 0, data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS beats (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id),
  kind text NOT NULL CHECK (kind IN ('conversation','action')), phase text NOT NULL,
  input_revision integer NOT NULL DEFAULT 0, draft_revision integer NOT NULL DEFAULT 0,
  snapshot_hash text, data jsonb NOT NULL, published_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_beat ON beats(session_id) WHERE phase NOT IN ('published','aborted');
CREATE TABLE IF NOT EXISTS submissions (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id), character_id text NOT NULL REFERENCES characters(id),
  beat_id text REFERENCES beats(id), revision integer NOT NULL, status text NOT NULL,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS action_contracts (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id), beat_id text NOT NULL REFERENCES beats(id),
  version integer NOT NULL, data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS rolls (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id), beat_id text NOT NULL REFERENCES beats(id),
  contract_id text NOT NULL UNIQUE REFERENCES action_contracts(id), data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS published_beats (
  id text PRIMARY KEY REFERENCES beats(id), session_id text NOT NULL REFERENCES sessions(id),
  beat_number integer NOT NULL, data jsonb NOT NULL, UNIQUE(session_id,beat_number)
);
CREATE TABLE IF NOT EXISTS credentials (
  token_hash text PRIMARY KEY, actor_id text NOT NULL, role text NOT NULL CHECK(role IN ('host','player','stage')),
  session_id text REFERENCES sessions(id), character_id text REFERENCES characters(id),
  expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS invites (
  id text PRIMARY KEY, token_hash text UNIQUE NOT NULL, session_id text NOT NULL REFERENCES sessions(id),
  role text NOT NULL CHECK(role IN ('player','stage')), character_id text REFERENCES characters(id),
  expires_at timestamptz NOT NULL, redeemed_at timestamptz, revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS command_receipts (
  actor_id text NOT NULL, command_id text NOT NULL, request_hash text NOT NULL,
  session_id text REFERENCES sessions(id), response jsonb NOT NULL, PRIMARY KEY(actor_id,command_id)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id), sequence bigserial UNIQUE NOT NULL,
  actor_id text NOT NULL, command_id text NOT NULL, kind text NOT NULL, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS outbox (
  event_id text PRIMARY KEY REFERENCES audit_events(id), session_id text NOT NULL REFERENCES sessions(id),
  revision integer NOT NULL, dispatched_at timestamptz
);
CREATE TABLE IF NOT EXISTS generation_jobs (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id), beat_id text NOT NULL REFERENCES beats(id),
  snapshot_hash text NOT NULL, generation integer NOT NULL, status text NOT NULL,
  input jsonb NOT NULL, error text, created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'conversation';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS director_notes text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS facts (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id), data jsonb NOT NULL
);
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS task text NOT NULL DEFAULT 'render';
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS command_id text;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS actor_id text;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS request_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS job_command ON generation_jobs(actor_id,command_id);
ALTER TABLE characters ADD COLUMN IF NOT EXISTS ordinal integer NOT NULL DEFAULT 0;
ALTER TABLE npcs ADD COLUMN IF NOT EXISTS ordinal integer NOT NULL DEFAULT 0;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS ordinal integer NOT NULL DEFAULT 0;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS ordinal integer NOT NULL DEFAULT 0;
