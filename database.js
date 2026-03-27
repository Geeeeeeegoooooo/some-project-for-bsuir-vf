const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const ALL_QUESTIONS = require('./questions-data');
const { createInitialGameState } = require('./lesson-engine');

const DB_PATH = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, 'data.json');

function loadDb() {
  try {
    const data = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch {
    return { users: [], scores: [], questions: ALL_QUESTIONS };
  }
}

function saveDb(data) {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function ensureGameState(data, userId) {
  if (!data.user_states) data.user_states = {};
  if (!data.user_states[userId]) {
    data.user_states[userId] = createInitialGameState();
  }
  return data.user_states[userId];
}

function ensureUserProfiles(data) {
  if (!data.user_profiles) data.user_profiles = {};
  return data.user_profiles;
}

function ensureDailyQuests(data) {
  if (!data.daily_quests) data.daily_quests = {};
  return data.daily_quests;
}

function ensureUserPoints(data) {
  if (!data.user_points) data.user_points = {};
  return data.user_points;
}

function toDayKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function daySeed(dayKey = toDayKey()) {
  return String(dayKey || '')
    .split('')
    .reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
}

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

const db = {
  prepare(sql) {
    return {
      run(...args) {
        const data = loadDb();
        const match = sql.match(/INSERT INTO (\w+)/);
        if (match) {
          const table = match[1];
          if (table === 'users') {
            const id = (data.users[data.users.length - 1]?.id || 0) + 1;
            data.users.push({
              id,
              email: args[0],
              password: args[1],
              username: args[2],
              created_at: new Date().toISOString()
            });
          } else if (table === 'scores') {
            const id = (data.scores[data.scores.length - 1]?.id || 0) + 1;
            data.scores.push({
              id,
              user_id: args[0],
              score: args[1],
              created_at: new Date().toISOString()
            });
          }
          saveDb(data);
        }
        return {};
      },
      get(...args) {
        const data = loadDb();
        if (sql.includes('COUNT(*)') && sql.includes('users')) {
          return { c: data.users.length };
        }
        if (sql.includes('FROM users WHERE email')) {
          return data.users.find(u => u.email === args[0]) || null;
        }
        if (sql.includes('FROM users WHERE id')) {
          return data.users.find(u => u.id === args[0]) || null;
        }
        if (sql.includes('MAX(score)') && sql.includes('scores')) {
          const userScores = data.scores.filter(s => s.user_id === args[0]);
          const best = userScores.length ? Math.max(...userScores.map(s => s.score)) : 0;
          return { best };
        }
        return null;
      },
      all() {
        const data = loadDb();
        if (sql.includes('FROM scores') && sql.includes('JOIN users')) {
          return data.scores
            .map(s => {
              const u = data.users.find(us => us.id === s.user_id);
              return u ? { username: u.username, score: s.score, created_at: s.created_at } : null;
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score)
            .slice(0, 20);
        }
        return [];
      }
    };
  },
  exec() {}
};

function getQuestions(lang, level) {
  const data = loadDb();
  const levelNum = Number(level) || 1;
  let questions = data.questions;
  if (!questions || questions.length === 0 || questions[0]?.level == null) {
    questions = ALL_QUESTIONS;
  }
  return questions.filter(q => q.lang === lang && Number(q.level) === levelNum);
}

function getMixedQuestionsForPlacement(lang, count = 6) {
  const all = getQuestions(lang, 1)
    .concat(getQuestions(lang, 2))
    .concat(getQuestions(lang, 3))
    .sort(() => Math.random() - 0.5);
  return all.slice(0, Math.min(count, all.length));
}

function getUserGameState(userId) {
  const data = loadDb();
  const state = ensureGameState(data, userId);
  saveDb(data);
  return state;
}

function updateUserGameState(userId, updater) {
  const data = loadDb();
  const current = ensureGameState(data, userId);
  const next = updater({ ...current }) || current;
  data.user_states[userId] = next;
  saveDb(data);
  return next;
}

function createLessonAttempt(userId, payload) {
  const data = loadDb();
  if (!data.lesson_attempts) data.lesson_attempts = [];
  const id = `${userId}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const attempt = {
    id,
    user_id: userId,
    status: 'in_progress',
    lang: payload.lang,
    level: payload.level,
    lesson_slot: Math.max(0, Math.min(99, Number(payload.lesson_slot) || 0)),
    started_at: new Date().toISOString(),
    completed_at: null,
    answered_count: 0,
    correct_count: 0,
    hearts_lost: 0,
    xp_awarded: 0,
    exercises: payload.exercises || [],
    answers: [],
  };
  data.lesson_attempts.push(attempt);
  saveDb(data);
  return attempt;
}

function getLessonAttempt(userId, attemptId) {
  const data = loadDb();
  return (data.lesson_attempts || []).find(
    (x) => x.id === attemptId && x.user_id === userId
  ) || null;
}

function updateLessonAttempt(userId, attemptId, updater) {
  const data = loadDb();
  if (!data.lesson_attempts) data.lesson_attempts = [];
  const idx = data.lesson_attempts.findIndex(
    (x) => x.id === attemptId && x.user_id === userId
  );
  if (idx === -1) return null;
  const current = data.lesson_attempts[idx];
  const next = updater({ ...current }) || current;
  data.lesson_attempts[idx] = next;
  saveDb(data);
  return next;
}

function listDueReviewExercises(userId, limit = 10) {
  const data = loadDb();
  const now = Date.now();
  const queue = (data.review_queue || [])
    .filter((x) => x.user_id === userId && new Date(x.due_at).getTime() <= now)
    .sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime())
    .slice(0, limit);
  return queue;
}

function enqueueReviewItem(item) {
  const data = loadDb();
  if (!data.review_queue) data.review_queue = [];
  data.review_queue.push(item);
  saveDb(data);
}

function appendAnalyticsEvent(event) {
  const data = loadDb();
  if (!data.analytics_events) data.analytics_events = [];
  data.analytics_events.push({
    id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    created_at: new Date().toISOString(),
    ...event,
  });
  saveDb(data);
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

function buildLearningPath(lang) {
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
        {
          skill_id: `${lang}-skill-1`,
          title: template.skills[0],
          level: 1,
          locked: false,
          mastery: 0,
          lessons: 20,
        },
        {
          skill_id: `${lang}-skill-2`,
          title: template.skills[1],
          level: 2,
          locked: false,
          mastery: 0,
          lessons: 20,
        },
        {
          skill_id: `${lang}-skill-3`,
          title: template.skills[2],
          level: 3,
          locked: false,
          mastery: 0,
          lessons: 20,
        },
      ],
    },
  ];
}

function getUserProfile(userId, lang) {
  const data = loadDb();
  const profiles = ensureUserProfiles(data);
  if (!profiles[userId]) profiles[userId] = {};
  if (!profiles[userId][lang]) {
    profiles[userId][lang] = {
      placement_level: 1,
      mastery_by_level: { 1: 0, 2: 0, 3: 0 },
      mastery_by_lesson: {},
      lessons_completed: 0,
    };
  }
  if (!profiles[userId][lang].mastery_by_lesson || typeof profiles[userId][lang].mastery_by_lesson !== 'object') {
    profiles[userId][lang].mastery_by_lesson = {};
  }
  saveDb(data);
  return profiles[userId][lang];
}

function updateUserProfile(userId, lang, updater) {
  const data = loadDb();
  const profiles = ensureUserProfiles(data);
  if (!profiles[userId]) profiles[userId] = {};
  if (!profiles[userId][lang]) {
    profiles[userId][lang] = {
      placement_level: 1,
      mastery_by_level: { 1: 0, 2: 0, 3: 0 },
      mastery_by_lesson: {},
      lessons_completed: 0,
    };
  }
  if (!profiles[userId][lang].mastery_by_lesson || typeof profiles[userId][lang].mastery_by_lesson !== 'object') {
    profiles[userId][lang].mastery_by_lesson = {};
  }
  const next = updater({ ...profiles[userId][lang] }) || profiles[userId][lang];
  profiles[userId][lang] = next;
  saveDb(data);
  return next;
}

function createPlacementAttempt(userId, lang, questions) {
  const data = loadDb();
  if (!data.placement_attempts) data.placement_attempts = [];
  const id = `pl-${userId}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const attempt = {
    id,
    user_id: userId,
    lang,
    created_at: new Date().toISOString(),
    completed_at: null,
    questions: questions.map((q, i) => {
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
    }),
  };
  data.placement_attempts.push(attempt);
  saveDb(data);
  return attempt;
}

function getPlacementAttempt(userId, attemptId) {
  const data = loadDb();
  return (data.placement_attempts || []).find(
    (x) => x.id === attemptId && x.user_id === userId
  ) || null;
}

function completePlacementAttempt(userId, attemptId, answers) {
  const data = loadDb();
  if (!data.placement_attempts) data.placement_attempts = [];
  const idx = data.placement_attempts.findIndex(
    (x) => x.id === attemptId && x.user_id === userId
  );
  if (idx === -1) return null;
  const attempt = data.placement_attempts[idx];
  if (attempt.completed_at) return attempt;
  let weightedScore = 0;
  let weightedMax = 0;
  const details = attempt.questions.map((q) => {
    const ans = answers.find((a) => Number(a.idx) === Number(q.idx));
    const isCorrect = ans && ans.answer === q.correct;
    weightedMax += q.level;
    if (isCorrect) weightedScore += q.level;
    return { idx: q.idx, level: q.level, is_correct: Boolean(isCorrect) };
  });
  const ratio = weightedMax > 0 ? weightedScore / weightedMax : 0;
  const recommendedLevel = ratio >= 0.75 ? 3 : ratio >= 0.45 ? 2 : 1;
  attempt.completed_at = new Date().toISOString();
  attempt.result = { weighted_score: weightedScore, weighted_max: weightedMax, ratio, recommended_level: recommendedLevel, details };
  data.placement_attempts[idx] = attempt;
  saveDb(data);
  return attempt;
}

function getDailyQuests(userId, lang = 'uvs') {
  const data = loadDb();
  const all = ensureDailyQuests(data);
  const day = toDayKey();
  const key = `${userId}:${day}`;
  const normalizedLang = QUEST_VARIANTS[lang] ? lang : 'uvs';
  const current = all[key];
  if (!current) {
    all[key] = {
      uvs: buildDailyQuestsByLang('uvs', day),
      du: buildDailyQuestsByLang('du', day),
      gks: buildDailyQuestsByLang('gks', day),
      su: buildDailyQuestsByLang('su', day),
    };
    saveDb(data);
    return all[key][normalizedLang];
  }
  if (Array.isArray(current)) {
    const migrated = {
      uvs: buildDailyQuestsByLang('uvs', day),
      du: buildDailyQuestsByLang('du', day),
      gks: buildDailyQuestsByLang('gks', day),
      su: buildDailyQuestsByLang('su', day),
    };
    all[key] = migrated;
    saveDb(data);
    return migrated[normalizedLang];
  }
  if (!Array.isArray(current[normalizedLang])) {
    current[normalizedLang] = buildDailyQuestsByLang(normalizedLang, day);
    saveDb(data);
  }
  return current[normalizedLang];
}

function updateDailyQuests(userId, lang = 'uvs', updater) {
  const data = loadDb();
  const all = ensureDailyQuests(data);
  const day = toDayKey();
  const key = `${userId}:${day}`;
  const normalizedLang = QUEST_VARIANTS[lang] ? lang : 'uvs';
  const current = getDailyQuests(userId, normalizedLang);
  const next = updater(current.map((x) => ({ ...x }))) || current;
  if (!all[key] || Array.isArray(all[key])) {
    all[key] = {
      uvs: buildDailyQuestsByLang('uvs', day),
      du: buildDailyQuestsByLang('du', day),
      gks: buildDailyQuestsByLang('gks', day),
      su: buildDailyQuestsByLang('su', day),
    };
  }
  all[key][normalizedLang] = next;
  saveDb(data);
  return next;
}

function initDb() {
  const data = loadDb();
  let changed = false;
  if (data.users.length === 0) {
    data.users.push({
      id: 1,
      email: 'admin@test.com',
      password: bcrypt.hashSync('admin123', 10),
      username: 'Admin',
      is_admin: true,
      created_at: new Date().toISOString()
    });
    changed = true;
  }
  data.users.forEach((u) => {
    if (String(u.email || '').toLowerCase() === 'admin@test.com') {
      if (!u.is_admin) {
        u.is_admin = true;
        changed = true;
      }
    }
  });
  const needsQuestions = !data.questions || data.questions.length < 20 ||
    !data.questions[0]?.level || !data.questions[0]?.type ||
    data.questions[0]?.content_theme !== 'vsrb-charters-v1';
  if (needsQuestions) {
    data.questions = ALL_QUESTIONS;
    changed = true;
  }
  if (!data.user_states) {
    data.user_states = {};
    changed = true;
  }
  if (!data.lesson_attempts) {
    data.lesson_attempts = [];
    changed = true;
  }
  if (!data.review_queue) {
    data.review_queue = [];
    changed = true;
  }
  if (!data.analytics_events) {
    data.analytics_events = [];
    changed = true;
  }
  if (!data.user_profiles) {
    data.user_profiles = {};
    changed = true;
  }
  if (!data.placement_attempts) {
    data.placement_attempts = [];
    changed = true;
  }
  if (!data.daily_quests) {
    data.daily_quests = {};
    changed = true;
  }
  if (!data.user_points) {
    data.user_points = {};
    changed = true;
  }
  if (!data.lesson_materials) {
    data.lesson_materials = [];
    changed = true;
  }
  if (changed) saveDb(data);
  return Promise.resolve();
}

function addScore(userId, score) {
  const data = loadDb();
  const id = (data.scores[data.scores.length - 1]?.id || 0) + 1;
  data.scores.push({ id, user_id: userId, score, created_at: new Date().toISOString() });
  saveDb(data);
}

function addUserXp(userId, xp) {
  const data = loadDb();
  const pts = ensureUserPoints(data);
  pts[userId] = (pts[userId] || 0) + xp;
  saveDb(data);
}

function getLeaderboard(limit = 20) {
  const data = loadDb();
  const pts = ensureUserPoints(data);
  const states = data.user_states || {};
  return data.users
    .map(u => ({
      username: u.username,
      score: pts[u.id] || 0,
      created_at: u.created_at,
      avatar_url: states[u.id]?.avatar_url || null,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function getMyBest(userId) {
  const data = loadDb();
  const pts = ensureUserPoints(data);
  return { best: pts[userId] || 0 };
}

function updateUserPassword(userId, passwordHash) {
  const data = loadDb();
  const idx = data.users.findIndex((u) => Number(u.id) === Number(userId));
  if (idx === -1) return false;
  data.users[idx].password = passwordHash;
  saveDb(data);
  return true;
}

function adminEmailList() {
  const raw = process.env.ADMIN_EMAILS;
  const src = raw != null && String(raw).trim() !== '' ? String(raw) : 'admin@test.com';
  return src
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function isUserAdmin(userId) {
  const data = loadDb();
  const u = data.users.find((x) => Number(x.id) === Number(userId));
  if (!u) return false;
  if (u.is_admin === true) return true;
  return adminEmailList().includes(String(u.email || '').toLowerCase());
}

function listLessonMaterials(limit = 50) {
  const data = loadDb();
  const list = data.lesson_materials || [];
  return [...list]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit);
}

/**
 * @param {number} userId
 * @param {{ title: string, lang: string, level: number, original_filename: string, mime: string, storage_path: string, extracted_text: string, questions: object[] }} bundle
 */
function importLessonBundle(userId, bundle) {
  const data = loadDb();
  if (!data.lesson_materials) data.lesson_materials = [];
  if (!data.questions) data.questions = [];
  const mid = (data.lesson_materials[data.lesson_materials.length - 1]?.id || 0) + 1;
  const preview = String(bundle.extracted_text || '').slice(0, 800);
  data.lesson_materials.push({
    id: mid,
    title: bundle.title,
    lang: bundle.lang,
    level: bundle.level,
    original_filename: bundle.original_filename,
    mime: bundle.mime,
    storage_path: bundle.storage_path,
    text_preview: preview,
    text_length: String(bundle.extracted_text || '').length,
    question_count: bundle.questions.length,
    created_at: new Date().toISOString(),
    created_by: userId,
  });
  let maxId = data.questions.reduce((m, q) => Math.max(m, Number(q.id) || 0), 0);
  for (const q of bundle.questions) {
    maxId += 1;
    data.questions.push({
      ...q,
      id: maxId,
      lesson_material_id: mid,
    });
  }
  saveDb(data);
  return { material_id: mid, questions_added: bundle.questions.length };
}

module.exports = {
  db,
  initDb,
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
  isUserAdmin,
  listLessonMaterials,
  importLessonBundle,
};
