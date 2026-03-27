-- Уставы ВС РБ: схема PostgreSQL для pgAdmin
-- Все данные в БД. В pgAdmin смотрите представления (Views) для удобного отображения.

-- Пользователи: email = логин, password_plain = пароль без шифровки (для просмотра в pgAdmin)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  password_plain VARCHAR(255),
  username VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_plain VARCHAR(255);

-- VIEW: Пользователи — логин и пароль (читаемо)
CREATE OR REPLACE VIEW v_users AS
  SELECT id, email AS login, username, password_plain AS password, created_at
  FROM users ORDER BY id;

-- Вопросы по разделам (lang: uvs, du, gks, su) и уровням (1-3)
CREATE TABLE IF NOT EXISTS questions (
  id SERIAL PRIMARY KEY,
  content_theme VARCHAR(50) DEFAULT 'vsrb-charters-v1',
  lang VARCHAR(10) NOT NULL,
  level SMALLINT NOT NULL CHECK (level >= 1 AND level <= 3),
  type VARCHAR(20) NOT NULL CHECK (type IN ('word', 'sentence')),
  word VARCHAR(500),
  translation VARCHAR(500),
  wrong1 VARCHAR(500),
  wrong2 VARCHAR(500),
  wrong3 VARCHAR(500),
  sentence TEXT,
  correct VARCHAR(500),
  explanation TEXT,
  article_ref VARCHAR(200),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE questions ADD COLUMN IF NOT EXISTS explanation TEXT;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS article_ref VARCHAR(200);

CREATE INDEX IF NOT EXISTS idx_questions_lang_level ON questions(lang, level);

-- VIEW: Вопросы структурированно (раздел, уровень, тип, термин, определение, варианты)
CREATE OR REPLACE VIEW v_questions AS
  SELECT id, lang AS section, level, type,
    COALESCE(word, sentence) AS term,
    translation AS definition,
    correct, wrong1, wrong2, wrong3,
    created_at
  FROM questions ORDER BY lang, level, id;

-- Очки за уроки
CREATE TABLE IF NOT EXISTS scores (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scores_user ON scores(user_id);

-- VIEW: Очки с логином пользователя
CREATE OR REPLACE VIEW v_scores AS
  SELECT s.id, u.email AS login, u.username, s.score, s.created_at
  FROM scores s JOIN users u ON u.id = s.user_id
  ORDER BY s.created_at DESC;

-- Суммарные XP
CREATE TABLE IF NOT EXISTS user_points (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_xp INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- VIEW: Рейтинг по XP
CREATE OR REPLACE VIEW v_user_points AS
  SELECT u.id, u.email AS login, u.username, COALESCE(up.total_xp, 0) AS total_xp, up.updated_at
  FROM users u LEFT JOIN user_points up ON up.user_id = u.id
  ORDER BY total_xp DESC;

-- Состояние игры
CREATE TABLE IF NOT EXISTS user_states (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Профили по разделам
CREATE TABLE IF NOT EXISTS user_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lang VARCHAR(10) NOT NULL,
  placement_level SMALLINT DEFAULT 1,
  mastery_by_level JSONB DEFAULT '{"1":0,"2":0,"3":0}',
  mastery_by_lesson JSONB DEFAULT '{}',
  lessons_completed INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, lang)
);

-- VIEW: Профили с логином
CREATE OR REPLACE VIEW v_user_profiles AS
  SELECT p.id, u.email AS login, p.lang AS section, p.placement_level, p.mastery_by_level, p.mastery_by_lesson, p.lessons_completed, p.updated_at
  FROM user_profiles p JOIN users u ON u.id = p.user_id
  ORDER BY u.email, p.lang;

-- Попытки уроков
CREATE TABLE IF NOT EXISTS lesson_attempts (
  id VARCHAR(100) PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL,
  lang VARCHAR(10) NOT NULL,
  level SMALLINT NOT NULL,
  lesson_slot SMALLINT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  answered_count INTEGER DEFAULT 0,
  correct_count INTEGER DEFAULT 0,
  hearts_lost INTEGER DEFAULT 0,
  xp_awarded INTEGER DEFAULT 0,
  exercises JSONB DEFAULT '[]',
  answers JSONB DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_lesson_attempts_user ON lesson_attempts(user_id);

-- Входное тестирование
CREATE TABLE IF NOT EXISTS placement_attempts (
  id VARCHAR(100) PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lang VARCHAR(10) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  questions JSONB DEFAULT '[]',
  result JSONB
);

-- Очередь повторения
CREATE TABLE IF NOT EXISTS review_queue (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ежедневные задачи
CREATE TABLE IF NOT EXISTS daily_quests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_key VARCHAR(10) NOT NULL,
  quests JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, day_key)
);

-- События аналитики
CREATE TABLE IF NOT EXISTS analytics_events (
  id VARCHAR(100) PRIMARY KEY,
  user_id INTEGER,
  event_name VARCHAR(100) NOT NULL,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at);

-- Админ: загрузка лекций и связь с вопросами
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS lesson_materials (
  id SERIAL PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  lang VARCHAR(10) NOT NULL,
  level SMALLINT NOT NULL,
  original_filename VARCHAR(500),
  mime VARCHAR(200),
  storage_path TEXT,
  text_preview TEXT,
  text_length INT DEFAULT 0,
  question_count INT DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE questions ADD COLUMN IF NOT EXISTS lesson_material_id INTEGER REFERENCES lesson_materials(id) ON DELETE SET NULL;
