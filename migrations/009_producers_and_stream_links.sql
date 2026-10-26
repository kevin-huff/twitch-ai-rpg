CREATE TABLE producer_grants (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  token_hash text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_signed_in_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX producer_grants_owner ON producer_grants(owner_id, created_at DESC);

CREATE TABLE stream_links (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id),
  subject text NOT NULL CHECK (subject IN ('show', 'host', 'producer', 'player')),
  character_id text REFERENCES characters(id),
  producer_grant_id text REFERENCES producer_grants(id),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  can_present boolean NOT NULL DEFAULT false,
  token_hash text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK ((subject = 'player') = (character_id IS NOT NULL)),
  CHECK ((subject = 'producer') = (producer_grant_id IS NOT NULL)),
  CHECK (NOT can_present OR subject = 'show'),
  CHECK (expires_at > created_at)
);
CREATE INDEX stream_links_session ON stream_links(session_id, created_at DESC);
CREATE UNIQUE INDEX stream_links_one_personal ON stream_links(session_id, subject, COALESCE(character_id, producer_grant_id, ''))
  WHERE subject <> 'show' AND revoked_at IS NULL;

ALTER TABLE credentials ADD COLUMN producer_grant_id text REFERENCES producer_grants(id);
ALTER TABLE credentials ADD COLUMN stream_link_id text REFERENCES stream_links(id);
DO $$
DECLARE existing text;
BEGIN
  FOR existing IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'credentials'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%''stage''%'
  LOOP
    EXECUTE format('ALTER TABLE credentials DROP CONSTRAINT %I', existing);
  END LOOP;
END $$;
ALTER TABLE credentials ADD CONSTRAINT credentials_role_check CHECK (role IN ('host', 'producer', 'player', 'stage'));
ALTER TABLE credentials ADD CONSTRAINT credentials_producer_scope
  CHECK (role <> 'producer' OR (producer_grant_id IS NOT NULL AND session_id IS NULL AND character_id IS NULL));
ALTER TABLE credentials ADD CONSTRAINT credentials_stream_scope
  CHECK (stream_link_id IS NULL OR (role = 'stage' AND session_id IS NOT NULL AND character_id IS NULL));
CREATE INDEX credentials_actor ON credentials(actor_id);
CREATE INDEX credentials_producer_grant ON credentials(producer_grant_id) WHERE producer_grant_id IS NOT NULL;
CREATE INDEX credentials_stream_link ON credentials(stream_link_id) WHERE stream_link_id IS NOT NULL;

ALTER TABLE invites ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
UPDATE invites SET created_at = expires_at - interval '7 days';
ALTER TABLE invites ADD COLUMN replaces_invite_id text REFERENCES invites(id);
CREATE INDEX invites_session ON invites(session_id);

ALTER TABLE audit_events ADD COLUMN producer_grant_id text REFERENCES producer_grants(id);
