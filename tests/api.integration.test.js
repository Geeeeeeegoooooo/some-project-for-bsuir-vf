const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

function getSetCookie(headers) {
  const raw = headers.get('set-cookie');
  if (!raw) return null;
  return raw.split(';')[0];
}

test('path, placement and lesson flow integration', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyglot-test-'));
  const dataFile = path.join(tmpDir, 'data.json');
  process.env.DATA_FILE = dataFile;

  // eslint-disable-next-line global-require
  const app = require('../server');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  let cookie = '';
  const email = `user_${Date.now()}@test.local`;

  try {
    const regRes = await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username: 'Tester', password: 'abc12345' }),
    });
    assert.equal(regRes.status, 200);
    cookie = getSetCookie(regRes.headers) || '';
    assert.ok(cookie.length > 0);

    const pathRes = await fetch(`${base}/api/path?lang=uvs`, {
      headers: { Cookie: cookie },
    });
    assert.equal(pathRes.status, 200);
    const pathData = await pathRes.json();
    assert.ok(Array.isArray(pathData.units));
    assert.ok(pathData.units.length > 0);

    const placementStart = await fetch(`${base}/api/placement/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ lang: 'uvs' }),
    });
    assert.equal(placementStart.status, 200);
    const placementData = await placementStart.json();
    assert.ok(placementData.attempt_id);
    assert.ok(Array.isArray(placementData.questions));

    const placementAnswers = placementData.questions.map((q) => ({
      idx: q.idx,
      answer: q.options[0],
    }));

    const placementComplete = await fetch(`${base}/api/placement/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ attempt_id: placementData.attempt_id, answers: placementAnswers }),
    });
    assert.equal(placementComplete.status, 200);
    const placementResult = await placementComplete.json();
    assert.ok([1, 2, 3].includes(Number(placementResult.recommended_level)));

    const lessonStart = await fetch(`${base}/api/lesson/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ lang: 'uvs', level: 1, question_count: 1 }),
    });
    assert.equal(lessonStart.status, 200);
    const lessonData = await lessonStart.json();
    assert.ok(lessonData.attempt_id);
    assert.ok(Array.isArray(lessonData.exercises));
    assert.equal(lessonData.exercises.length, 1);

    const ex = lessonData.exercises[0];
    const ansRes = await fetch(`${base}/api/lesson/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        attempt_id: lessonData.attempt_id,
        exercise_id: ex.exercise_id,
        answer: ex.options[0],
      }),
    });
    assert.equal(ansRes.status, 200);

    const completeRes = await fetch(`${base}/api/lesson/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ attempt_id: lessonData.attempt_id }),
    });
    assert.equal(completeRes.status, 200);
    const completeData = await completeRes.json();
    assert.ok(Number(completeData.xp_awarded) >= 0);

    const questsRes = await fetch(`${base}/api/quests/daily`, {
      headers: { Cookie: cookie },
    });
    assert.equal(questsRes.status, 200);
    const quests = await questsRes.json();
    assert.ok(Array.isArray(quests));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATA_FILE;
  }
});
