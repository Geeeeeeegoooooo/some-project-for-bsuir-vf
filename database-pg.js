const { pool } = require('./db/pool');
const ALL_QUESTIONS = require('./questions-data');
const { createInitialGameState } = require('./lesson-engine');

function toDayKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function sqlToPg(sql, args) {
  let i = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++i}`);
  return [pgSql, args];
}

const db = {
  async run(sql, params = []) {
    const client = await pool.connect();
    try {
      const [pgSql, pgParams] = Array.isArray(params) && params.length ? sqlToPg(sql, params) : [sql, []];
      const res = await client.query(pgSql, pgParams);
      return res;
    } finally {
      client.release();
    }
  },
  async get(sql, params = []) {
    const res = await this.run(sql, params);
    return res.rows[0] || null;
  },
  async all(sql, params = []) {
    const res = await this.run(sql, params);
    return res.rows || [];
  },
  prepare(sql) {
    return {
      run: (...args) => db.run(sql, args),
      get: (...args) => db.get(sql, args),
      all: (...args) => db.all(sql, args),
    };
  },
  async insertUser(email, passwordHash, passwordPlain, username) {
    await this.run(
      'INSERT INTO users (email, password, password_plain, username) VALUES ($1, $2, $3, $4)',
      [email, passwordHash, passwordPlain || null, username]
    );
  },
};

async function getQuestions(lang, level) {
  const levelNum = Number(level) || 1;
  let rows;
  try {
    rows = await db.all(
      'SELECT id, content_theme, lang, level, type, word, translation, wrong1, wrong2, wrong3, sentence, correct, explanation, article_ref FROM questions WHERE lang = $1 AND level = $2',
      [lang, levelNum]
    );
  } catch (e) {
    rows = await db.all(
      'SELECT id, content_theme, lang, level, type, word, translation, wrong1, wrong2, wrong3, sentence, correct FROM questions WHERE lang = $1 AND level = $2',
      [lang, levelNum]
    );
  }
  return rows.map(r => ({ ...r, level: Number(r.level), explanation: r.explanation ?? null, article_ref: r.article_ref ?? null }));
}

async function getMixedQuestionsForPlacement(lang, count = 6) {
  const [l1, l2, l3] = await Promise.all([
    getQuestions(lang, 1),
    getQuestions(lang, 2),
    getQuestions(lang, 3),
  ]);
  const all = [...l1, ...l2, ...l3].sort(() => Math.random() - 0.5);
  return all.slice(0, Math.min(count, all.length));
}

async function getUserGameState(userId) {
  const row = await db.get('SELECT state FROM user_states WHERE user_id = $1', [userId]);
  if (row && row.state) return { ...createInitialGameState(), ...row.state };
  const state = createInitialGameState();
  await db.run(
    'INSERT INTO user_states (user_id, state) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING',
    [userId, JSON.stringify(state)]
  );
  return state;
}

async function updateUserGameState(userId, updater) {
  const current = await getUserGameState(userId);
  const next = updater({ ...current }) || current;
  await db.run(
    'INSERT INTO user_states (user_id, state, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (user_id) DO UPDATE SET state = $2, updated_at = NOW()',
    [userId, JSON.stringify(next)]
  );
  return next;
}

async function createLessonAttempt(userId, payload) {
  const id = `les-${userId}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const slot = Math.max(0, Math.min(99, Number(payload.lesson_slot) || 0));
  const attempt = {
    id,
    user_id: userId,
    status: 'in_progress',
    lang: payload.lang,
    level: payload.level,
    lesson_slot: slot,
    started_at: new Date().toISOString(),
    completed_at: null,
    answered_count: 0,
    correct_count: 0,
    hearts_lost: 0,
    xp_awarded: 0,
    exercises: payload.exercises || [],
    answers: [],
  };
  await db.run(
    `INSERT INTO lesson_attempts (id, user_id, status, lang, level, lesson_slot, exercises, answers)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, userId, 'in_progress', payload.lang, payload.level, slot, JSON.stringify(attempt.exercises), JSON.stringify([])]
  );
  return attempt;
}

async function getLessonAttempt(userId, attemptId) {
  const row = await db.get('SELECT * FROM lesson_attempts WHERE id = $1 AND user_id = $2', [attemptId, userId]);
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    status: row.status,
    lang: row.lang,
    level: row.level,
    lesson_slot: row.lesson_slot != null ? Number(row.lesson_slot) : 0,
    started_at: row.started_at,
    completed_at: row.completed_at,
    answered_count: row.answered_count || 0,
    correct_count: row.correct_count || 0,
    hearts_lost: row.hearts_lost || 0,
    xp_awarded: row.xp_awarded || 0,
    exercises: row.exercises || [],
    answers: row.answers || [],
  };
}

async function updateLessonAttempt(userId, attemptId, updater) {
  const current = await getLessonAttempt(userId, attemptId);
  if (!current) return null;
  const next = updater({ ...current }) || current;
  await db.run(
    `UPDATE lesson_attempts SET status = $1, completed_at = $2, answered_count = $3, correct_count = $4, hearts_lost = $5, xp_awarded = $6, answers = $7 WHERE id = $8 AND user_id = $9`,
    [
      next.status,
      next.completed_at,
      next.answered_count,
      next.correct_count,
      next.hearts_lost,
      next.xp_awarded || 0,
      JSON.stringify(next.answers || []),
      attemptId,
      userId,
    ]
  );
  return next;
}

async function listDueReviewExercises(userId, limit = 10) {
  const rows = await db.all(
    'SELECT id, payload FROM review_queue WHERE user_id = $1 AND due_at <= NOW() ORDER BY due_at LIMIT $2',
    [userId, limit]
  );
  return rows.map(r => ({ ...r.payload, id: r.id }));
}

async function enqueueReviewItem(item) {
  await db.run(
    'INSERT INTO review_queue (user_id, payload, due_at) VALUES ($1, $2, $3)',
    [item.user_id, JSON.stringify(item), item.due_at]
  );
}

async function appendAnalyticsEvent(event) {
  const id = `ev-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  await db.run(
    'INSERT INTO analytics_events (id, user_id, event_name, payload) VALUES ($1, $2, $3, $4)',
    [id, event.user_id || null, event.event_name, JSON.stringify(event.payload || {})]
  );
}

const LEARNING_PATH_TEMPLATES = {
  uvs: {
    unitTitle: 'УВС: внутренняя служба',
    skills: [
      'Распорядок и размещение',
      'Обязанности и подчиненность',
      'Практика по статьям УВС',
    ],
  },
  du: {
    unitTitle: 'ДУ: воинская дисциплина',
    skills: [
      'Основы дисциплинарного устава',
      'Поощрения и взыскания',
      'Разбор дисциплинарных ситуаций',
    ],
  },
  gks: {
    unitTitle: 'УГиКС: гарнизон и караул',
    skills: [
      'Караульная служба: базовый блок',
      'Посты, смены, обязанности часового',
      'Сложные сценарии караульной службы',
    ],
  },
  su: {
    unitTitle: 'СУ: строевая подготовка',
    skills: [
      'Строевые элементы и команды',
      'Действия в составе подразделения',
      'Ситуационные задачи по строю',
    ],
  },
};

async function buildLearningPath(lang) {
  const template = LEARNING_PATH_TEMPLATES[lang] || {
    unitTitle: 'Нормы и порядок службы',
    skills: ['Базовые положения', 'Обязанности и дисциплина', 'Ситуационные задачи'],
  };
  return [
    {
      unit_id: `${lang}-unit-1`,
      title: template.unitTitle,
      order: 1,
      skills: [
        { skill_id: `${lang}-skill-1`, title: template.skills[0], level: 1, locked: false, mastery: 0, lessons: 20 },
        { skill_id: `${lang}-skill-2`, title: template.skills[1], level: 2, locked: false, mastery: 0, lessons: 20 },
        { skill_id: `${lang}-skill-3`, title: template.skills[2], level: 3, locked: false, mastery: 0, lessons: 20 },
      ],
    },
  ];
}

async function getUserProfile(userId, lang) {
  const row = await db.get(
    'SELECT placement_level, mastery_by_level, mastery_by_lesson, lessons_completed FROM user_profiles WHERE user_id = $1 AND lang = $2',
    [userId, lang]
  );
  if (row) {
    return {
      placement_level: row.placement_level,
      mastery_by_level: row.mastery_by_level || { 1: 0, 2: 0, 3: 0 },
      mastery_by_lesson: row.mastery_by_lesson && typeof row.mastery_by_lesson === 'object' ? row.mastery_by_lesson : {},
      lessons_completed: row.lessons_completed || 0,
    };
  }
  await db.run(
    'INSERT INTO user_profiles (user_id, lang) VALUES ($1, $2) ON CONFLICT (user_id, lang) DO NOTHING',
    [userId, lang]
  );
  return {
    placement_level: 1,
    mastery_by_level: { 1: 0, 2: 0, 3: 0 },
    mastery_by_lesson: {},
    lessons_completed: 0,
  };
}

async function updateUserProfile(userId, lang, updater) {
  let current = await getUserProfile(userId, lang);
  const next = updater({ ...current }) || current;
  await db.run(
    `INSERT INTO user_profiles (user_id, lang, placement_level, mastery_by_level, mastery_by_lesson, lessons_completed, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (user_id, lang) DO UPDATE SET
       placement_level = $3, mastery_by_level = $4, mastery_by_lesson = $5, lessons_completed = $6, updated_at = NOW()`,
    [
      userId,
      lang,
      next.placement_level,
      JSON.stringify(next.mastery_by_level || {}),
      JSON.stringify(next.mastery_by_lesson && typeof next.mastery_by_lesson === 'object' ? next.mastery_by_lesson : {}),
      next.lessons_completed || 0,
    ]
  );
  return next;
}

async function createPlacementAttempt(userId, lang, questions) {
  const id = `pl-${userId}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const qList = questions.map((q, i) => {
    const options = q.type === 'sentence'
      ? [q.correct, q.wrong1, q.wrong2, q.wrong3].sort(() => Math.random() - 0.5)
      : [q.translation, q.wrong1, q.wrong2, q.wrong3].sort(() => Math.random() - 0.5);
    return {
      idx: i,
      id: q.id,
      level: q.level,
      type: q.type,
      prompt: q.type === 'sentence' ? q.sentence : q.word,
      correct: q.type === 'sentence' ? q.correct : q.translation,
      options,
    };
  });
  await db.run(
    'INSERT INTO placement_attempts (id, user_id, lang, questions) VALUES ($1, $2, $3, $4)',
    [id, userId, lang, JSON.stringify(qList)]
  );
  return { id, user_id: userId, lang, created_at: new Date().toISOString(), completed_at: null, questions: qList };
}

async function getPlacementAttempt(userId, attemptId) {
  const row = await db.get('SELECT * FROM placement_attempts WHERE id = $1 AND user_id = $2', [attemptId, userId]);
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    lang: row.lang,
    created_at: row.created_at,
    completed_at: row.completed_at,
    questions: row.questions || [],
    result: row.result,
  };
}

async function completePlacementAttempt(userId, attemptId, answers) {
  const attempt = await getPlacementAttempt(userId, attemptId);
  if (!attempt || attempt.completed_at) return attempt;
  let weightedScore = 0, weightedMax = 0;
  const details = (attempt.questions || []).map(q => {
    const ans = answers.find(a => Number(a.idx) === Number(q.idx));
    const isCorrect = ans && ans.answer === q.correct;
    weightedMax += q.level;
    if (isCorrect) weightedScore += q.level;
    return { idx: q.idx, level: q.level, is_correct: Boolean(isCorrect) };
  });
  const ratio = weightedMax > 0 ? weightedScore / weightedMax : 0;
  const recommendedLevel = ratio >= 0.75 ? 3 : ratio >= 0.45 ? 2 : 1;
  const result = { weighted_score: weightedScore, weighted_max: weightedMax, ratio, recommended_level: recommendedLevel, details };
  await db.run(
    'UPDATE placement_attempts SET completed_at = NOW(), result = $1 WHERE id = $2 AND user_id = $3',
    [JSON.stringify(result), attemptId, userId]
  );
  return { ...attempt, completed_at: new Date().toISOString(), result };
}

const defaultQuests = () => [
  { id: 'q-lessons-3', type: 'lessons_completed', target: 3, progress: 0, claimed: false },
  { id: 'q-perfect-1', type: 'perfect_lessons', target: 1, progress: 0, claimed: false },
  { id: 'q-xp-120', type: 'xp_earned', target: 120, progress: 0, claimed: false },
  { id: 'q-answers-25', type: 'answers_given', target: 25, progress: 0, claimed: false },
  { id: 'q-correct-15', type: 'correct_answers', target: 15, progress: 0, claimed: false },
  { id: 'q-streak-8', type: 'question_streak', target: 8, progress: 0, claimed: false },
];

const QUEST_VARIANTS = {
  uvs: [
    { type: 'answers_given', target: 20, title: 'УВС: дайте 20 ответов' },
    { type: 'correct_answers', target: 14, title: 'УВС: дайте 14 правильных ответов' },
    { type: 'question_streak', target: 8, title: 'УВС: сделайте стрик 8 правильных ответов' },
    { type: 'perfect_lessons', target: 1, title: 'УВС: пройдите 1 занятие без ошибок' },
    { type: 'lessons_completed', target: 2, title: 'УВС: завершите 2 занятия' },
    { type: 'xp_earned', target: 90, title: 'УВС: наберите 90 XP' },
  ],
  du: [
    { type: 'answers_given', target: 24, title: 'ДУ: дайте 24 ответа' },
    { type: 'correct_answers', target: 16, title: 'ДУ: дайте 16 правильных ответов' },
    { type: 'question_streak', target: 10, title: 'ДУ: сделайте стрик 10 правильных ответов' },
    { type: 'perfect_lessons', target: 1, title: 'ДУ: пройдите 1 занятие без ошибок' },
    { type: 'lessons_completed', target: 3, title: 'ДУ: завершите 3 занятия' },
    { type: 'xp_earned', target: 120, title: 'ДУ: наберите 120 XP' },
  ],
  gks: [
    { type: 'answers_given', target: 18, title: 'УГиКС: дайте 18 ответов' },
    { type: 'correct_answers', target: 12, title: 'УГиКС: дайте 12 правильных ответов' },
    { type: 'question_streak', target: 7, title: 'УГиКС: сделайте стрик 7 правильных ответов' },
    { type: 'perfect_lessons', target: 1, title: 'УГиКС: пройдите 1 занятие без ошибок' },
    { type: 'lessons_completed', target: 2, title: 'УГиКС: завершите 2 занятия' },
    { type: 'xp_earned', target: 100, title: 'УГиКС: наберите 100 XP' },
  ],
  su: [
    { type: 'answers_given', target: 22, title: 'СУ: дайте 22 ответа' },
    { type: 'correct_answers', target: 15, title: 'СУ: дайте 15 правильных ответов' },
    { type: 'question_streak', target: 9, title: 'СУ: сделайте стрик 9 правильных ответов' },
    { type: 'perfect_lessons', target: 1, title: 'СУ: пройдите 1 занятие без ошибок' },
    { type: 'lessons_completed', target: 3, title: 'СУ: завершите 3 занятия' },
    { type: 'xp_earned', target: 110, title: 'СУ: наберите 110 XP' },
  ],
};

function daySeed(dayKey = toDayKey()) {
  return String(dayKey || '')
    .split('')
    .reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
}

function buildDailyQuestsByLang(lang = 'uvs', dayKey = toDayKey()) {
  const normalizedLang = QUEST_VARIANTS[lang] ? lang : 'uvs';
  const pool = QUEST_VARIANTS[normalizedLang];
  const seed = daySeed(dayKey) + daySeed(normalizedLang);
  const offset = seed % pool.length;
  const rotated = pool.slice(offset).concat(pool.slice(0, offset));
  const selected = rotated.slice(0, 4);
  return selected.map((q, i) => ({
    id: `q-${normalizedLang}-${dayKey}-${q.type}-${i}`,
    type: q.type,
    target: q.target,
    progress: 0,
    claimed: false,
    lang: normalizedLang,
    title: q.title,
  }));
}

async function getDailyQuests(userId, lang = 'uvs') {
  const day = toDayKey();
  const row = await db.get('SELECT quests FROM daily_quests WHERE user_id = $1 AND day_key = $2', [userId, day]);
  const normalizedLang = QUEST_VARIANTS[lang] ? lang : 'uvs';
  if (row && row.quests) {
    if (Array.isArray(row.quests)) {
      // Legacy format migration
      const migrated = {
        uvs: buildDailyQuestsByLang('uvs', day),
        du: buildDailyQuestsByLang('du', day),
        gks: buildDailyQuestsByLang('gks', day),
        su: buildDailyQuestsByLang('su', day),
      };
      await db.run(
        'INSERT INTO daily_quests (user_id, day_key, quests) VALUES ($1, $2, $3) ON CONFLICT (user_id, day_key) DO UPDATE SET quests = $3, updated_at = NOW()',
        [userId, day, JSON.stringify(migrated)]
      );
      return migrated[normalizedLang];
    }
    if (Array.isArray(row.quests[normalizedLang])) return row.quests[normalizedLang];
    const expanded = {
      ...row.quests,
      [normalizedLang]: buildDailyQuestsByLang(normalizedLang, day),
    };
    await db.run(
      'INSERT INTO daily_quests (user_id, day_key, quests) VALUES ($1, $2, $3) ON CONFLICT (user_id, day_key) DO UPDATE SET quests = $3, updated_at = NOW()',
      [userId, day, JSON.stringify(expanded)]
    );
    return expanded[normalizedLang];
  }
  const quests = {
    uvs: buildDailyQuestsByLang('uvs', day),
    du: buildDailyQuestsByLang('du', day),
    gks: buildDailyQuestsByLang('gks', day),
    su: buildDailyQuestsByLang('su', day),
  };
  await db.run(
    'INSERT INTO daily_quests (user_id, day_key, quests) VALUES ($1, $2, $3) ON CONFLICT (user_id, day_key) DO UPDATE SET quests = $3, updated_at = NOW()',
    [userId, day, JSON.stringify(quests)]
  );
  return quests[normalizedLang];
}

async function updateDailyQuests(userId, lang = 'uvs', updater) {
  const normalizedLang = QUEST_VARIANTS[lang] ? lang : 'uvs';
  const current = await getDailyQuests(userId, normalizedLang);
  const next = updater(current.map(x => ({ ...x }))) || current;
  const day = toDayKey();
  const row = await db.get('SELECT quests FROM daily_quests WHERE user_id = $1 AND day_key = $2', [userId, day]);
  const all = row?.quests && !Array.isArray(row.quests)
    ? row.quests
    : {
      uvs: buildDailyQuestsByLang('uvs', day),
      du: buildDailyQuestsByLang('du', day),
      gks: buildDailyQuestsByLang('gks', day),
      su: buildDailyQuestsByLang('su', day),
    };
  all[normalizedLang] = next;
  await db.run(
    'INSERT INTO daily_quests (user_id, day_key, quests, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id, day_key) DO UPDATE SET quests = $3, updated_at = NOW()',
    [userId, day, JSON.stringify(all)]
  );
  return next;
}

async function addScore(userId, score) {
  await db.run('INSERT INTO scores (user_id, score) VALUES ($1, $2)', [userId, score]);
}

async function addUserXp(userId, xp) {
  await db.run(
    `INSERT INTO user_points (user_id, total_xp, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET total_xp = user_points.total_xp + $2, updated_at = NOW()`,
    [userId, xp]
  );
}

async function getLeaderboard(limit = 20) {
  const rows = await db.all(
    `SELECT u.username, COALESCE(up.total_xp, 0) AS total_xp, up.updated_at, us.state AS user_state
     FROM users u
     LEFT JOIN user_points up ON up.user_id = u.id
     LEFT JOIN user_states us ON us.user_id = u.id
     ORDER BY COALESCE(up.total_xp, 0) DESC
     LIMIT $1`,
    [limit]
  );
  return rows.map((r) => {
    let avatarUrl = null;
    if (r.user_state) {
      try {
        const state = typeof r.user_state === 'string' ? JSON.parse(r.user_state) : r.user_state;
        avatarUrl = state?.avatar_url || null;
      } catch {
        avatarUrl = null;
      }
    }
    return {
      username: r.username,
      score: Number(r.total_xp),
      created_at: r.updated_at,
      avatar_url: avatarUrl,
    };
  });
}

async function getMyBest(userId) {
  const row = await db.get('SELECT total_xp FROM user_points WHERE user_id = $1', [userId]);
  return { best: row ? Number(row.total_xp) : 0 };
}

async function updateUserPassword(userId, passwordHash) {
  await db.run(
    'UPDATE users SET password = $1, password_plain = NULL WHERE id = $2',
    [passwordHash, userId]
  );
  return true;
}

async function ensureUserProgressSchema() {
  try {
    await db.run("ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS mastery_by_lesson JSONB DEFAULT '{}'::jsonb");
    await db.run('ALTER TABLE lesson_attempts ADD COLUMN IF NOT EXISTS lesson_slot SMALLINT NOT NULL DEFAULT 0');
  } catch (e) {
    console.warn('ensureUserProgressSchema:', e.message || e);
  }
}

async function ensureLessonAdminSchema() {
  await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE');
  await db.run("UPDATE users SET is_admin = TRUE WHERE LOWER(TRIM(email)) = 'admin@test.com'");
  await db.run(`
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
    )
  `);
  await db.run('ALTER TABLE questions ADD COLUMN IF NOT EXISTS lesson_material_id INTEGER');
}

function adminEmailList() {
  const raw = process.env.ADMIN_EMAILS;
  const src = raw != null && String(raw).trim() !== '' ? String(raw) : 'admin@test.com';
  return src
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function isUserAdmin(userId) {
  let row;
  try {
    row = await db.get(
      'SELECT email, COALESCE(is_admin, false) AS is_admin FROM users WHERE id = $1',
      [userId]
    );
  } catch {
    row = await db.get('SELECT email FROM users WHERE id = $1', [userId]);
  }
  if (!row) return false;
  if (row.is_admin) return true;
  return adminEmailList().includes(String(row.email || '').toLowerCase());
}

async function listLessonMaterials(limit = 50) {
  try {
    const rows = await db.all(
      'SELECT id, title, lang, level, original_filename, mime, text_length, question_count, created_at, created_by FROM lesson_materials ORDER BY id DESC LIMIT $1',
      [limit]
    );
    return rows || [];
  } catch {
    return [];
  }
}

async function importLessonBundle(userId, bundle) {
  const client = await pool.connect();
  try {
    const ins = await client.query(
      `INSERT INTO lesson_materials (title, lang, level, original_filename, mime, storage_path, text_preview, text_length, question_count, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        bundle.title,
        bundle.lang,
        bundle.level,
        bundle.original_filename,
        bundle.mime,
        bundle.storage_path,
        String(bundle.extracted_text || '').slice(0, 800),
        String(bundle.extracted_text || '').length,
        bundle.questions.length,
        userId,
      ]
    );
    const mid = ins.rows[0].id;
    for (const q of bundle.questions) {
      await client.query(
        `INSERT INTO questions (content_theme, lang, level, type, word, translation, wrong1, wrong2, wrong3, sentence, correct, explanation, article_ref, lesson_material_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          q.content_theme || 'lesson-import-v1',
          q.lang,
          q.level,
          q.type,
          q.word || null,
          q.translation || null,
          q.wrong1 || null,
          q.wrong2 || null,
          q.wrong3 || null,
          q.sentence || null,
          q.correct || null,
          q.explanation || null,
          q.article_ref || null,
          mid,
        ]
      );
    }
    return { material_id: mid, questions_added: bundle.questions.length };
  } finally {
    client.release();
  }
}

async function initDb() {
  await ensureUserProgressSchema();
  await ensureLessonAdminSchema();
  const count = await db.get('SELECT COUNT(*) as c FROM users');
  if (count && Number(count.c) === 0) {
    const bcrypt = require('bcryptjs');
    await db.run(
      'INSERT INTO users (email, password, username, is_admin) VALUES ($1, $2, $3, TRUE)',
      ['admin@test.com', bcrypt.hashSync('admin123', 10), 'Admin']
    );
  }
  const qCount = await db.get('SELECT COUNT(*) as c FROM questions');
  if (qCount && Number(qCount.c) < 20) {
    const client = await pool.connect();
    try {
      for (const q of ALL_QUESTIONS) {
        await client.query(
          `INSERT INTO questions (content_theme, lang, level, type, word, translation, wrong1, wrong2, wrong3, sentence, correct)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            q.content_theme || 'vsrb-charters-v1',
            q.lang,
            q.level,
            q.type,
            q.word || null,
            q.translation || null,
            q.wrong1 || null,
            q.wrong2 || null,
            q.wrong3 || null,
            q.sentence || null,
            q.correct || null,
          ]
        );
      }
    } finally {
      client.release();
    }
  }
}

module.exports = {
  db,
  initDb,
  isUserAdmin,
  listLessonMaterials,
  importLessonBundle,
  getQuestions,
  getUserGameState,
  updateUserGameState,
  createLessonAttempt,
  getLessonAttempt,
  updateLessonAttempt,
  listDueReviewExercises,
  enqueueReviewItem,
  appendAnalyticsEvent,
  buildLearningPath,
  getMixedQuestionsForPlacement,
  getUserProfile,
  updateUserProfile,
  createPlacementAttempt,
  getPlacementAttempt,
  completePlacementAttempt,
  getDailyQuests,
  updateDailyQuests,
  addScore,
  addUserXp,
  getLeaderboard,
  getMyBest,
  updateUserPassword,
};
