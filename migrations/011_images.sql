CREATE TABLE images (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  session_id text REFERENCES sessions(id),
  builder_id text REFERENCES character_builders(id),
  purpose text NOT NULL CHECK (purpose IN ('scene', 'npc', 'character', 'card')),
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 200),
  limit_key text NOT NULL CHECK (char_length(limit_key) BETWEEN 1 AND 400),
  attach boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('making', 'ready', 'failed', 'cancelled')),
  hidden boolean NOT NULL DEFAULT false,
  prompt text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 2000),
  width integer NOT NULL CHECK (width BETWEEN 64 AND 2048),
  height integer NOT NULL CHECK (height BETWEEN 64 AND 2048),
  provider text NOT NULL,
  model text NOT NULL,
  requested_by text NOT NULL,
  producer_grant_id text REFERENCES producer_grants(id),
  workflow_id text,
  file_hash text CHECK (file_hash ~ '^[a-f0-9]{64}$'),
  content_type text CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_length integer CHECK (byte_length BETWEEN 1 AND 8000000),
  message text CHECK (char_length(message) <= 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  CHECK (status <> 'ready' OR (file_hash IS NOT NULL AND content_type IS NOT NULL AND byte_length IS NOT NULL)),
  CHECK (purpose NOT IN ('scene', 'character') OR session_id IS NOT NULL),
  CHECK (NOT attach OR (purpose = 'npc' AND session_id IS NOT NULL))
);
CREATE INDEX images_session_subject ON images(session_id, purpose, subject_id, created_at DESC);
CREATE INDEX images_created ON images(created_at);
CREATE INDEX images_limit_key ON images(limit_key, created_at);
