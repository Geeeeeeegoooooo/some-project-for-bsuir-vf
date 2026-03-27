require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const { extractLessonText, isSupportedExtension } = require('./lesson-ingest');
const { generateQuestionsFromLessonText } = require('./lesson-question-gen');
const { buildStandaloneQuizHtml, slugifyFilename } = require('./quiz-export-html');
const dbModule = process.env.DATABASE_URL ? require('./database-pg') : require('./database');
const ALL_QUESTIONS = require('./questions-data');
const {
  narrowPoolForLessonSlot,
  computeMasteryByLevelFromLessons,
  clearQuestionCoverageForModule,
  untaggedMatchesLessonSlot,
} = require('./lesson-slot-focus.cjs');
const {
  db,
  initDb,
  getQuestions: getQuestionsDb,
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
} = dbModule;

/** Метаданные из бандла (path_slots и т.д.) — в БД при старом сиде не попадали; без них урок L1 сводится к 1–2 «совпадениям» по ключам. */
function normMergeKey(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function stableKeyForQuestionRow(row) {
  const lang = String(row.lang || 'uvs');
  const lev = Number(row.level) || 1;
  const typ = String(row.type || '').toLowerCase();
  if (typ === 'sentence') {
    return `${lang}|${lev}|s|${normMergeKey(row.sentence)}|${normMergeKey(row.correct)}`;
  }
  return `${lang}|${lev}|w|${normMergeKey(row.word)}|${normMergeKey(row.translation)}`;
}

const QUESTION_META_BY_STABLE = new Map();
const QUESTION_META_BY_ID = new Map();
for (const q of ALL_QUESTIONS) {
  QUESTION_META_BY_STABLE.set(stableKeyForQuestionRow(q), q);
  if (q.id != null) QUESTION_META_BY_ID.set(Number(q.id), q);
}

function normalizeRowPathSlots(row) {
  let ps = row.path_slots;
  if (ps == null) return { ...row, path_slots: undefined };
  if (typeof ps === 'string') {
    try {
      ps = JSON.parse(ps);
    } catch {
      return { ...row, path_slots: undefined };
    }
  }
  if (!Array.isArray(ps)) return { ...row, path_slots: undefined };
  return { ...row, path_slots: ps.map(Number).filter((n) => Number.isFinite(n)) };
}

function mergeQuestionRowWithBundle(row) {
  const base = normalizeRowPathSlots(row);
  const meta = QUESTION_META_BY_STABLE.get(stableKeyForQuestionRow(base)) || QUESTION_META_BY_ID.get(Number(base.id));
  if (!meta) return base;
  return {
    ...base,
    path_slots: meta.path_slots != null ? meta.path_slots : base.path_slots,
    exclude_slots: meta.exclude_slots != null ? meta.exclude_slots : base.exclude_slots,
    content_theme: base.content_theme || meta.content_theme,
    explanation: base.explanation ?? meta.explanation ?? null,
    article_ref: base.article_ref ?? meta.article_ref ?? null,
  };
}

async function getQuestions(lang, level) {
  const levelNum = Number(normalizeLevel(level));
  const bundleSlice = ALL_QUESTIONS.filter((q) => q.lang === lang && Number(q.level) === levelNum);
  const fromDb = await getQuestionsDb(lang, levelNum);
  if (!fromDb || fromDb.length === 0) return bundleSlice;

  const mergedDb = fromDb.map((row) => mergeQuestionRowWithBundle(row));
  const haveStable = new Set(mergedDb.map((r) => stableKeyForQuestionRow(r)));
  const extras = bundleSlice.filter((q) => !haveStable.has(stableKeyForQuestionRow(q)));
  // В БД нет новых карточек из бандла (path_slots, контекст ВС РБ и т.д.) — без extras урок остаётся на 1–2 вопросах.
  return [...mergedDb, ...extras];
}

const {
  POINTS_BY_LEVEL,
  normalizeLevel,
  lessonStateTransition,
  calcXpForLesson,
  updateStreak,
  applyAnswerToGameState,
  refillHeartByPractice,
  applyTimedHeartRefill,
} = require('./lesson-engine');

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'polyglot-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 6;
const MIN_USERNAME = 2;
const MAX_USERNAME = 30;

function validateEmail(email) {
  if (!email || typeof email !== 'string') return 'Введите email';
  const e = email.trim().toLowerCase();
  if (!e) return 'Введите email';
  if (!EMAIL_REGEX.test(e)) return 'Некорректный формат email';
  if (e.length > 254) return 'Слишком длинный email';
  return null;
}

function validatePassword(password, isRegister = false) {
  if (!password || typeof password !== 'string') return 'Введите пароль';
  if (password.length < MIN_PASSWORD) return `Пароль должен быть не менее ${MIN_PASSWORD} символов`;
  if (isRegister && !/[A-Za-z]/.test(password)) return 'Пароль должен содержать буквы';
  if (isRegister && !/[0-9]/.test(password)) return 'Пароль должен содержать цифры';
  return null;
}

function validateUsername(username) {
  if (!username || typeof username !== 'string') return 'Введите имя пользователя';
  const u = username.trim();
  if (u.length < MIN_USERNAME) return `Имя должно быть не менее ${MIN_USERNAME} символов`;
  if (u.length > MAX_USERNAME) return `Имя должно быть не более ${MAX_USERNAME} символов`;
  if (!/^[a-zA-Zа-яА-ЯёЁ0-9_\-\s]+$/.test(u)) return 'Имя может содержать только буквы, цифры, пробелы и дефис';
  return null;
}

function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  next();
}

async function requireAdmin(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  try {
    const ok = isUserAdmin ? await isUserAdmin(req.session.userId) : false;
    if (!ok) return res.status(403).json({ error: 'Нет прав администратора' });
    next();
  } catch (e) {
    next(e);
  }
}

const LESSONS_UPLOAD_DIR = path.join(__dirname, 'uploads', 'lessons');
if (!fs.existsSync(LESSONS_UPLOAD_DIR)) {
  fs.mkdirSync(LESSONS_UPLOAD_DIR, { recursive: true });
}

const lessonUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, LESSONS_UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const safe = String(file.originalname || 'file').replace(/[^a-zA-Zа-яА-ЯёЁ0-9._\- ]/g, '_');
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safe}`);
    },
  }),
  limits: { fileSize: 22 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (isSupportedExtension(file.originalname)) return cb(null, true);
    cb(new Error('Неподдерживаемый тип файла'));
  },
});

const userRateWindow = new Map();
function rateLimitLesson(req, res, next) {
  const userId = req.session?.userId;
  if (!userId) return next();
  const key = String(userId);
  const now = Date.now();
  const windowMs = 10_000;
  const maxReq = 40;
  const arr = userRateWindow.get(key) || [];
  const filtered = arr.filter((x) => now - x < windowMs);
  filtered.push(now);
  userRateWindow.set(key, filtered);
  if (filtered.length > maxReq) {
    return res.status(429).json({ error: 'Слишком много запросов. Попробуйте позже.' });
  }
  next();
}

app.post('/api/register', async (req, res, next) => {
  try {
    const { email, password, username } = req.body || {};
    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: emailErr });
    const passErr = validatePassword(password, true);
    if (passErr) return res.status(400).json({ error: passErr });
    const userErr = validateUsername(username);
    if (userErr) return res.status(400).json({ error: userErr });

    const normalizedEmail = email.trim().toLowerCase();
    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
    if (existing) return res.status(400).json({ error: 'Пользователь с таким email уже зарегистрирован' });

    const hash = bcrypt.hashSync(password, 10);
    try {
      if (db.insertUser) {
        await db.insertUser(normalizedEmail, hash, password, username.trim());
      } else {
        await db.prepare('INSERT INTO users (email, password, username) VALUES (?, ?, ?)').run(
          normalizedEmail, hash, username.trim()
        );
      }
    } catch (e) {
      if (e.message?.includes('UNIQUE') || e.code === '23505') return res.status(400).json({ error: 'Этот email уже занят' });
      throw e;
    }
    const user = await db.prepare('SELECT id, email, username FROM users WHERE email = ?').get(normalizedEmail);
    req.session.userId = user.id;
    req.session.username = user.username;
    const admin = isUserAdmin ? await isUserAdmin(user.id) : false;
    res.json({
      success: true,
      user: { id: user.id, email: user.email, username: user.username, is_admin: Boolean(admin) },
    });
  } catch (e) { next(e); }
});

app.post('/api/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: emailErr });
    if (!password) return res.status(400).json({ error: 'Введите пароль' });

    const normalizedEmail = email.trim().toLowerCase();
    const user = await db.prepare('SELECT id, email, username, password FROM users WHERE email = ?').get(normalizedEmail);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    const admin = isUserAdmin ? await isUserAdmin(user.id) : false;
    res.json({
      success: true,
      user: { id: user.id, email: user.email, username: user.username, is_admin: Boolean(admin) },
    });
  } catch (e) { next(e); }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.post('/api/change-password', requireAuth, async (req, res, next) => {
  try {
    const { oldPassword, newPassword, newPassword2 } = req.body || {};
    if (!oldPassword) return res.status(400).json({ error: 'Введите текущий пароль' });
    const passErr = validatePassword(newPassword, true);
    if (passErr) return res.status(400).json({ error: passErr });
    if (newPassword !== newPassword2) {
      return res.status(400).json({ error: 'Новые пароли не совпадают' });
    }
    if (oldPassword === newPassword) {
      return res.status(400).json({ error: 'Новый пароль должен отличаться от текущего' });
    }

    const user = await db.prepare('SELECT id, password FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (!bcrypt.compareSync(oldPassword, user.password)) {
      return res.status(401).json({ error: 'Неверный текущий пароль' });
    }

    const hash = bcrypt.hashSync(newPassword, 10);
    await updateUserPassword(req.session.userId, hash);
    return res.json({ success: true });
  } catch (e) { next(e); }
});

app.get('/api/me', async (req, res, next) => {
  try {
    if (!req.session?.userId) return res.json({ user: null });
    const user = await db.prepare('SELECT id, email, username FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.json({ user: null });
    const admin = isUserAdmin ? await isUserAdmin(req.session.userId) : false;
    res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        is_admin: Boolean(admin),
      },
    });
  } catch (e) { next(e); }
});

const POINTS = POINTS_BY_LEVEL;

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

function hashSeedString(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest().readUInt32BE(0);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleSeeded(arr, seedStr) {
  const rand = mulberry32(hashSeedString(seedStr));
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

function pickUniqueSeeded(arr, count, keyFn, excludeKeys, seedStr) {
  const out = [];
  const used = new Set(excludeKeys);
  for (const x of shuffleSeeded(arr || [], seedStr)) {
    const k = keyFn(x);
    if (used.has(k)) continue;
    used.add(k);
    out.push(x);
    if (out.length >= count) break;
  }
  return out;
}

/**
 * Уникальные вопросы на урок; при переполнении coverage ослабляем исключения, без циклических дублей в одном наборе.
 */
function selectQuestionsForLesson({
  uniqPool,
  wanted,
  coverageKey,
  coverageMap,
  userId,
  lang,
  level,
  lessonSlot,
  ignoreCoverage = false,
}) {
  let excludeArr = ignoreCoverage
    ? []
    : [...(Array.isArray(coverageMap[coverageKey]) ? coverageMap[coverageKey] : [])].map(String);
  const seedBase = `${userId}|${lang}|${level}|${lessonSlot}|${Date.now()}|${crypto.randomBytes(8).toString('hex')}`;

  const tryPick = (excl) => pickUniqueSeeded(
    uniqPool,
    Math.min(wanted, uniqPool.length),
    getQuestionKey,
    new Set(excl),
    seedBase,
  );

  let firstPass = tryPick(excludeArr);
  let guard = 0;
  while (firstPass.length < wanted && excludeArr.length > 0 && guard < 40) {
    const drop = Math.max(1, Math.min(20, Math.ceil(excludeArr.length / 4)));
    excludeArr = excludeArr.slice(drop);
    firstPass = tryPick(excludeArr);
    guard += 1;
  }
  if (firstPass.length < wanted) {
    firstPass = tryPick([]);
  }
  const haveKeys = new Set(firstPass.map(getQuestionKey));
  if (firstPass.length < wanted) {
    const more = pickUniqueSeeded(
      uniqPool,
      wanted - firstPass.length,
      getQuestionKey,
      haveKeys,
      `${seedBase}|more`,
    );
    firstPass = [...firstPass, ...more];
  }
  return shuffleSeeded(firstPass.slice(0, wanted), `${seedBase}|final`);
}

/** Вопросы с path_slots попадают в узлы; на уровне 1 без тега — только по ключам слота (меньше повторов между уроками). */
function buildLessonQuestionPool(uniqPool, lang, lessonSlot, requestedCount, courseLevel = 1) {
  const slot = Number(lessonSlot) || 0;
  const lev = Number(courseLevel) || 1;
  const hasPathSlots = (q) => Array.isArray(q.path_slots) && q.path_slots.length > 0;
  const excludedBySlot = (q) => Array.isArray(q.exclude_slots) && q.exclude_slots.includes(slot);

  const eligible = (uniqPool || []).filter((q) => {
    if (excludedBySlot(q)) return false;
    if (hasPathSlots(q)) {
      const slots = sortedUniquePathSlots(q);
      if (!slots.includes(slot)) return false;
      return assignedPathSlotForQuestion(q) === slot;
    }
    if (lev === 1) return untaggedMatchesLessonSlot(q, lang, slot);
    return true;
  });

  const tagged = eligible.filter((q) => hasPathSlots(q));
  const exclusive = tagged.filter((q) => {
    const slots = sortedUniquePathSlots(q);
    return slots.length === 1 && slots[0] === slot;
  });
  const sharedTagged = tagged.filter((q) => {
    const slots = sortedUniquePathSlots(q);
    return !(slots.length === 1 && slots[0] === slot);
  });

  const minPreferTagged = 6;
  let base;
  if (exclusive.length >= minPreferTagged) {
    base = exclusive;
  } else if (exclusive.length > 0 || sharedTagged.length > 0) {
    const narrow = narrowPoolForLessonSlot(eligible, lang, lessonSlot, requestedCount * 2);
    const pick = [...exclusive, ...sharedTagged];
    const tk = new Set(pick.map(getQuestionKey));
    base = uniqBy([...pick, ...narrow.filter((q) => !tk.has(getQuestionKey(q)))], getQuestionKey);
  } else {
    const narrow = narrowPoolForLessonSlot(eligible, lang, lessonSlot, requestedCount * 2);
    base = narrow.length >= Math.min(requestedCount, eligible.length) ? narrow : eligible;
  }
  base = uniqBy(base, getQuestionKey);
  if (base.length < requestedCount) {
    const have = new Set(base.map(getQuestionKey));
    const rest = shuffle(eligible.filter((q) => !have.has(getQuestionKey(q))));
    base = uniqBy([...base, ...rest], getQuestionKey);
  }
  return base.length ? base : eligible;
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr || []) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function pickUnique(arr, count, keyFn, excludeKeys = new Set()) {
  const out = [];
  const used = new Set(excludeKeys);
  for (const x of shuffle(arr || [])) {
    const k = keyFn(x);
    if (used.has(k)) continue;
    used.add(k);
    out.push(x);
    if (out.length >= count) break;
  }
  return out;
}

function getQuestionKey(q) {
  if (q && (q.id !== undefined && q.id !== null)) return `id:${q.id}`;
  // fallback for safety (shouldn't happen in this project)
  if (q?.type === 'sentence') return `s:${normalizeText(q.sentence)}|c:${normalizeText(q.correct)}`;
  return `w:${normalizeText(q.word)}|t:${normalizeText(q.translation)}`;
}

function sortedUniquePathSlots(q) {
  if (!Array.isArray(q.path_slots) || q.path_slots.length === 0) return [];
  return [...new Set(q.path_slots.map((s) => Number(s)).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
}

/** Карточка с несколькими path_slots закрепляется за одним слотом, чтобы соседние уроки не получали одни и те же вопросы. */
function assignedPathSlotForQuestion(q) {
  const slots = sortedUniquePathSlots(q);
  if (slots.length === 0) return null;
  if (slots.length === 1) return slots[0];
  const h = hashSeedString(`${getQuestionKey(q)}|path_slot_assign`);
  return slots[h % slots.length];
}

const LESSON_QUESTION_DEFAULT = 20;
const QUESTION_COVERAGE_CAP = 900;

function stripCoverageKeys(ex) {
  if (!ex || typeof ex !== 'object') return ex;
  const { coverage_keys: _ck, ...rest } = ex;
  return rest;
}

/** Типы упражнений по уровню; для каждого модуля (lang) добавлен свой вариант «верно/неверно» и тройные пары. */
function allowedExerciseTypes(lang, level) {
  const L = String(lang || 'uvs');
  const tagTf = `${L}_tf`;
  if (level === 1) {
    return ['word', 'true_false', tagTf, 'sentence', 'word_bank', 'typed_answer', 'reverse_word', 'phrase_reorder', 'reorder_sentence', 'match_duos', 'match_trios', 'match_pairs'];
  }
  if (level === 2) {
    return ['word', 'sentence', 'true_false', tagTf, 'word_bank', 'typed_answer', 'reverse_word', 'phrase_reorder', 'article_ref_choice', 'reorder_sentence', 'match_duos', 'match_trios', 'match_pairs'];
  }
  return ['sentence', 'word', 'true_false', tagTf, 'word_bank', 'typed_answer', 'reverse_word', 'phrase_reorder', 'article_ref_choice', 'reorder_sentence', 'match_duos', 'match_trios', 'match_pairs'];
}

function buildLangTaggedTrueFalse(lang, level, pool, index, usedKeys) {
  const tf = buildTrueFalseExercise(lang, level, pool, index, usedKeys);
  if (!tf) return null;
  const labels = { uvs: 'УВС', du: 'ДУ', gks: 'УГиКС', su: 'СУ' };
  const lab = labels[String(lang)] || String(lang).toUpperCase();
  return {
    ...tf,
    type: `${String(lang)}_tf`,
    statement: `[${lab}] ${tf.statement}`,
  };
}

function normalizeText(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildMatchPairsExercise(lang, level, pool, index) {
  const words = shuffle(pool.filter((q) => q.type === 'word')).slice(0, 4);
  if (words.length < 2) return null;
  return {
    exercise_id: `pairs-${Date.now()}-${index}`,
    type: 'match_pairs',
    prompt: 'Соедините термин и определение',
    lang,
    level,
    left: words.map((w) => w.word),
    right: shuffle(words.map((w) => w.translation)),
    pairs: words.map((w) => ({ left: w.word, right: w.translation })),
  };
}

function buildMatchPairsExerciseNoRepeat(lang, level, pool, index, usedKeys, pairCount = 4) {
  const n = Math.max(2, Math.min(6, Number(pairCount) || 4));
  const wordsPool = (pool || []).filter((q) => q.type === 'word');
  const picked = pickUnique(wordsPool, n, getQuestionKey, usedKeys);
  if (picked.length < 2) return null;
  picked.forEach((w) => usedKeys.add(getQuestionKey(w)));
  const isTrio = n === 3;
  const isDuo = n === 2;
  let pairPrompt = 'Соедините термин и определение';
  if (isTrio) pairPrompt = 'Соедините три термина с определениями';
  else if (isDuo) pairPrompt = 'Соедините две пары: термин — определение';
  return {
    exercise_id: `pairs-${Date.now()}-${index}`,
    type: 'match_pairs',
    prompt: pairPrompt,
    lang,
    level,
    left: picked.map((w) => w.word),
    right: shuffle(picked.map((w) => w.translation)),
    pairs: picked.map((w) => ({ left: w.word, right: w.translation })),
    coverage_keys: picked.map((w) => getQuestionKey(w)),
  };
}

function buildReorderExercise(lang, level, sentenceQuestion, index) {
  if (!sentenceQuestion?.sentence || !sentenceQuestion?.correct) return null;
  const target = sentenceQuestion.sentence.replace('___', sentenceQuestion.correct);
  const tokens = target
    .replace(/[?!.,]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length < 3) return null;
  return {
    exercise_id: `reorder-${Date.now()}-${index}`,
    type: 'reorder_sentence',
    prompt: 'Соберите предложение в правильном порядке',
    lang,
    level,
    tokens: shuffle(tokens),
    target_tokens: tokens,
    target_sentence: target,
    coverage_keys: sentenceQuestion ? [getQuestionKey(sentenceQuestion)] : [],
  };
}

/** Собрать ответ к пропуску из слов + лишние слова из неверных вариантов (тот же UI, что у reorder_sentence). */
function buildPhraseReorderExercise(lang, level, sentenceQuestion, index) {
  if (!sentenceQuestion?.correct) return null;
  const parts = String(sentenceQuestion.correct)
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (parts.length < 2 || parts.length > 7) return null;
  const junk = [];
  for (const w of [sentenceQuestion.wrong1, sentenceQuestion.wrong2, sentenceQuestion.wrong3]) {
    if (!w) continue;
    junk.push(...String(w).split(/\s+/).filter(Boolean).slice(0, 2));
  }
  const uniqJunk = [...new Set(junk.map((t) => t.trim()).filter(Boolean))];
  const maxExtra = Math.min(4, Math.max(2, 9 - parts.length));
  const extra = shuffle(uniqJunk).slice(0, maxExtra);
  if (extra.length < 1) return null;
  const tokens = shuffle([...parts, ...extra]);
  return {
    exercise_id: `phrase-${sentenceQuestion.id}-${index}`,
    type: 'reorder_sentence',
    prompt: 'Составьте правильный ответ из слов (порядок важен)',
    lang,
    level,
    tokens,
    target_tokens: parts,
    target_sentence: parts.join(' '),
    coverage_keys: [getQuestionKey(sentenceQuestion)],
  };
}

function buildTypedAnswerExercise(lang, level, pool, index, usedKeys) {
  const wordsPool = (pool || []).filter((q) => q.type === 'word');
  const source = pickUnique(wordsPool, 1, getQuestionKey, usedKeys)[0];
  if (!source?.word || !source?.translation) return null;
  usedKeys.add(getQuestionKey(source));
  const word = String(source.word);
  const hint = word.length >= 2 ? `${word[0]}${'•'.repeat(Math.min(10, word.length - 1))}` : word[0] || '';
  return {
    exercise_id: `typed-${Date.now()}-${index}`,
    type: 'typed_answer',
    prompt: 'Введите термин по определению',
    lang,
    level,
    definition: source.translation,
    hint,
    correct: source.word,
    explanation: source.explanation,
    article_ref: source.article_ref,
    coverage_keys: [getQuestionKey(source)],
  };
}

function buildReverseWordExercise(lang, level, pool, index, usedKeys) {
  const wordsPool = (pool || []).filter((q) => q.type === 'word' && q.word && q.translation);
  const source = pickUnique(wordsPool, 1, getQuestionKey, usedKeys)[0];
  if (!source) return null;
  const distractors = pickUnique(
    wordsPool.filter((q) => normalizeText(q.word) !== normalizeText(source.word)),
    3,
    getQuestionKey
  );
  if (distractors.length < 3) return null;
  usedKeys.add(getQuestionKey(source));
  return {
    exercise_id: `reverse-${Date.now()}-${index}`,
    type: 'reverse_word',
    prompt: 'Выберите термин по определению',
    definition: source.translation,
    options: shuffle([source.word, ...distractors.map((d) => d.word)]),
    correct: source.word,
    lang,
    level,
    explanation: source.explanation,
    article_ref: source.article_ref,
    coverage_keys: [getQuestionKey(source)],
  };
}

function buildArticleRefExercise(lang, level, pool, index, usedKeys) {
  const validPool = (pool || []).filter((q) => q.article_ref && (q.word || q.sentence));
  const source = pickUnique(validPool, 1, getQuestionKey, usedKeys)[0];
  if (!source?.article_ref) return null;
  const distractors = pickUnique(
    validPool.filter((q) => normalizeText(q.article_ref) !== normalizeText(source.article_ref)),
    3,
    getQuestionKey
  );
  if (distractors.length < 3) return null;
  usedKeys.add(getQuestionKey(source));
  const statement = source.type === 'sentence'
    ? String(source.sentence || '')
    : `${String(source.word || '')} — ${String(source.translation || '')}`;
  return {
    exercise_id: `article-${Date.now()}-${index}`,
    type: 'article_ref_choice',
    prompt: 'Выберите корректную ссылку на устав',
    statement,
    options: shuffle([source.article_ref, ...distractors.map((d) => d.article_ref)]),
    correct: source.article_ref,
    lang,
    level,
    explanation: source.explanation,
    article_ref: source.article_ref,
    coverage_keys: [getQuestionKey(source)],
  };
}

function buildTrueFalseExercise(lang, level, pool, index, usedKeys) {
  const wordsPool = (pool || []).filter(
    (q) => q.type === 'word' && q.word && q.translation
  );
  const source = pickUnique(wordsPool, 1, getQuestionKey, usedKeys)[0];
  if (!source) return null;
  usedKeys.add(getQuestionKey(source));
  const word = String(source.word).trim();
  const tr = String(source.translation).trim();
  const wrongPool = [source.wrong1, source.wrong2, source.wrong3]
    .map((w) => (w != null ? String(w).trim() : ''))
    .filter((w) => w && normalizeText(w) !== normalizeText(tr));
  const useTrue = Math.random() < 0.5;
  let statement;
  let expected_true;
  if (useTrue || wrongPool.length === 0) {
    statement = `Термин «${word}» верно определён как: ${tr}`;
    expected_true = true;
  } else {
    const bad = wrongPool[Math.floor(Math.random() * wrongPool.length)];
    statement = `Термин «${word}» верно определён как: ${bad}`;
    expected_true = false;
  }
  return {
    exercise_id: `tf-${Date.now()}-${index}`,
    type: 'true_false',
    prompt: 'Верно ли утверждение?',
    statement,
    expected_true,
    lang,
    level,
    explanation: source.explanation,
    article_ref: source.article_ref,
    coverage_keys: [getQuestionKey(source)],
  };
}

function gradeExerciseAnswer(exercise, answer) {
  if (!exercise) return { isCorrect: false, correctAnswer: null };
  if (exercise.type === 'match_pairs') {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
      return { isCorrect: false, correctAnswer: exercise.pairs };
    }
    const pairs = exercise.pairs || [];
    const isCorrect = pairs.every((p) => answer[p.left] === p.right);
    return { isCorrect, correctAnswer: exercise.pairs };
  }
  if (exercise.type === 'reorder_sentence') {
    const arr = Array.isArray(answer) ? answer : [];
    const attempt = arr.join(' ');
    const target = (exercise.target_tokens || []).join(' ');
    return {
      isCorrect: normalizeText(attempt) === normalizeText(target),
      correctAnswer: exercise.target_sentence || target,
    };
  }
  if (exercise.type === 'word_bank') {
    const answerText = Array.isArray(answer) ? answer.join(' ') : String(answer || '');
    return {
      isCorrect: normalizeText(answerText) === normalizeText(exercise.correct),
      correctAnswer: exercise.correct,
    };
  }
  if (exercise.type === 'typed_answer') {
    const answerText = Array.isArray(answer) ? answer.join(' ') : String(answer || '');
    return {
      isCorrect: normalizeText(answerText) === normalizeText(exercise.correct),
      correctAnswer: exercise.correct,
    };
  }
  if (exercise.type === 'reverse_word' || exercise.type === 'article_ref_choice') {
    const answerText = Array.isArray(answer) ? answer.join(' ') : String(answer || '');
    return {
      isCorrect: normalizeText(answerText) === normalizeText(exercise.correct),
      correctAnswer: exercise.correct,
    };
  }
  if (exercise.type === 'true_false' || (typeof exercise.type === 'string' && exercise.type.endsWith('_tf'))) {
    const expected = Boolean(exercise.expected_true);
    let userVal = answer;
    if (typeof userVal === 'string') {
      const s = userVal.trim().toLowerCase();
      userVal = s === 'true' || s === 'верно' || s === 'да' || s === '1';
    }
    if (userVal === false || userVal === true) {
      return {
        isCorrect: Boolean(userVal) === expected,
        correctAnswer: expected ? 'Верно' : 'Неверно',
      };
    }
    return { isCorrect: false, correctAnswer: expected ? 'Верно' : 'Неверно' };
  }
  const answerText = Array.isArray(answer) ? answer.join(' ') : String(answer || '');
  return {
    isCorrect: normalizeText(answerText) === normalizeText(exercise.correct),
    correctAnswer: exercise.correct,
  };
}

app.get('/api/languages', (req, res) => {
  res.json([
    { id: 'uvs', name: 'УВС', nameRu: 'Устав внутренней службы' },
    { id: 'du', name: 'ДУ', nameRu: 'Дисциплинарный устав' },
    { id: 'gks', name: 'УГиКС', nameRu: 'Устав гарнизонной и караульной служб' },
    { id: 'su', name: 'СУ', nameRu: 'Строевой устав' },
  ]);
});

app.get('/api/questions', requireAuth, async (req, res, next) => {
  try {
    const lang = req.query.lang || 'uvs';
    const level = normalizeLevel(req.query.level);
    const raw = await getQuestions(lang, level);
    if (raw.length === 0) return res.json([]);
    const uniq = uniqBy(raw, getQuestionKey);
    const shuffled = pickUnique(uniq, 10, getQuestionKey);
    const points = POINTS[level];
    const result = shuffled.map(q => {
    if (q.type === 'sentence') {
      const opts = [q.correct, q.wrong1, q.wrong2, q.wrong3].sort(() => Math.random() - 0.5);
      return {
        id: q.id,
        type: 'sentence',
        sentence: q.sentence,
        options: opts,
        correct: q.correct,
        lang: q.lang,
        level,
        points
      };
    }
    const opts = [q.translation, q.wrong1, q.wrong2, q.wrong3].sort(() => Math.random() - 0.5);
    return {
      id: q.id,
      type: 'word',
      word: q.word,
      options: opts,
      correct: q.translation,
      lang: q.lang,
      level,
      points
    };
    });
    res.json(result);
  } catch (e) { next(e); }
});

app.get('/api/path', requireAuth, async (req, res, next) => {
  try {
    const lang = req.query.lang || 'uvs';
    const profile = await getUserProfile(req.session.userId, lang);
    const pathUnits = await buildLearningPath(lang);
    const mblPath = profile.mastery_by_lesson && typeof profile.mastery_by_lesson === 'object'
      ? profile.mastery_by_lesson
      : {};
    const hasPerLessonKeys = Object.keys(mblPath).some((k) => String(k).startsWith(`${lang}:`));
    const masteryFromLessons = computeMasteryByLevelFromLessons(lang, mblPath);
    const units = pathUnits.map((u) => ({
    ...u,
    skills: u.skills.map((s) => {
      const mf = Number(masteryFromLessons[s.level] || 0);
      const legacy = Number(profile.mastery_by_level?.[s.level] || 0);
      const mastery = hasPerLessonKeys ? mf : Math.max(mf, legacy);
      const locked = s.level > Number(profile.placement_level || 1) + 1;
      return { ...s, mastery, locked };
    }),
  }));
    res.json({
      course_id: `course-${lang}-ru`,
      language: lang,
      placement_level: profile.placement_level,
      mastery_by_lesson: profile.mastery_by_lesson && typeof profile.mastery_by_lesson === 'object'
        ? profile.mastery_by_lesson
        : {},
      units,
    });
  } catch (e) { next(e); }
});

app.post('/api/path/module/clear-coverage', requireAuth, async (req, res, next) => {
  try {
    const lang = req.body?.lang || 'uvs';
    const moduleNum = Math.max(1, Math.min(6, Number(req.body?.module) || 0));
    if (!moduleNum) return res.status(400).json({ error: 'Укажите module (1–6)' });
    await updateUserGameState(req.session.userId, (s) => ({
      ...s,
      question_coverage: clearQuestionCoverageForModule(s.question_coverage, lang, moduleNum),
    }));
    res.json({ ok: true, lang, module: moduleNum });
  } catch (e) { next(e); }
});

app.get('/api/game-state', requireAuth, async (req, res, next) => {
  try {
    const state = await updateUserGameState(req.session.userId, (s) => applyTimedHeartRefill(s));
    res.json(state);
  } catch (e) { next(e); }
});

app.post('/api/avatar', requireAuth, async (req, res, next) => {
  try {
    const avatarDataUrl = String(req.body?.avatarDataUrl || '');
    if (!avatarDataUrl) return res.status(400).json({ error: 'avatarDataUrl обязателен' });
    const validPrefix = /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(avatarDataUrl);
    if (!validPrefix) return res.status(400).json({ error: 'Неверный формат изображения' });
    if (avatarDataUrl.length > 5_000_000) {
      return res.status(400).json({ error: 'Слишком большой файл аватара' });
    }
    const state = await updateUserGameState(req.session.userId, (s) => ({
      ...applyTimedHeartRefill(s),
      avatar_url: avatarDataUrl,
    }));
    res.json({ success: true, avatar_url: state.avatar_url });
  } catch (e) { next(e); }
});

app.get('/api/review-queue', requireAuth, async (req, res, next) => {
  try {
    const items = await listDueReviewExercises(req.session.userId, 10);
    res.json(items);
  } catch (e) { next(e); }
});

app.get('/api/quests/daily', requireAuth, async (req, res, next) => {
  try {
    const lang = req.query?.lang || 'uvs';
    const quests = await getDailyQuests(req.session.userId, lang);
    res.json(quests);
  } catch (e) { next(e); }
});

app.post('/api/quests/claim', requireAuth, async (req, res, next) => {
  try {
    const questId = req.body?.quest_id;
    const lang = req.body?.lang || 'uvs';
    if (!questId) return res.status(400).json({ error: 'quest_id обязателен' });
    let claimed = null;
    const quests = await updateDailyQuests(req.session.userId, lang, (list) => list.map((q) => {
      if (q.id !== questId) return q;
      if (q.claimed) return q;
      if (q.progress < q.target) return q;
      claimed = { ...q, claimed: true };
      return claimed;
    }));
    if (!claimed) return res.status(409).json({ error: 'Квест нельзя получить сейчас' });
    const state = await updateUserGameState(req.session.userId, (s) => ({ ...s, xp_total: (s.xp_total || 0) + 20 }));
    await appendAnalyticsEvent({
      user_id: req.session.userId,
      event_name: 'quest_claimed',
      payload: { quest_id: questId, bonus_xp: 20 },
    });
    res.json({ quests, game_state: state });
  } catch (e) { next(e); }
});

app.post('/api/placement/start', requireAuth, rateLimitLesson, async (req, res, next) => {
  try {
    const lang = req.body?.lang || 'uvs';
    const questions = await getMixedQuestionsForPlacement(lang, 6);
    if (!questions.length) return res.status(400).json({ error: 'Недостаточно заданий для placement' });
    const attempt = await createPlacementAttempt(req.session.userId, lang, questions);
    await appendAnalyticsEvent({
      user_id: req.session.userId,
      event_name: 'placement_start',
      payload: { attempt_id: attempt.id, lang, count: attempt.questions.length },
    });
    res.json({
    attempt_id: attempt.id,
    lang,
    questions: attempt.questions.map((q) => ({
      idx: q.idx,
      type: q.type,
      prompt: q.prompt,
      options: q.options,
    })),
    });
  } catch (e) { next(e); }
});

app.post('/api/placement/complete', requireAuth, rateLimitLesson, async (req, res, next) => {
  try {
    const attemptId = req.body?.attempt_id;
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (!attemptId || !answers.length) return res.status(400).json({ error: 'Нужны attempt_id и answers' });

    const existing = await getPlacementAttempt(req.session.userId, attemptId);
    if (!existing) return res.status(404).json({ error: 'Placement не найден' });

    const completed = await completePlacementAttempt(req.session.userId, attemptId, answers);
    if (!completed || !completed.result) return res.status(500).json({ error: 'Не удалось завершить placement' });

    const profile = await updateUserProfile(req.session.userId, completed.lang, (p) => ({
      ...p,
      placement_level: completed.result.recommended_level,
    }));

    await appendAnalyticsEvent({
      user_id: req.session.userId,
      event_name: 'placement_complete',
      payload: {
        attempt_id: attemptId,
        lang: completed.lang,
        recommended_level: completed.result.recommended_level,
        ratio: completed.result.ratio,
      },
    });

    res.json({
      lang: completed.lang,
      recommended_level: completed.result.recommended_level,
      ratio: completed.result.ratio,
      profile,
    });
  } catch (e) { next(e); }
});

app.post('/api/hearts/practice', requireAuth, rateLimitLesson, async (req, res, next) => {
  try {
    const state = await updateUserGameState(req.session.userId, (s) => refillHeartByPractice(applyTimedHeartRefill(s)));
    await appendAnalyticsEvent({
      user_id: req.session.userId,
      event_name: 'heart_refilled',
      payload: { hearts_current: state.hearts_current },
    });
    res.json(state);
  } catch (e) { next(e); }
});

app.post('/api/lesson/start', requireAuth, rateLimitLesson, async (req, res, next) => {
  try {
    const lang = req.body?.lang || 'uvs';
    const level = normalizeLevel(req.body?.level);
    const lessonSlot = Math.max(0, Math.min(99, Number(req.body?.lesson_slot) || 0));
    const requestedCount = Math.max(1, Math.min(30, Number(req.body?.question_count) || LESSON_QUESTION_DEFAULT));
    const requestedTypes = Array.isArray(req.body?.exercise_types) ? req.body.exercise_types : null;
    const pool = await getQuestions(lang, level);
    if (!pool.length) return res.status(400).json({ error: 'Для выбранного уровня пока нет уроков' });
    const uniqPool = uniqBy(pool, getQuestionKey);
    const lessonPoolUniq = buildLessonQuestionPool(uniqPool, lang, lessonSlot, requestedCount, level);

    const userId = req.session.userId;
    let stateBefore = await getUserGameState(userId);
    const replayModule = Math.max(0, Math.min(6, Number(req.body?.replay_module) || 0));
    if (replayModule > 0) {
      stateBefore = await updateUserGameState(userId, (s) => ({
        ...s,
        question_coverage: clearQuestionCoverageForModule(s.question_coverage, lang, replayModule),
      }));
    }
    const coverageMap = stateBefore?.question_coverage && typeof stateBefore.question_coverage === 'object'
      ? stateBefore.question_coverage
      : {};
    const coverageKey = `${lang}:${level}:${lessonSlot}`;
    const ignoreCoverage = Boolean(req.body?.replay) || replayModule > 0;

    const wanted = Math.min(requestedCount, Math.max(lessonPoolUniq.length, requestedCount));
    const selected = selectQuestionsForLesson({
      uniqPool: lessonPoolUniq,
      wanted,
      coverageKey,
      coverageMap,
      userId,
      lang,
      level,
      lessonSlot,
      ignoreCoverage,
    });

    const allowedTypes = requestedTypes || allowedExerciseTypes(lang, level);

  const exercises = [];
  const usedInLesson = new Set(selected.map(getQuestionKey));
  const exercisePool = lessonPoolUniq;
  for (let i = 0; i < selected.length; i += 1) {
    const q = selected[i];
    const type = allowedTypes[i % allowedTypes.length];
    if (type === 'true_false') {
      const tf = buildTrueFalseExercise(lang, level, exercisePool, i, usedInLesson);
      if (tf) {
        exercises.push(tf);
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    if (typeof type === 'string' && type.endsWith('_tf') && type !== 'true_false') {
      const ltf = buildLangTaggedTrueFalse(lang, level, exercisePool, i, usedInLesson);
      if (ltf) {
        exercises.push(ltf);
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    if (type === 'match_trios') {
      const trios = buildMatchPairsExerciseNoRepeat(lang, level, exercisePool, i, usedInLesson, 3);
      if (trios) {
        exercises.push(trios);
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    if (type === 'match_duos') {
      const duos = buildMatchPairsExerciseNoRepeat(lang, level, exercisePool, i, usedInLesson, 2);
      if (duos) {
        exercises.push(duos);
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    if (type === 'match_pairs') {
      const pairs = buildMatchPairsExerciseNoRepeat(lang, level, exercisePool, i, usedInLesson, 4);
      if (pairs) {
        exercises.push(pairs);
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    if (type === 'phrase_reorder') {
      const sentenceSource = q.type === 'sentence'
        ? q
        : pickUnique(exercisePool.filter((x) => x.type === 'sentence'), 1, getQuestionKey, usedInLesson)[0];
      const phraseEx = buildPhraseReorderExercise(lang, level, sentenceSource, i);
      if (phraseEx) {
        if (sentenceSource) usedInLesson.add(getQuestionKey(sentenceSource));
        exercises.push(phraseEx);
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    if (type === 'reorder_sentence') {
      const sentenceSource = q.type === 'sentence'
        ? q
        : pickUnique(exercisePool.filter((x) => x.type === 'sentence'), 1, getQuestionKey, usedInLesson)[0];
      const reorder = buildReorderExercise(lang, level, sentenceSource, i);
      if (reorder) {
        if (sentenceSource) usedInLesson.add(getQuestionKey(sentenceSource));
        exercises.push(reorder);
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    if (type === 'word_bank') {
      const source = q.type === 'sentence'
        ? q
        : pickUnique(exercisePool.filter((x) => x.type === 'sentence'), 1, getQuestionKey, usedInLesson)[0];
      if (source?.sentence && source?.correct) {
        const options = shuffle([source.correct, source.wrong1, source.wrong2, source.wrong3]);
        usedInLesson.add(getQuestionKey(source));
        exercises.push({
          exercise_id: `${source.id}-${i}-wb`,
          type: 'word_bank',
          prompt: source.sentence,
          options,
          correct: source.correct,
          lang,
          level,
          explanation: source.explanation,
          article_ref: source.article_ref,
          coverage_keys: [getQuestionKey(source)],
        });
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    if (type === 'typed_answer') {
      const typed = buildTypedAnswerExercise(lang, level, exercisePool, i, usedInLesson);
      if (typed) {
        exercises.push(typed);
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    if (type === 'reverse_word') {
      const reverse = buildReverseWordExercise(lang, level, exercisePool, i, usedInLesson);
      if (reverse) {
        exercises.push(reverse);
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    if (type === 'article_ref_choice') {
      const articleChoice = buildArticleRefExercise(lang, level, exercisePool, i, usedInLesson);
      if (articleChoice) {
        exercises.push(articleChoice);
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    if (q.type === 'sentence') {
      const options = shuffle([q.correct, q.wrong1, q.wrong2, q.wrong3]);
      exercises.push({
        exercise_id: `${q.id}-${i}`,
        type: 'sentence',
        sentence: q.sentence,
        options,
        correct: q.correct,
        explanation: q.explanation,
        article_ref: q.article_ref,
        coverage_keys: [getQuestionKey(q)],
      });
    } else {
      const options = shuffle([q.translation, q.wrong1, q.wrong2, q.wrong3]);
      exercises.push({
        exercise_id: `${q.id}-${i}`,
        type: 'word',
        word: q.word,
        options,
        correct: q.translation,
        explanation: q.explanation,
        article_ref: q.article_ref,
        coverage_keys: [getQuestionKey(q)],
      });
    }
  }

    const attempt = await createLessonAttempt(req.session.userId, {
      lang,
      level,
      lesson_slot: lessonSlot,
      exercises,
    });
    await appendAnalyticsEvent({
      user_id: req.session.userId,
      event_name: 'lesson_start',
      payload: { attempt_id: attempt.id, lang, level, lesson_slot: lessonSlot, exercises: exercises.length },
    });

    const state = await updateUserGameState(req.session.userId, (s) => {
      let next = applyTimedHeartRefill(s);
      // Средний/сложный уровни: повышенный запас жизней; лёгкий — без лимита в уроке.
      if (level === 2 || level === 3) {
        const maxH = level === 2 ? 7 : 8;
        next = {
          ...next,
          hearts_max: maxH,
          hearts_current: Math.min(maxH, Math.max(0, Number(next.hearts_current ?? maxH))),
        };
      }
      return next;
    });
    if (level !== 1 && state.hearts_current <= 0) {
      return res.status(409).json({
        error: 'Сердечки закончились. Дождитесь восстановления или пройдите практику.',
        hearts_current: state.hearts_current,
        hearts_next_refill_at: state.hearts_next_refill_at,
      });
    }
    res.json({
      attempt_id: attempt.id,
      level,
      lesson_slot: lessonSlot,
      question_count: exercises.length,
      points_per_exercise: POINTS[level],
      hearts_unlimited: level === 1,
      hearts_current: state.hearts_current,
      hearts_next_refill_at: state.hearts_next_refill_at,
      hearts_max: state.hearts_max ?? undefined,
      exercises: exercises.map((x) => stripCoverageKeys(x)),
    });
  } catch (e) {
    console.error('lesson/start error:', e);
    res.status(500).json({
      error: e.message || 'Не удалось запустить урок. Выполните npm run db:seed, если вопросов нет в БД.',
    });
  }
});

app.post('/api/lesson/answer', requireAuth, rateLimitLesson, async (req, res, next) => {
  try {
    const { attempt_id, exercise_id, answer } = req.body || {};
    if (!attempt_id || !exercise_id || answer == null) {
      return res.status(400).json({ error: 'Некорректный формат ответа' });
    }
    const attempt = await getLessonAttempt(req.session.userId, attempt_id);
  if (!attempt) return res.status(404).json({ error: 'Урок не найден' });
  if (attempt.status === 'completed') {
    return res.status(409).json({ error: 'Урок уже завершен' });
  }
  try {
    lessonStateTransition(attempt.status, 'answer');
  } catch (e) {
    return res.status(409).json({ error: e.message });
  }

  const exercise = (attempt.exercises || []).find((x) => x.exercise_id === exercise_id);
  if (!exercise) return res.status(404).json({ error: 'Упражнение не найдено' });
  if ((attempt.answers || []).some((x) => x.exercise_id === exercise_id)) {
    return res.status(409).json({ error: 'Ответ уже отправлен' });
  }

    const graded = gradeExerciseAnswer(exercise, answer);
    const isCorrect = graded.isCorrect;
    const lessonLevel = normalizeLevel(attempt.level);
    const heartsUnlimitedLesson = lessonLevel === 1;
    const updatedAttempt = await updateLessonAttempt(req.session.userId, attempt_id, (current) => {
    const answers = [...(current.answers || []), {
      exercise_id,
      answer,
      is_correct: isCorrect,
      answered_at: new Date().toISOString(),
    }];
    return {
      ...current,
      answers,
      answered_count: answers.length,
      correct_count: answers.filter((x) => x.is_correct).length,
      hearts_lost: answers.filter((x) => !x.is_correct).length,
      status: 'in_progress',
    };
    });

    const state = await updateUserGameState(req.session.userId, (s) =>
      applyAnswerToGameState(applyTimedHeartRefill(s), isCorrect, {
        skipHeartPenalty: heartsUnlimitedLesson,
      })
    );
    await updateDailyQuests(req.session.userId, attempt.lang, (quests) => quests.map((q) => {
      if (q.type === 'answers_given') {
        return { ...q, progress: Math.min(q.target, q.progress + 1) };
      }
      if (q.type === 'correct_answers' && isCorrect) {
        return { ...q, progress: Math.min(q.target, q.progress + 1) };
      }
      if (q.type === 'question_streak' && (state.question_streak_current || 0) > (q.progress || 0)) {
        return { ...q, progress: Math.min(q.target, state.question_streak_current || 0) };
      }
      return q;
    }));
    if (!heartsUnlimitedLesson && state.hearts_current <= 0) {
      return res.status(409).json({
        error: 'Сердечки закончились. Пройдите практику для восстановления.',
        hearts_current: state.hearts_current,
        hearts_next_refill_at: state.hearts_next_refill_at,
        correct_answer: graded.correctAnswer,
      });
    }

    await appendAnalyticsEvent({
      user_id: req.session.userId,
      event_name: 'exercise_answered',
      payload: { attempt_id, exercise_id, is_correct: isCorrect },
    });

    res.json({
      is_correct: isCorrect,
      correct_answer: graded.correctAnswer,
      explanation: !isCorrect ? (exercise.explanation || 'Правильный ответ установлен уставом.') : null,
      article_ref: !isCorrect ? (exercise.article_ref || null) : null,
      answered_count: updatedAttempt.answered_count,
      total_count: updatedAttempt.exercises.length,
      hearts_current: state.hearts_current,
      hearts_next_refill_at: state.hearts_next_refill_at,
      question_streak_current: state.question_streak_current || 0,
      question_streak_best: state.question_streak_best || 0,
    });
  } catch (e) { next(e); }
});

app.post('/api/lesson/complete', requireAuth, rateLimitLesson, async (req, res, next) => {
  try {
    const { attempt_id } = req.body || {};
    if (!attempt_id) return res.status(400).json({ error: 'attempt_id обязателен' });

    const attempt = await getLessonAttempt(req.session.userId, attempt_id);
    if (!attempt) return res.status(404).json({ error: 'Урок не найден' });

    if (attempt.status === 'completed') {
      const stateWithRefill = await updateUserGameState(req.session.userId, (s) => applyTimedHeartRefill(s));
      return res.json({
      attempt_id: attempt.id,
      status: attempt.status,
      xp_awarded: attempt.xp_awarded || 0,
      score: (attempt.correct_count || 0) * (POINTS[attempt.level] || 10),
      streak_current: stateWithRefill.streak_current,
      hearts_current: stateWithRefill.hearts_current,
      hearts_next_refill_at: stateWithRefill.hearts_next_refill_at,
      xp_total: stateWithRefill.xp_total,
      });
    }

    try {
      lessonStateTransition(attempt.status, 'complete');
    } catch (e) {
      return res.status(409).json({ error: e.message });
    }

  const totalCount = (attempt.exercises || []).length;
  if ((attempt.answered_count || 0) < totalCount) {
    return res.status(409).json({ error: 'Нельзя завершить урок до ответов на все упражнения' });
  }
    const xp = calcXpForLesson({
    level: attempt.level,
    correctCount: attempt.correct_count || 0,
    totalCount,
    isPerfect: (attempt.correct_count || 0) === totalCount,
  });

    const completedAttempt = await updateLessonAttempt(req.session.userId, attempt_id, (current) => ({
    ...current,
    status: 'completed',
    completed_at: new Date().toISOString(),
    xp_awarded: xp,
  }));

    const coverageKeysFlat = (completedAttempt.exercises || []).flatMap((ex) =>
      Array.isArray(ex.coverage_keys) ? ex.coverage_keys : []
    );
    const lessonSlot = Math.max(0, Math.min(99, Number(completedAttempt.lesson_slot) || 0));
    const covK = `${completedAttempt.lang}:${completedAttempt.level}:${lessonSlot}`;
    const lessonMasteryKey = `${completedAttempt.lang}:${lessonSlot}`;

    const state = await updateUserGameState(req.session.userId, (current) => {
    const withStreak = updateStreak(current);
    withStreak.xp_total += xp;
    const qc = { ...(withStreak.question_coverage && typeof withStreak.question_coverage === 'object'
      ? withStreak.question_coverage
      : {}) };
    const prevCov = Array.isArray(qc[covK]) ? qc[covK].map(String) : [];
    const mergedCov = [...prevCov, ...coverageKeysFlat.map(String)];
    qc[covK] = mergedCov.slice(-QUESTION_COVERAGE_CAP);
    withStreak.question_coverage = qc;
    return withStreak;
  });

    await updateUserProfile(req.session.userId, completedAttempt.lang, (p) => {
    const accuracy = totalCount > 0 ? (completedAttempt.correct_count || 0) / totalCount : 0;
    const inc = Math.max(1, Math.min(20, Math.round(accuracy * 20)));
    const mbl = { ...(p.mastery_by_lesson && typeof p.mastery_by_lesson === 'object' ? p.mastery_by_lesson : {}) };
    const prevLesson = Number(mbl[lessonMasteryKey] || 0);
    mbl[lessonMasteryKey] = Math.min(100, prevLesson + inc);
    const mastery = computeMasteryByLevelFromLessons(completedAttempt.lang, mbl);
    return {
      ...p,
      mastery_by_level: mastery,
      mastery_by_lesson: mbl,
      lessons_completed: Number(p.lessons_completed || 0) + 1,
    };
  });

    for (const wrong of (completedAttempt.answers || []).filter((x) => !x.is_correct)) {
      await enqueueReviewItem({
        user_id: req.session.userId,
        attempt_id: completedAttempt.id,
        exercise_id: wrong.exercise_id,
        due_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      });
    }

    const lessonScore = (completedAttempt.correct_count || 0) * (POINTS[completedAttempt.level] || 10);
    await addScore(req.session.userId, lessonScore);
    await addUserXp(req.session.userId, xp);

    await appendAnalyticsEvent({
    user_id: req.session.userId,
    event_name: 'lesson_complete',
    payload: {
      attempt_id: completedAttempt.id,
      xp_awarded: xp,
      correct_count: completedAttempt.correct_count,
      total_count: totalCount,
    },
  });

    await updateDailyQuests(req.session.userId, completedAttempt.lang, (quests) => quests.map((q) => {
    if (q.type === 'lessons_completed') {
      return { ...q, progress: Math.min(q.target, q.progress + 1) };
    }
    if (q.type === 'perfect_lessons' && (completedAttempt.correct_count || 0) === totalCount) {
      return { ...q, progress: Math.min(q.target, q.progress + 1) };
    }
    if (q.type === 'xp_earned') {
      return { ...q, progress: Math.min(q.target, q.progress + xp) };
    }
    return q;
  }));

    res.json({
      attempt_id: completedAttempt.id,
      status: completedAttempt.status,
      xp_awarded: xp,
      score: lessonScore,
    streak_current: state.streak_current,
    hearts_current: state.hearts_current,
      hearts_next_refill_at: state.hearts_next_refill_at,
      xp_total: state.xp_total,
    });
  } catch (e) { next(e); }
});

app.post('/api/score', requireAuth, async (req, res, next) => {
  try {
    const { score } = req.body || {};
    const s = Math.max(0, parseInt(score, 10) || 0);
    await addScore(req.session.userId, s);
    res.json({ success: true });
  } catch (e) { next(e); }
});

app.get('/api/leaderboard', async (req, res, next) => {
  try {
    const top = await getLeaderboard(20);
    res.json(top);
  } catch (e) { next(e); }
});

app.get('/api/my-best', requireAuth, async (req, res, next) => {
  try {
    const row = await getMyBest(req.session.userId);
    res.json(row);
  } catch (e) { next(e); }
});

function validateLessonQuestions(questions) {
  return (questions || []).filter((q) => {
    if (!q || (q.type !== 'word' && q.type !== 'sentence')) return false;
    if (q.type === 'word') {
      return q.word && q.translation && q.wrong1 && q.wrong2 && q.wrong3;
    }
    return q.sentence && q.correct && q.wrong1 && q.wrong2 && q.wrong3;
  });
}

async function generateLessonQuestionSet(body) {
  const title = String(body.title || '').trim() || 'Без названия';
  const lang = ['uvs', 'du', 'gks', 'su'].includes(String(body.lang)) ? body.lang : 'uvs';
  const level = Math.min(3, Math.max(1, Number(body.level) || 1));
  const maxQuestions = Math.min(20, Math.max(3, Number(body.max_questions) || 12));
  const text = String(body.extracted_text || body.text || '').trim();
  if (text.length < 120) {
    const err = new Error('Слишком мало текста для генерации теста (нужно не менее 120 символов).');
    err.statusCode = 400;
    throw err;
  }
  const raw = await generateQuestionsFromLessonText(text, { title, lang, level, maxQuestions });
  const questions = validateLessonQuestions(raw);
  if (questions.length < 3) {
    const err = new Error(
      'Не удалось сформировать достаточно вопросов. Добавьте текст с чёткими формулировками или задайте OPENAI_API_KEY для ИИ-генерации.'
    );
    err.statusCode = 422;
    throw err;
  }
  return { title, lang, level, questions, text };
}

async function runLessonImport(userId, body, fileMeta) {
  const { title, lang, level, questions, text } = await generateLessonQuestionSet(body);
  if (!importLessonBundle) {
    const err = new Error('Импорт лекций не настроен для текущей базы данных');
    err.statusCode = 501;
    throw err;
  }
  const bundle = {
    title,
    lang,
    level,
    original_filename: fileMeta.original_filename,
    mime: fileMeta.mime,
    storage_path: fileMeta.storage_path,
    extracted_text: text,
    questions,
  };
  return importLessonBundle(userId, bundle);
}

app.get('/api/admin/lessons', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const rows = listLessonMaterials ? await listLessonMaterials(80) : [];
    res.json({ materials: rows });
  } catch (e) { next(e); }
});

app.post(
  '/api/admin/lessons/upload',
  requireAuth,
  requireAdmin,
  (req, res, next) => {
    lessonUpload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Ошибка загрузки файла' });
      next();
    });
  },
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
      const buf = fs.readFileSync(req.file.path);
      let extracted;
      try {
        extracted = await extractLessonText(buf, req.file.originalname);
      } catch (e) {
        fs.unlink(req.file.path, () => {});
        if (e.code === 'UNSUPPORTED_FORMAT') return res.status(400).json({ error: e.message });
        throw e;
      }
      const result = await runLessonImport(req.session.userId, { ...req.body, extracted_text: extracted.text }, {
        original_filename: req.file.originalname,
        mime: req.file.mimetype || 'application/octet-stream',
        storage_path: path.relative(path.join(__dirname), req.file.path).replace(/\\/g, '/'),
      });
      res.json({
        success: true,
        ...result,
        text_length: extracted.text.length,
        hint: process.env.OPENAI_API_KEY ? null : 'Для более точных вопросов добавьте OPENAI_API_KEY в .env',
      });
    } catch (e) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
      next(e);
    }
  }
);

app.post('/api/admin/lessons/from-text', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const result = await runLessonImport(req.session.userId, req.body, {
      original_filename: '(текст из формы)',
      mime: 'text/plain',
      storage_path: '',
    });
    res.json({
      success: true,
      ...result,
      hint: process.env.OPENAI_API_KEY ? null : 'Для более точных вопросов добавьте OPENAI_API_KEY в .env',
    });
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    next(e);
  }
});

app.post(
  '/api/admin/lessons/export-upload',
  requireAuth,
  requireAdmin,
  (req, res, next) => {
    lessonUpload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Ошибка загрузки файла' });
      next();
    });
  },
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
      const buf = fs.readFileSync(req.file.path);
      let extracted;
      try {
        extracted = await extractLessonText(buf, req.file.originalname);
      } catch (e) {
        fs.unlink(req.file.path, () => {});
        if (e.code === 'UNSUPPORTED_FORMAT') return res.status(400).json({ error: e.message });
        throw e;
      }
      fs.unlink(req.file.path, () => {});
      const body = { ...req.body, extracted_text: extracted.text };
      const { title, questions } = await generateLessonQuestionSet(body);
      const html = buildStandaloneQuizHtml({
        title,
        questions,
      });
      const fname = slugifyFilename(title);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      res.send(html);
    } catch (e) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
      next(e);
    }
  }
);

app.post('/api/admin/lessons/export-text', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { title, questions } = await generateLessonQuestionSet(req.body);
    const html = buildStandaloneQuizHtml({
      title,
      questions,
    });
    const fname = slugifyFilename(title);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(html);
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    next(e);
  }
});

app.use((err, req, res, next) => {
  console.error('API error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({
    error: err.message || 'Не удалось выполнить запрос. Проверьте консоль сервера.',
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  (async () => {
    const dbType = process.env.DATABASE_URL ? 'PostgreSQL (ustavy_vs)' : 'файл data.json';
    console.log('БД:', dbType);
    await initDb();
    app.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = app;
