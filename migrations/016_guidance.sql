ALTER TABLE sessions ADD COLUMN guidance jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE session_playback ADD COLUMN presenter_label text, ADD COLUMN presenter_show_title text, ADD COLUMN presenter_agent text CHECK (presenter_agent IN ('obs','browser')), ADD COLUMN presenter_claimed_at_ms bigint;
CREATE TABLE playback_stopped_clients (session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, client_id uuid NOT NULL, stopped_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (session_id, client_id));
