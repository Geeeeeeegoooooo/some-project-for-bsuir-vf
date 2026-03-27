/**
 * Удаляет вопросы и материалы, созданные через админ-панель (импорт лекций).
 * Запуск: node scripts/clear-lesson-imports.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const DATA_JSON = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, '..', 'data.json');

async function clearPostgres() {
  const { pool } = require('../db/pool');
  const client = await pool.connect();
  try {
    const delQ = await client.query(
      `DELETE FROM questions WHERE content_theme = $1 OR lesson_material_id IS NOT NULL`,
      ['lesson-import-v1']
    );
    const delM = await client.query('DELETE FROM lesson_materials');
    console.log(`PostgreSQL: удалено вопросов: ${delQ.rowCount}, записей lesson_materials: ${delM.rowCount}`);
  } finally {
    client.release();
    await pool.end();
  }
}

function clearJsonFile() {
  if (!fs.existsSync(DATA_JSON)) {
    console.log('Файл data.json не найден, пропуск.');
    return;
  }
  const raw = fs.readFileSync(DATA_JSON, 'utf8');
  const data = JSON.parse(raw);
  const before = (data.questions || []).length;
  data.questions = (data.questions || []).filter(
    (q) => q.content_theme !== 'lesson-import-v1' && q.lesson_material_id == null
  );
  const after = data.questions.length;
  data.lesson_materials = [];
  fs.writeFileSync(DATA_JSON, JSON.stringify(data, null, 2), 'utf8');
  console.log(`data.json: удалено вопросов: ${before - after}, lesson_materials очищен.`);
}

(async () => {
  if (process.env.DATABASE_URL) {
    await clearPostgres();
  } else {
    clearJsonFile();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
