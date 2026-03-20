require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const dbModule = process.env.DATABASE_URL ? require('./database-pg') : require('./database');
const ALL_QUESTIONS = require('./questions-data');
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
} = dbModule;

async function getQuestions(lang, level) {
  const levelNum = Number(normalizeLevel(level));
  const fromDb = await getQuestionsDb(lang, levelNum);
  if (fromDb && fromDb.length > 0) return fromDb;
  return ALL_QUESTIONS.filter((q) => q.lang === lang && Number(q.level) === levelNum);
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
app.use(express.json({ limit: '5mb' }));
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
    res.json({ success: true, user: { id: user.id, email: user.email, username: user.username } });
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
    res.json({ success: true, user: { id: user.id, email: user.email, username: user.username } });
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
    res.json({ user: { id: user.id, email: user.email, username: user.username } });
  } catch (e) { next(e); }
});

const POINTS = POINTS_BY_LEVEL;

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
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

function buildMatchPairsExerciseNoRepeat(lang, level, pool, index, usedKeys) {
  const wordsPool = (pool || []).filter((q) => q.type === 'word');
  const picked = pickUnique(wordsPool, 4, getQuestionKey, usedKeys);
  if (picked.length < 2) return null;
  picked.forEach((w) => usedKeys.add(getQuestionKey(w)));
  return {
    exercise_id: `pairs-${Date.now()}-${index}`,
    type: 'match_pairs',
    prompt: 'Соедините термин и определение',
    lang,
    level,
    left: picked.map((w) => w.word),
    right: shuffle(picked.map((w) => w.translation)),
    pairs: picked.map((w) => ({ left: w.word, right: w.translation })),
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
  if (exercise.type === 'true_false') {
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
    const units = pathUnits.map((u) => ({
    ...u,
    skills: u.skills.map((s) => {
      const mastery = Number(profile.mastery_by_level?.[s.level] || 0);
      const locked = s.level > Number(profile.placement_level || 1) + 1;
      return { ...s, mastery, locked };
    }),
  }));
    res.json({
      course_id: `course-${lang}-ru`,
      language: lang,
      placement_level: profile.placement_level,
      units,
    });
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
    const requestedCount = Math.max(1, Math.min(30, Number(req.body?.question_count) || 24));
    const requestedTypes = Array.isArray(req.body?.exercise_types) ? req.body.exercise_types : null;
    const pool = await getQuestions(lang, level);
  if (!pool.length) return res.status(400).json({ error: 'Для выбранного уровня пока нет уроков' });
  const uniqPool = uniqBy(pool, getQuestionKey);

  // Reduce repetition between lesson runs by excluding recently used questions
  const userId = req.session.userId;
  const stateBefore = await getUserGameState(userId);
  const recent = stateBefore?.recent_questions || {};
  const recentKey = `${lang}:${level}`;
  const recentList = Array.isArray(recent[recentKey]) ? recent[recentKey] : [];
  const recentSet = new Set(recentList.map(String));

  const wanted = Math.min(requestedCount, uniqPool.length);
  const firstPass = pickUnique(uniqPool, wanted, getQuestionKey, recentSet);
  const firstPassKeys = new Set(firstPass.map(getQuestionKey));
  const fill = firstPass.length < wanted
    ? pickUnique(uniqPool, wanted - firstPass.length, getQuestionKey, firstPassKeys)
    : [];
  const selected = [...firstPass, ...fill];

  const allowedTypes = requestedTypes || (
    level === 1
      ? ['word', 'true_false', 'sentence', 'word_bank', 'typed_answer', 'reverse_word', 'match_pairs']
      : level === 2
        ? ['word', 'sentence', 'true_false', 'word_bank', 'typed_answer', 'reverse_word', 'article_ref_choice', 'reorder_sentence', 'match_pairs']
        : ['sentence', 'word', 'true_false', 'word_bank', 'typed_answer', 'reverse_word', 'article_ref_choice', 'reorder_sentence', 'match_pairs']
  );

  const exercises = [];
  const usedInLesson = new Set(selected.map(getQuestionKey));
  for (let i = 0; i < selected.length; i += 1) {
    const q = selected[i];
    const type = allowedTypes[i % allowedTypes.length];
    if (type === 'true_false') {
      const tf = buildTrueFalseExercise(lang, level, uniqPool, i, usedInLesson);
      if (tf) {
        exercises.push(tf);
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    if (type === 'match_pairs') {
      const pairs = buildMatchPairsExerciseNoRepeat(lang, level, uniqPool, i, usedInLesson);
      if (pairs) {
        exercises.push(pairs);
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    if (type === 'reorder_sentence') {
      const sentenceSource = q.type === 'sentence'
        ? q
        : pickUnique(uniqPool.filter((x) => x.type === 'sentence'), 1, getQuestionKey, usedInLesson)[0];
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
        : pickUnique(uniqPool.filter((x) => x.type === 'sentence'), 1, getQuestionKey, usedInLesson)[0];
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
        });
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    if (type === 'typed_answer') {
      const typed = buildTypedAnswerExercise(lang, level, uniqPool, i, usedInLesson);
      if (typed) {
        exercises.push(typed);
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    if (type === 'reverse_word') {
      const reverse = buildReverseWordExercise(lang, level, uniqPool, i, usedInLesson);
      if (reverse) {
        exercises.push(reverse);
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    if (type === 'article_ref_choice') {
      const articleChoice = buildArticleRefExercise(lang, level, uniqPool, i, usedInLesson);
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
      });
    }
  }

    const attempt = await createLessonAttempt(req.session.userId, {
      lang,
      level,
      exercises,
    });
    await appendAnalyticsEvent({
      user_id: req.session.userId,
      event_name: 'lesson_start',
      payload: { attempt_id: attempt.id, lang, level, exercises: exercises.length },
    });

    const selectedKeys = selected.map(getQuestionKey);
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
      const rq = { ...(next.recent_questions || {}) };
      const prev = Array.isArray(rq[recentKey]) ? rq[recentKey].map(String) : [];
      const merged = [...prev, ...selectedKeys.map(String)];
      rq[recentKey] = merged.slice(Math.max(0, merged.length - 60));
      return { ...next, recent_questions: rq };
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
      points_per_exercise: POINTS[level],
      hearts_unlimited: level === 1,
      hearts_current: state.hearts_current,
      hearts_next_refill_at: state.hearts_next_refill_at,
      hearts_max: state.hearts_max ?? undefined,
      exercises: exercises.map((x) => ({
        exercise_id: x.exercise_id,
        type: x.type,
        word: x.word,
        sentence: x.sentence,
        prompt: x.prompt,
        definition: x.definition,
        hint: x.hint,
        options: x.options,
        left: x.left,
        right: x.right,
        tokens: x.tokens,
        statement: x.statement,
      })),
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

    const state = await updateUserGameState(req.session.userId, (current) => {
    const withStreak = updateStreak(current);
    withStreak.xp_total += xp;
    return withStreak;
  });

    await updateUserProfile(req.session.userId, completedAttempt.lang, (p) => {
    const mastery = { ...(p.mastery_by_level || { 1: 0, 2: 0, 3: 0 }) };
    const accuracy = totalCount > 0 ? (completedAttempt.correct_count || 0) / totalCount : 0;
    const inc = Math.max(5, Math.round(accuracy * 20));
    mastery[completedAttempt.level] = Math.min(100, Number(mastery[completedAttempt.level] || 0) + inc);
    return {
      ...p,
      mastery_by_level: mastery,
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
