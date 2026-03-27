/**
 * Генерация вопросов для квиза из текста лекции (эвристика + опционально OpenAI).
 */

const { prepareLessonTextForQuestions } = require('./lesson-text-prep');

const STOP = new Set([
  'и', 'в', 'не', 'на', 'с', 'со', 'по', 'за', 'из', 'от', 'до', 'при', 'для', 'о', 'об', 'это', 'как', 'так', 'что',
  'а', 'но', 'или', 'же', 'ли', 'бы', 'мы', 'вы', 'они', 'он', 'она', 'его', 'их', 'им', 'том', 'тем', 'без', 'над',
  'под', 'про', 'через', 'при', 'если', 'то', 'же', 'уже', 'ещё', 'еще', 'все', 'всё', 'всех', 'этот', 'эта', 'эти',
  'такой', 'такая', 'такие', 'который', 'которая', 'которые', 'где', 'когда', 'которой', 'котором',
]);

/**
 * Строка «термин — определение» (определение до конца строки, до 900 зн.)
 */
function matchTermLine(line) {
  const s = String(line || '').trim();
  const re = /^(.{2,160}?)\s*[\u2013\u2014\u2212\uFE58\uFE63\uFF0D\-–—:]+\s*(.+)$/u;
  const m = s.match(re);
  if (!m) return null;
  const word = m[1].trim().replace(/\s+/g, ' ');
  let translation = m[2].trim().replace(/\s+/g, ' ');
  if (word.length < 2 || translation.length < 4) return null;
  translation = translation.slice(0, 900);
  return { word, translation };
}

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

function pickWrong(pool, correct, n) {
  const c = String(correct || '').toLowerCase().trim();
  const out = [];
  for (const w of shuffle(pool)) {
    const t = String(w).trim();
    if (!t || t.length < 3) continue;
    if (t.toLowerCase() === c) continue;
    if (out.some((x) => x.toLowerCase() === t.toLowerCase())) continue;
    out.push(t.slice(0, 200));
    if (out.length >= n) break;
  }
  while (out.length < n) {
    out.push(`Вариант ${out.length + 1} (не соответствует тексту)`);
  }
  return out.slice(0, n);
}

function sentencesFromText(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/u)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 28 && s.length <= 320);
}

function wordsInSentence(s) {
  return s
    .replace(/[«»"„"]/g, '')
    .split(/[\s,;()]+/u)
    .map((w) => w.replace(/^[.\-–—]+|[.\-–—]+$/g, ''))
    .filter((w) => w.length >= 5 && !STOP.has(w.toLowerCase()) && /[а-яёА-ЯЁa-zA-Z]/.test(w));
}

/**
 * @param {string} text
 * @param {{ title: string, lang: string, level: number, maxQuestions?: number }} opts
 * @returns {object[]}
 */
function generateQuestionsHeuristic(text, opts) {
  const maxQ = Math.min(20, Math.max(3, Number(opts.maxQuestions) || 12));
  const title = opts.title || 'Лекция';
  const lang = opts.lang || 'uvs';
  const level = Math.min(3, Math.max(1, Number(opts.level) || 1));
  const lines = String(text || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const questions = [];
  const termPool = [];

  for (const line of lines) {
    if (questions.length >= maxQ) break;
    const parsed = matchTermLine(line);
    if (parsed) {
      const { word, translation } = parsed;
      termPool.push(translation);
      const wrong = pickWrong(termPool.length > 4 ? termPool : [...termPool, ...sentencesFromText(text).slice(0, 8)], translation, 3);
      questions.push({
        content_theme: 'lesson-import-v1',
        lang,
        level,
        type: 'word',
        word: word.slice(0, 200),
        translation: translation.slice(0, 450),
        wrong1: wrong[0],
        wrong2: wrong[1],
        wrong3: wrong[2],
        sentence: null,
        correct: null,
        explanation: `Вопрос составлен по материалу «${title}».`,
        article_ref: `Материал: ${title}`,
      });
    }
  }

  /** Один абзац из DOCX: термины после точки или в одной строке */
  if (questions.length < 3) {
    const blob = lines.join('\n');
    const seen = new Set(questions.map((q) => `${q.word}|${q.translation}`));
    const chunks = blob
      .split(/(?<=[.!?])\s+/u)
      .flatMap((c) => c.split(/\n+/))
      .map((c) => c.trim())
      .filter(Boolean);
    for (const chunk of chunks) {
      if (questions.length >= maxQ) break;
      const parsed = matchTermLine(chunk);
      if (!parsed) continue;
      const key = `${parsed.word}|${parsed.translation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      termPool.push(parsed.translation);
      const wrong = pickWrong([...termPool, ...sentencesFromText(blob)], parsed.translation, 3);
      questions.push({
        content_theme: 'lesson-import-v1',
        lang,
        level,
        type: 'word',
        word: parsed.word.slice(0, 200),
        translation: parsed.translation.slice(0, 450),
        wrong1: wrong[0],
        wrong2: wrong[1],
        wrong3: wrong[2],
        sentence: null,
        correct: null,
        explanation: `Вопрос составлен по материалу «${title}».`,
        article_ref: `Материал: ${title}`,
      });
    }
  }

  const sents = sentencesFromText(text);
  const allWords = [];
  for (const s of sents) {
    allWords.push(...wordsInSentence(s));
  }

  for (const s of shuffle(sents)) {
    if (questions.length >= maxQ) break;
    const words = wordsInSentence(s);
    if (words.length < 4) continue;
    const idx = Math.floor(words.length / 2);
    const correct = words[idx];
    const masked = maskCyrillicWord(s, correct);
    if (!masked || !masked.includes('___')) continue;
    const wrong = pickWrong(allWords, correct, 3);
    questions.push({
      content_theme: 'lesson-import-v1',
      lang,
      level,
      type: 'sentence',
      word: null,
      translation: null,
      wrong1: wrong[0],
      wrong2: wrong[1],
      wrong3: wrong[2],
      sentence: masked.slice(0, 500),
      correct: correct.slice(0, 120),
      explanation: `Вопрос составлен по материалу «${title}».`,
      article_ref: `Материал: ${title}`,
    });
  }

  return questions.slice(0, maxQ);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * \b в JS не работает для кириллицы — границы «слова» вручную
 */
function maskCyrillicWord(sentence, word) {
  const w = String(word || '').trim();
  if (!w) return null;
  const esc = escapeRegExp(w);
  const re = new RegExp(`(^|[^а-яёА-ЯЁa-zA-Z0-9_])(${esc})(?=[^а-яёА-ЯЁa-zA-Z0-9_]|$)`, 'u');
  if (!re.test(sentence)) return null;
  return sentence.replace(re, '$1___');
}

/**
 * @param {string} text
 * @param {{ title: string, lang: string, level: number, maxQuestions?: number }} opts
 * @returns {Promise<object[]>}
 */
async function generateQuestionsFromLessonText(text, opts) {
  const maxQ = Math.min(20, Math.max(3, Number(opts.maxQuestions) || 12));
  const prepared = prepareLessonTextForQuestions(text, { maxSourceChars: 20000 });
  const ai = await tryOpenAiQuestions(prepared, { ...opts, maxQuestions: maxQ });
  if (ai && ai.length >= 3) return ai.slice(0, maxQ);
  return generateQuestionsHeuristic(prepared, { ...opts, maxQuestions: maxQ });
}

async function tryOpenAiQuestions(text, opts) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const excerpt = String(text || '').slice(0, 16000);
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const prompt = `Ниже фрагменты учебного текста (уже очищены от повторов колонтитулов и мусора). Составь до ${opts.maxQuestions} вопросов для теста строго по смыслу этих фрагментов — не выдумывай факты вне текста.
Каждый вопрос — либо термин с определением (type "word"), либо предложение с пропуском (type "sentence").
Формат: JSON-массив объектов без пояснений и markdown.
Поля для word: type, word, translation, wrong1, wrong2, wrong3.
Поля для sentence: type, sentence (с пропуском ___), correct, wrong1, wrong2, wrong3.
Все формулировки на русском. Неверные варианты правдоподобны, но неверны по тексту.
Название материала: ${opts.title}

Текст:
${excerpt}`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.25,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    let jsonStr = raw.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '');
    }
    const arr = JSON.parse(jsonStr);
    if (!Array.isArray(arr)) return null;
    const lang = opts.lang || 'uvs';
    const level = Math.min(3, Math.max(1, Number(opts.level) || 1));
    return arr
      .filter((q) => q && (q.type === 'word' || q.type === 'sentence'))
      .map((q) => {
        if (q.type === 'word') {
          return {
            content_theme: 'lesson-import-v1',
            lang,
            level,
            type: 'word',
            word: String(q.word || '').slice(0, 200),
            translation: String(q.translation || '').slice(0, 450),
            wrong1: String(q.wrong1 || '').slice(0, 200),
            wrong2: String(q.wrong2 || '').slice(0, 200),
            wrong3: String(q.wrong3 || '').slice(0, 200),
            sentence: null,
            correct: null,
            explanation: `Вопрос сгенерирован ИИ по материалу «${opts.title}».`,
            article_ref: `Материал: ${opts.title}`,
          };
        }
        return {
          content_theme: 'lesson-import-v1',
          lang,
          level,
          type: 'sentence',
          word: null,
          translation: null,
          wrong1: String(q.wrong1 || '').slice(0, 200),
          wrong2: String(q.wrong2 || '').slice(0, 200),
          wrong3: String(q.wrong3 || '').slice(0, 200),
          sentence: String(q.sentence || '').slice(0, 500),
          correct: String(q.correct || '').slice(0, 120),
          explanation: `Вопрос сгенерирован ИИ по материалу «${opts.title}».`,
          article_ref: `Материал: ${opts.title}`,
        };
      })
      .filter((q) =>
        q.type === 'word'
          ? q.word && q.translation
          : q.sentence && q.correct && q.sentence.includes('___')
      );
  } catch {
    return null;
  }
}

module.exports = {
  generateQuestionsFromLessonText,
  generateQuestionsHeuristic,
};
