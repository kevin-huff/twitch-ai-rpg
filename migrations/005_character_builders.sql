CREATE TABLE character_builders (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  label text NOT NULL,
  instructions text NOT NULL,
  token_hash text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  draft_revision integer NOT NULL DEFAULT 0 CHECK (draft_revision >= 0),
  draft jsonb NOT NULL,
  submitted_at timestamptz,
  submitted_template_id text,
  submitted_template_version integer,
  FOREIGN KEY (submitted_template_id, submitted_template_version) REFERENCES library_versions(template_id, version),
  CHECK ((submitted_at IS NULL AND submitted_template_id IS NULL AND submitted_template_version IS NULL)
    OR (submitted_at IS NOT NULL AND submitted_template_id IS NOT NULL AND submitted_template_version IS NOT NULL))
);
CREATE INDEX character_builders_owner ON character_builders(owner_id);

CREATE TABLE character_builder_credentials (
  token_hash text PRIMARY KEY,
  builder_id text NOT NULL REFERENCES character_builders(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX character_builder_credentials_builder ON character_builder_credentials(builder_id);
