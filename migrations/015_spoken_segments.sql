DO $$
DECLARE found record;
BEGIN
  FOR found IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'session_playback'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%segment_index%'
  LOOP
    EXECUTE format('ALTER TABLE session_playback DROP CONSTRAINT %I', found.conname);
  END LOOP;
END $$;

ALTER TABLE session_playback ADD CONSTRAINT session_playback_segment_index_check CHECK (segment_index >= 0 AND segment_index < 42);
