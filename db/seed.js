#!/usr/bin/env node
/**
 * Запуск: npm run db:seed (читает .env)
 * Сначала выполните schema.sql в pgAdmin.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const ALL_QUESTIONS = require('../questions-data');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  if (!process.env.DATABASE_URL) {
    console.error('Установите DATABASE_URL');
    process.exit(1);
  }
  const client = await pool.connect();
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await client.query(schema);
    console.log('Схема применена');

    const userCount = (await client.query('SELECT COUNT(*) FROM users')).rows[0].count;
    if (Number(userCount) === 0) {
      const plain = 'admin123';
      await client.query(
        'INSERT INTO users (email, password, password_plain, username) VALUES ($1, $2, $3, $4)',
        ['admin@test.com', bcrypt.hashSync(plain, 10), plain, 'Admin']
      );
      console.log('Создан пользователь admin@test.com / admin123');
    } else {
      await client.query(
        "UPDATE users SET password_plain = 'admin123' WHERE email = 'admin@test.com' AND password_plain IS NULL"
      );
    }

    const qCount = Number((await client.query('SELECT COUNT(*) FROM questions')).rows[0].count);
    const needSeed = qCount < 20 || qCount !== ALL_QUESTIONS.length;
    console.log(`Вопросов в БД: ${qCount}, в файле: ${ALL_QUESTIONS.length}, нужен сид: ${needSeed}`);
    if (needSeed) {
      await client.query('TRUNCATE TABLE questions RESTART IDENTITY');
      for (const q of ALL_QUESTIONS) {
        await client.query(
          `INSERT INTO questions (content_theme, lang, level, type, word, translation, wrong1, wrong2, wrong3, sentence, correct, explanation, article_ref)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
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
            q.explanation || null,
            q.article_ref || null,
          ]
        );
      }
      console.log(`Добавлено ${ALL_QUESTIONS.length} вопросов`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
