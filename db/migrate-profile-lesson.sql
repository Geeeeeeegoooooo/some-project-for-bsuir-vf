-- Однократно для существующей БД: прогресс по каждому узлу пути и слот урока в попытке
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS mastery_by_lesson JSONB DEFAULT '{}'::jsonb;
ALTER TABLE lesson_attempts ADD COLUMN IF NOT EXISTS lesson_slot SMALLINT NOT NULL DEFAULT 0;
