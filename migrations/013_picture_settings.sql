ALTER TABLE sessions
  ADD COLUMN picture_settings jsonb CHECK (picture_settings IS NULL OR jsonb_typeof(picture_settings) = 'object');

ALTER TABLE images
  ADD COLUMN moment jsonb CHECK (moment IS NULL OR jsonb_typeof(moment) = 'object'),
  ADD CONSTRAINT images_moment_scene_check CHECK (moment IS NULL OR (purpose = 'scene' AND session_id IS NOT NULL));

ALTER TABLE images DROP CONSTRAINT images_prompt_check;
ALTER TABLE images ADD CONSTRAINT images_prompt_check CHECK (char_length(prompt) >= 1);
