CREATE TABLE galleries (
  session_id text PRIMARY KEY REFERENCES sessions(id),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[A-Za-z0-9_-]{43}$'),
  listed boolean NOT NULL DEFAULT false,
  pictures integer NOT NULL DEFAULT 0 CHECK (pictures >= 0),
  message text CHECK (char_length(message) <= 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  written_at timestamptz
);
ALTER TABLE images ADD COLUMN shows_beat_id text;
