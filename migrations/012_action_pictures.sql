ALTER TABLE images ADD COLUMN beat_id text CHECK (char_length(beat_id) BETWEEN 1 AND 200);
ALTER TABLE images ADD COLUMN released_at timestamptz;
ALTER TABLE images ADD CHECK (beat_id IS NULL OR (purpose = 'scene' AND session_id IS NOT NULL));
ALTER TABLE images ADD CHECK (released_at IS NULL OR beat_id IS NOT NULL);
CREATE INDEX images_session_beat ON images(session_id, beat_id, created_at DESC) WHERE beat_id IS NOT NULL;
