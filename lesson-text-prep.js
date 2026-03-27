/**
 * Отбор содержательного текста из сырого извлечения (PDF/DOCX/вставка):
 * убираем повторы колонтитулов, пустяки, даём ИИ/эвристике не «простыню», а учебные фрагменты.
 */

const STOP = new Set([
  'и', 'в', 'не', 'на', 'с', 'со', 'по', 'за', 'из', 'от', 'до', 'при', 'для', 'о', 'об', 'это', 'как', 'так', 'что',
  'а', 'но', 'или', 'же', 'ли', 'бы', 'мы', 'вы', 'они', 'он', 'она', 'его', 'их', 'им', 'том', 'тем', 'без', 'над',
  'под', 'про', 'через', 'если', 'то', 'уже', 'ещё', 'еще', 'все', 'всё', 'всех', 'этот', 'эта', 'эти', 'такой',
  'такая', 'такие', 'который', 'которая', 'которые', 'где', 'когда', 'которой', 'котором', 'также', 'либо',
  'данный', 'данная', 'данное', 'данные', 'является', 'являются', 'будет', 'были', 'было', 'была', 'был',
]);

function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]*/g, '\n')
    .replace(/[ \t]*\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** PDF часто отдаёт одну строку — режем на псевдоабзацы по концу предложения перед заглавной буквой. */
function breakWallOfText(text) {
  const t = String(text || '');
  if (t.length < 900 || t.includes('\n\n')) return t;
  return t.replace(/([.!?])\s+(?=[А-ЯЁA-Z])/gu, '$1\n\n');
}

function isNoiseLine(line) {
  const s = line.trim();
  if (s.length < 2) return true;
  if (/^(стр\.?\s*\d+|\d+\s*)$/i.test(s)) return true;
  if (/^https?:\/\/\S+$/i.test(s) && s.length < 200) return true;
  if (/^[\d\s.\-–—]{1,24}$/.test(s)) return true;
  if (/^(страница|page)\s*\d+/i.test(s)) return true;
  return false;
}

function looksLikeDefinitionLine(k) {
  return /.{2,120}\s*[—–\-:]\s*\S/u.test(k);
}

function repeatedBoilerplateKeys(lines) {
  const counts = new Map();
  for (const line of lines) {
    const k = line.toLowerCase().replace(/\s+/g, ' ').trim();
    if (k.length < 6 || k.length > 200) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const out = new Set();
  for (const [k, c] of counts) {
    if (c < 3) continue;
    if (looksLikeDefinitionLine(k)) continue;
    out.add(k);
  }
  return out;
}

function scoreChunk(chunk) {
  const p = String(chunk || '').trim();
  if (p.length < 28) return -100;
  const words = p.split(/\s+/).filter(Boolean);
  const hasTermSep = /[—–\-:]\s*\S/u.test(p);
  if (words.length < 4) return -80;
  if (words.length < 6 && !hasTermSep) return -28;
  let score = Math.min(words.length, 150) * 0.12;
  const uniq = new Set(words.map((w) => w.toLowerCase().replace(/[^а-яёa-z0-9]/gi, '')).filter(Boolean));
  if (words.length >= 8 && uniq.size / words.length < 0.18) score -= 22;
  for (const w of words) {
    const key = w.toLowerCase().replace(/[^а-яёa-z]/gi, '');
    if (key && STOP.has(key)) score -= 0.06;
  }
  if (/[—–\-:]\s*\S/.test(p)) score += 2.2;
  if (hasTermSep && words.length <= 16 && p.length < 260) score += 5.5;
  if (/\d/.test(p)) score += 0.4;
  if (/^(статья|пункт|раздел|глава|тема|лекция)\s+\d+/i.test(p)) score += 1.5;
  if (p === p.toUpperCase() && p.length < 55) score -= 1.2;
  const termish = (p.match(/[—–\-]/g) || []).length;
  score += Math.min(termish, 4) * 0.35;
  return score;
}

function linesToParagraphs(lines) {
  const paras = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const joined = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (joined.length >= 12) paras.push(joined);
    buf = [];
  };
  for (const line of lines) {
    if (!line || !String(line).trim()) {
      flush();
      continue;
    }
    const isHeading =
      (line.length < 72 && line.endsWith(':') && !line.includes('. ')) ||
      /^(глава|раздел|тема|лекция|\d+[\.)])\s+/i.test(line.trim());
    if (isHeading && buf.length) flush();
    buf.push(line.trim());
    if (buf.join(' ').length > 520) flush();
  }
  flush();
  return paras;
}

function splitIntoChunks(text) {
  let t = normalizeWhitespace(breakWallOfText(text));
  const rawLines = t.split('\n').map((l) => l.trim());
  const nonEmptyForCount = rawLines.filter(Boolean);
  const boiler = repeatedBoilerplateKeys(nonEmptyForCount);
  const lines = [];
  for (const l of rawLines) {
    if (!l) {
      lines.push('');
      continue;
    }
    if (isNoiseLine(l)) continue;
    const k = l.toLowerCase().replace(/\s+/g, ' ').trim();
    if (boiler.has(k)) continue;
    lines.push(l);
  }
  let paras = linesToParagraphs(lines);
  if (paras.length === 0) {
    paras = t.split(/\n\s*\n/).map((x) => x.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()).filter((x) => x.length > 30);
  }
  if (paras.length <= 1 && (paras[0] || '').length > 1800) {
    const sents = (paras[0] || t).split(/(?<=[.!?])\s+/u).map((s) => s.trim()).filter((s) => s.length > 18);
    const out = [];
    let cur = '';
    for (const s of sents) {
      const next = cur ? `${cur} ${s}` : s;
      if (next.length > 380) {
        if (cur) out.push(cur);
        cur = s;
      } else {
        cur = next;
      }
    }
    if (cur) out.push(cur);
    paras = out.filter((x) => x.length > 30);
  }
  return paras;
}

/**
 * Собирает до maxChars символов из наиболее «учебных» фрагментов, сохраняя разнообразие (не только топ-1).
 * @param {string} rawText
 * @param {number} maxChars
 * @returns {string}
 */
function buildTeachingCorpus(rawText, maxChars) {
  const chunks = splitIntoChunks(rawText);
  if (!chunks.length) return '';
  const ranked = chunks
    .map((c, i) => ({ c, s: scoreChunk(c), i }))
    .filter((x) => x.s > -10)
    .sort((a, b) => b.s - a.s);
  const picked = [];
  const seen = new Set();
  const take = (c) => {
    const key = c.slice(0, 120).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    picked.push(c);
  };
  for (const { c } of ranked) {
    take(c);
  }
  for (const c of chunks) {
    if (picked.length >= ranked.length) break;
    take(c);
  }
  const ordered = [];
  const budget = maxChars;
  let used = 0;
  for (const p of picked) {
    if (used >= budget) break;
    const rest = budget - used;
    if (p.length <= rest) {
      ordered.push(p);
      used += p.length + 2;
    } else if (rest > 400) {
      ordered.push(`${p.slice(0, rest - 3)}…`);
      used = budget;
      break;
    }
  }
  let corpus = ordered.join('\n\n').trim();
  if (corpus.length < 200 && rawText.length >= 200) {
    corpus = String(rawText).trim().slice(0, maxChars);
  }
  return corpus;
}

/**
 * @param {string} rawText
 * @param {{ maxSourceChars?: number }} [opts]
 * @returns {string}
 */
function prepareLessonTextForQuestions(rawText, opts = {}) {
  const maxChars = Math.min(28000, Math.max(2000, Number(opts.maxSourceChars) || 16000));
  const raw = String(rawText || '').trim();
  if (raw.length < 120) return raw;
  try {
    const corpus = buildTeachingCorpus(raw, maxChars);
    if (corpus && corpus.length >= 120) return corpus;
  } catch {
    /* ignore */
  }
  return raw.slice(0, maxChars);
}

module.exports = {
  prepareLessonTextForQuestions,
  normalizeWhitespace,
  buildTeachingCorpus,
};
