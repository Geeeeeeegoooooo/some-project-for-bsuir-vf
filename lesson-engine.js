const POINTS_BY_LEVEL = { 1: 10, 2: 15, 3: 20 };
const HEARTS_MAX = 5;
const HEART_REFILL_MS = 60 * 1000;

function toDayKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dayDiff(aDayKey, bDayKey) {
  const a = new Date(`${aDayKey}T00:00:00.000Z`);
  const b = new Date(`${bDayKey}T00:00:00.000Z`);
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

function createInitialGameState() {
  return {
    xp_total: 0,
    hearts_current: HEARTS_MAX,
    hearts_max: HEARTS_MAX,
    hearts_refill_started_at: null,
    hearts_next_refill_at: null,
    hearts_refill_interval_ms: HEART_REFILL_MS,
    streak_current: 0,
    streak_last_day: null,
    question_streak_current: 0,
    question_streak_best: 0,
    freeze_count: 1,
    daily_goal_xp: 50,
  };
}

function normalizeLevel(level) {
  const n = Number(level) || 1;
  return Math.max(1, Math.min(3, n));
}

function lessonStateTransition(status, action) {
  const graph = {
    created: ["start"],
    in_progress: ["answer", "complete", "abandon"],
    completed: [],
    abandoned: [],
  };
  const isAllowed = graph[status]?.includes(action) || false;
  if (!isAllowed) {
    throw new Error(`Invalid lesson transition: ${status} -> ${action}`);
  }
  if (action === "start") return "in_progress";
  if (action === "complete") return "completed";
  if (action === "abandon") return "abandoned";
  return status;
}

function calcXpForLesson({ level, correctCount, totalCount, isPerfect }) {
  const lvl = normalizeLevel(level);
  const base = POINTS_BY_LEVEL[lvl] * totalCount;
  const accuracy = totalCount > 0 ? correctCount / totalCount : 0;
  const scaled = Math.round(base * accuracy);
  const perfectBonus = isPerfect ? Math.round(base * 0.2) : 0;
  const firstLessonBonus = 10;
  return Math.max(0, scaled + perfectBonus + firstLessonBonus);
}

function updateStreak(gameState, todayKey = toDayKey()) {
  const next = { ...gameState };
  if (!next.streak_last_day) {
    next.streak_current = 1;
    next.streak_last_day = todayKey;
    return next;
  }
  const diff = dayDiff(next.streak_last_day, todayKey);
  if (diff <= 0) return next;
  if (diff === 1) {
    next.streak_current += 1;
    next.streak_last_day = todayKey;
    return next;
  }
  if (next.freeze_count > 0) {
    next.freeze_count -= 1;
    next.streak_current += 1;
    next.streak_last_day = todayKey;
    return next;
  }
  next.streak_current = 1;
  next.streak_last_day = todayKey;
  return next;
}

function applyAnswerToGameState(gameState, isCorrect, options = {}) {
  const skipHeartPenalty = Boolean(options.skipHeartPenalty);
  const next = applyTimedHeartRefill(gameState);
  if (isCorrect) {
    const cur = Number(next.question_streak_current || 0) + 1;
    next.question_streak_current = cur;
    next.question_streak_best = Math.max(Number(next.question_streak_best || 0), cur);
  } else {
    next.question_streak_current = 0;
  }
  if (!isCorrect && !skipHeartPenalty) {
    const before = next.hearts_current;
    next.hearts_current = Math.max(0, next.hearts_current - 1);
    if (before === (next.hearts_max || HEARTS_MAX) && next.hearts_current < before) {
      next.hearts_refill_started_at = new Date().toISOString();
    }
    if (next.hearts_current >= (next.hearts_max || HEARTS_MAX)) {
      next.hearts_refill_started_at = null;
      next.hearts_next_refill_at = null;
    } else {
      const start = next.hearts_refill_started_at
        ? new Date(next.hearts_refill_started_at).getTime()
        : Date.now();
      next.hearts_refill_started_at = new Date(start).toISOString();
      next.hearts_next_refill_at = new Date(start + (next.hearts_refill_interval_ms || HEART_REFILL_MS)).toISOString();
    }
  }
  return next;
}

function refillHeartByPractice(gameState) {
  const next = applyTimedHeartRefill(gameState);
  next.hearts_current = Math.min(next.hearts_max || HEARTS_MAX, next.hearts_current + 1);
  if (next.hearts_current >= (next.hearts_max || HEARTS_MAX)) {
    next.hearts_refill_started_at = null;
    next.hearts_next_refill_at = null;
  }
  return next;
}

function applyTimedHeartRefill(gameState, nowMs = Date.now()) {
  const next = { ...gameState };
  const heartsMax = next.hearts_max || HEARTS_MAX;
  const refillMs = HEART_REFILL_MS;
  if (next.hearts_current >= heartsMax) {
    next.hearts_current = heartsMax;
    next.hearts_refill_started_at = null;
    next.hearts_next_refill_at = null;
    next.hearts_refill_interval_ms = refillMs;
    return next;
  }

  let startMs = next.hearts_refill_started_at
    ? new Date(next.hearts_refill_started_at).getTime()
    : nowMs;
  if (!Number.isFinite(startMs)) startMs = nowMs;
  const elapsed = Math.max(0, nowMs - startMs);
  const gained = Math.floor(elapsed / refillMs);
  if (gained > 0) {
    next.hearts_current = Math.min(heartsMax, next.hearts_current + gained);
    startMs += gained * refillMs;
  }
  if (next.hearts_current >= heartsMax) {
    next.hearts_refill_started_at = null;
    next.hearts_next_refill_at = null;
  } else {
    next.hearts_refill_started_at = new Date(startMs).toISOString();
    next.hearts_next_refill_at = new Date(startMs + refillMs).toISOString();
  }
  next.hearts_refill_interval_ms = refillMs;
  return next;
}

module.exports = {
  POINTS_BY_LEVEL,
  HEARTS_MAX,
  HEART_REFILL_MS,
  toDayKey,
  createInitialGameState,
  normalizeLevel,
  lessonStateTransition,
  calcXpForLesson,
  updateStreak,
  applyAnswerToGameState,
  refillHeartByPractice,
  applyTimedHeartRefill,
};
