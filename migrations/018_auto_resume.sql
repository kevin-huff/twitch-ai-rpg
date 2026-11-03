ALTER TABLE session_playback ADD COLUMN IF NOT EXISTS lapse_paused boolean NOT NULL DEFAULT false;
ALTER TABLE session_playback ADD COLUMN IF NOT EXISTS presenter_resumed_at_ms bigint;
