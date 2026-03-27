/**
 * Извлечение текста из учебных файлов (PDF, DOCX, PPTX, HTML, TXT и др.).
 */
const path = require('path');
const JSZip = require('jszip');

const SUPPORTED_EXT = new Set([
  '.txt', '.md', '.text',
  '.pdf',
  '.docx',
  '.pptx',
  '.html', '.htm',
  '.csv',
  '.json',
]);

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function extractFromPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
    .sort((a, b) => {
      const na = parseInt(a.replace(/\D/g, ''), 10) || 0;
      const nb = parseInt(b.replace(/\D/g, ''), 10) || 0;
      return na - nb;
    });
  const chunks = [];
  for (const name of names) {
    const xml = await zip.file(name).async('string');
    const parts = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((m) => m[1]);
    if (parts.length) chunks.push(parts.join(' '));
  }
  return chunks.join('\n\n');
}

async function extractFromPdf(buffer) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(buffer);
  return (data.text || '').replace(/\s+/g, ' ').trim();
}

async function extractFromDocx(buffer) {
  const mammoth = require('mammoth');
  const { value } = await mammoth.extractRawText({ buffer });
  let t = String(value || '');
  t = t.replace(/\r\n/g, '\n').replace(/[ \t\f\v]+/g, ' ');
  t = t.replace(/\n[ \t]*/g, '\n').replace(/[ \t]*\n/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  if (!t.replace(/\s/g, '').length) return '';
  return t;
}

/**
 * @param {Buffer} buffer
 * @param {string} originalName
 * @returns {Promise<{ text: string, ext: string }>}
 */
async function extractLessonText(buffer, originalName) {
  const ext = path.extname(originalName || '').toLowerCase() || '.bin';
  if (ext === '.pdf') {
    const text = await extractFromPdf(buffer);
    return { text, ext };
  }
  if (ext === '.docx') {
    const text = await extractFromDocx(buffer);
    return { text, ext };
  }
  if (ext === '.pptx') {
    const text = await extractFromPptx(buffer);
    return { text, ext };
  }
  if (ext === '.html' || ext === '.htm') {
    const text = stripHtml(buffer.toString('utf8'));
    return { text, ext };
  }
  if (ext === '.txt' || ext === '.md' || ext === '.text') {
    let text = buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    text = text.replace(/[ \t\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return { text, ext };
  }
  if (ext === '.csv' || ext === '.json') {
    const text = buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
    return { text, ext };
  }
  const err = new Error(
    `Формат «${ext || 'неизвестен'}» не поддерживается. Загрузите PDF, DOCX, PPTX, HTML или TXT, либо вставьте текст в форму.`
  );
  err.code = 'UNSUPPORTED_FORMAT';
  throw err;
}

function isSupportedExtension(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return SUPPORTED_EXT.has(ext);
}

module.exports = {
  extractLessonText,
  isSupportedExtension,
  SUPPORTED_EXT,
};
