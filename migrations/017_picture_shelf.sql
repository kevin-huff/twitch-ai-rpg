ALTER TABLE sessions ADD COLUMN pinned_image_id uuid REFERENCES images(id) ON DELETE SET NULL;
ALTER TABLE images ADD COLUMN shelf_only boolean NOT NULL DEFAULT false;
ALTER TABLE images ADD CHECK (NOT shelf_only OR (purpose = 'scene' AND beat_id IS NULL));
