CREATE TABLE library_templates (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('scenarios', 'characters')),
  current_version integer NOT NULL CHECK (current_version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX library_templates_owner_kind ON library_templates(owner_id, kind);
CREATE TABLE library_versions (
  template_id text NOT NULL REFERENCES library_templates(id),
  version integer NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(template_id, version)
);
ALTER TABLE sessions ADD COLUMN scenario_snapshot jsonb;
ALTER TABLE sessions ADD COLUMN character_snapshots jsonb;
ALTER TABLE sessions ADD COLUMN setup jsonb;
ALTER TABLE sessions ADD COLUMN brief jsonb;
