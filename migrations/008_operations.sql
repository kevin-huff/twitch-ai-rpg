CREATE TABLE usage_tracking (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  since timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO usage_tracking(singleton) VALUES(true);
CREATE TABLE session_usage_coverage (
  session_id text PRIMARY KEY REFERENCES sessions(id),
  partial boolean NOT NULL DEFAULT false
);
CREATE TABLE usage_attempts (
  id uuid PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id),
  beat_id text NOT NULL,
  operation_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('plan','render','speech')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL,
  characters integer NOT NULL DEFAULT 0 CHECK(characters >= 0)
);
CREATE INDEX usage_attempts_session ON usage_attempts(session_id,started_at);
CREATE TABLE usage_attempt_results (
  attempt_id uuid PRIMARY KEY REFERENCES usage_attempts(id),
  status text NOT NULL CHECK(status IN ('succeeded','failed','interrupted')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE speech_reuse (
  id uuid PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id),
  beat_id text NOT NULL,
  operation_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('cache','shared')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX speech_reuse_session ON speech_reuse(session_id);
ALTER TABLE draft_audio_preparations ADD COLUMN completed_segments integer NOT NULL DEFAULT 0 CHECK(completed_segments >= 0);
ALTER TABLE draft_audio_preparations ADD COLUMN total_segments integer CHECK(total_segments > 0);
ALTER TABLE draft_audio_preparations ADD COLUMN finished_at timestamptz;
UPDATE draft_audio_preparations SET total_segments=jsonb_array_length(segments),
  completed_segments=CASE WHEN status='ready' THEN jsonb_array_length(segments) ELSE 0 END,
  finished_at=CASE WHEN status IN ('ready','failed') THEN updated_at ELSE NULL END
  WHERE jsonb_typeof(segments)='array' AND jsonb_array_length(segments)>0;
ALTER TABLE draft_audio_preparations ADD CHECK(total_segments IS NULL OR completed_segments<=total_segments);
ALTER TABLE audio_manifests ADD COLUMN started_at timestamptz;
ALTER TABLE audio_manifests ADD COLUMN finished_at timestamptz;
ALTER TABLE audio_manifests ADD COLUMN completed_segments integer NOT NULL DEFAULT 0 CHECK(completed_segments >= 0);
ALTER TABLE audio_manifests ADD COLUMN total_segments integer CHECK(total_segments > 0);
UPDATE audio_manifests SET total_segments=jsonb_array_length(manifest->'segments'),
  completed_segments=CASE WHEN status='ready' THEN jsonb_array_length(manifest->'segments') ELSE 0 END,
  finished_at=CASE WHEN status IN ('ready','failed') THEN updated_at ELSE NULL END
  WHERE jsonb_typeof(manifest->'segments')='array' AND jsonb_array_length(manifest->'segments')>0;
ALTER TABLE audio_manifests ADD CHECK(total_segments IS NULL OR completed_segments<=total_segments);
