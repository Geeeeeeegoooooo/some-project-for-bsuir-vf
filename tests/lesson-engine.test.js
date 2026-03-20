const test = require('node:test');
const assert = require('node:assert/strict');
const {
  lessonStateTransition,
  calcXpForLesson,
  updateStreak,
  applyAnswerToGameState,
  refillHeartByPractice,
  createInitialGameState,
  applyTimedHeartRefill,
  HEART_REFILL_MS,
} = require('../lesson-engine');

test('lesson state machine allows valid transitions', () => {
  assert.equal(lessonStateTransition('created', 'start'), 'in_progress');
  assert.equal(lessonStateTransition('in_progress', 'answer'), 'in_progress');
  assert.equal(lessonStateTransition('in_progress', 'complete'), 'completed');
});

test('lesson state machine blocks invalid transitions', () => {
  assert.throws(() => lessonStateTransition('completed', 'answer'));
  assert.throws(() => lessonStateTransition('created', 'complete'));
});

test('xp calculation gives higher reward for perfect lesson', () => {
  const perfect = calcXpForLesson({ level: 2, correctCount: 5, totalCount: 5, isPerfect: true });
  const nonPerfect = calcXpForLesson({ level: 2, correctCount: 3, totalCount: 5, isPerfect: false });
  assert.ok(perfect > nonPerfect);
  assert.ok(perfect > 0);
});

test('streak increments on next day and stays same on same day', () => {
  const base = createInitialGameState();
  base.streak_current = 2;
  base.streak_last_day = '2026-02-15';

  const sameDay = updateStreak(base, '2026-02-15');
  assert.equal(sameDay.streak_current, 2);

  const nextDay = updateStreak(base, '2026-02-16');
  assert.equal(nextDay.streak_current, 3);
});

test('streak uses freeze when gap > 1 day', () => {
  const base = createInitialGameState();
  base.streak_current = 5;
  base.streak_last_day = '2026-02-10';
  base.freeze_count = 1;
  const next = updateStreak(base, '2026-02-13');
  assert.equal(next.streak_current, 6);
  assert.equal(next.freeze_count, 0);
});

test('hearts decrease only on wrong answer and can be refilled', () => {
  const base = createInitialGameState();
  const afterWrong = applyAnswerToGameState(base, false);
  assert.equal(afterWrong.hearts_current, base.hearts_current - 1);

  const afterCorrect = applyAnswerToGameState(afterWrong, true);
  assert.equal(afterCorrect.hearts_current, afterWrong.hearts_current);

  const afterPractice = refillHeartByPractice(afterWrong);
  assert.equal(afterPractice.hearts_current, base.hearts_current);
});

test('skipHeartPenalty keeps hearts on wrong answer (лёгкий уровень)', () => {
  const base = createInitialGameState();
  const afterWrong = applyAnswerToGameState(base, false, { skipHeartPenalty: true });
  assert.equal(afterWrong.hearts_current, base.hearts_current);
});

test('hearts refill over time when below max', () => {
  const base = createInitialGameState();
  base.hearts_current = 2;
  base.hearts_refill_started_at = new Date('2026-01-01T00:00:00.000Z').toISOString();

  const now = new Date('2026-01-01T00:02:01.000Z').getTime();
  const next = applyTimedHeartRefill(base, now);
  // 2 minutes = 2 hearts refill (every 1 min)
  assert.equal(next.hearts_current, 4);
  assert.ok(next.hearts_next_refill_at);

  const full = applyTimedHeartRefill(next, now + HEART_REFILL_MS);
  assert.equal(full.hearts_current, 5);
  assert.equal(full.hearts_next_refill_at, null);
});
