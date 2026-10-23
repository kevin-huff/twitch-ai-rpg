ALTER TABLE sessions ADD COLUMN locations jsonb NOT NULL DEFAULT '[]'::jsonb;
