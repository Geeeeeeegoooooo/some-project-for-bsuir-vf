/**
 * Уровень слота пути (индекс как в public/app.js STATUTE_SECTIONS) и ключевые слова
 * для отбора вопросов под тему узла. null — весь пул уровня (итоговые/смешанные уроки).
 */
/** 20 узлов: du / gks / su и прежняя сетка. */
const LEVELS_20 = [1, 1, 1, 2, 2, 2, 3, 3, 3, 1, 2, 3, 2, 3, 3, 1, 2, 2, 3, 3];
/** УВС: модуль 1 — 10 разделов (ур. 1), далее как раньше со сдвигом индексов. */
const LEVELS_UVS_27 = [...Array(10).fill(1), 2, 2, 2, 3, 3, 3, 1, 2, 3, 2, 3, 3, 1, 2, 2, 3, 3];
const MODULE_20 = [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 6, 6];
const MODULE_UVS_27 = [...Array(10).fill(1), 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 6, 6];

const PATH_LEVEL_BY_SLOT = {
  uvs: LEVELS_UVS_27,
  du: LEVELS_20,
  gks: LEVELS_20,
  su: LEVELS_20,
};

const MODULE_BY_SLOT_BY_LANG = {
  uvs: MODULE_UVS_27,
  du: MODULE_20,
  gks: MODULE_20,
  su: MODULE_20,
};

function moduleRowForLang(lang) {
  return MODULE_BY_SLOT_BY_LANG[String(lang || 'uvs')] || MODULE_UVS_27;
}

function slotIndicesForModule(lang, moduleNum) {
  const M = Number(moduleNum);
  return moduleRowForLang(lang).map((m, i) => (m === M ? i : -1)).filter((i) => i >= 0);
}

/** Удаляет из question_coverage ключи всех уроков указанного модуля (для повторного прохождения). */
function clearQuestionCoverageForModule(coverageMap, lang, moduleNum) {
  const L = String(lang || 'uvs');
  const qc = coverageMap && typeof coverageMap === 'object' ? { ...coverageMap } : {};
  const levels = PATH_LEVEL_BY_SLOT[L] || PATH_LEVEL_BY_SLOT.uvs;
  slotIndicesForModule(L, moduleNum).forEach((idx) => {
    const lev = levels[idx];
    delete qc[`${L}:${lev}:${idx}`];
  });
  return qc;
}

/** Ключевые фрагменты (нижний регистр) в тексте вопроса / пояснении */
const UVS_SLOT_TAIL = [
  ['прав', 'обязанност', 'ответственн', 'военнослужащ', 'долг', 'присяг'],
  ['взаимоотношен', 'субордин', 'старш по зван', 'уважен', 'достоинств'],
  ['единоначал', 'приказ', 'приказан', 'командир част', 'начальник штаба', 'подразделен'],
  ['распределен', 'времен', 'сон', 'питан', 'промежуток', 'недел', 'отпуск', 'контракт'],
  ['суточн', 'наряд', 'дневальн', 'дежурн', 'караул', 'развод', 'кпп', 'медпункт', 'посыльн', 'парк'],
  ['пожар', 'охран труд', 'тревог', 'безопасн', 'тсо'],
  ['имуществ', 'материальн', 'учёт', 'инвентар', 'бережн', 'хранен'],
  ['помещен', 'санитар', 'допуск', 'посторон', 'температур', 'воздух'],
  ['увольнен', 'гарнизон', 'расположен', 'выезд'],
  ['гражданск', 'взаимодейств'],
  ['нарушен', 'распоряд', 'особ'],
  null,
  ['журнал', 'учёт', 'карточк', 'документ'],
  ['комендантск', 'посещен', 'ноч'],
  ['дежурн', 'взаимодейств', 'оповещен', 'тревог'],
  ['нарушен', 'наряд', 'реакц'],
  null,
];

const SLOT_KEYWORDS = {
  uvs: [
    ['присяг', 'приведен', 'клятв', 'текст военн', 'разъяснител'],
    ['флаг', 'государствен', 'церемон', 'торже', 'трибун', 'закрыт класс'],
    ['гимн', 'праздничн', 'праздник', 'день принесен'],
    ['приветств', 'козырьк', 'строю', 'воинск', 'встреч'],
    ['знам', 'боевое знам', 'знамен', 'символ боев', 'утрат'],
    ['президент', 'вручен', 'грамот', 'осмотр', 'начальник штаба', 'хранен'],
    ['присутств', 'личн состав', 'вечерн', 'поверк', 'построен', 'наличи'],
    ['размещ', 'казарм', 'оруж', 'комнат', 'ключ', 'пирамид', 'срочник'],
    ['распорядок дня', 'сон', 'питан', 'промежуток', 'недел', 'контракт', 'выезд', 'увольнен'],
    ['уборк', 'санитар', 'чистот', 'температур', 'воздух', 'гигиен', 'медпункт', 'здоров'],
    ...UVS_SLOT_TAIL,
  ],
  du: [
    ['дисциплин', 'воинск', 'служб'],
    ['подчин', 'единоначал', 'начальник', 'приказ'],
    ['статус', 'субордин', 'быту'],
    ['поощр', 'благодарност'],
    ['взыскан', 'выговор', 'арест'],
    ['проступк', 'тяжест', 'мер'],
    ['обжалован', 'прав', 'жалоб'],
    ['кейс', 'разбор', 'разбирательств'],
    ['документооборот', 'срок', 'порядок'],
    ['срок', 'регламент', 'нарушен'],
    ['комитет', 'практик'],
    ['командир', 'воспитан', 'ответственн'],
    ['конфликт', 'приказ'],
    ['тяжёл', 'особ'],
    null,
    ['срок', 'погашен', 'наложен'],
    ['объявлен', 'поощр', 'учёт'],
    ['служебн положен', 'взыскан'],
    ['подчин', 'приказ', 'сложн'],
    null,
  ],
  gks: [
    ['караул', 'организац', 'служб'],
    ['часов', 'пост', 'обязанност'],
    ['заступлен', 'смен', 'посту'],
    ['развод', 'смена караул'],
    ['сигнал', 'безопасн'],
    ['патрул', 'объект'],
    ['тревог', 'оборон'],
    ['оборон', 'практик'],
    ['внутренн', 'наряд', 'взаимодейств'],
    ['периметр', 'пропуск', 'кпп'],
    ['разоружен', 'задержан', 'нарушител'],
    ['ночн', 'услов'],
    ['пожар', 'посту'],
    ['посетител', 'переговор'],
    null,
    ['пропускн', 'документ', 'кпп'],
    ['внутренн', 'наряд', 'караул'],
    ['чс', 'охран'],
    ['смен', 'сложн'],
    null,
  ],
  su: [
    ['строй', 'стойк', 'смирн'],
    ['команд', 'строев', 'приём'],
    ['равнен', 'интервал', 'дистанц'],
    ['шаг', 'движен', 'марш'],
    ['поворот', 'перестроен'],
    ['снят', 'остановк', 'ходьб'],
    ['торжествен', 'марш'],
    ['сложн', 'строев'],
    ['рапорт', 'начальник', 'строю'],
    ['смотр', 'внешн', 'вид'],
    ['команд', 'песн'],
    ['плац', 'разворот'],
    ['торжествен', 'мероприят'],
    ['флаг', 'знам', 'караул', 'строю'],
    null,
    ['построен', 'внешн'],
    ['перестроен', 'колонн'],
    ['торжествен', 'выход', 'рапорт'],
    ['ошибк', 'строю', 'исправлен'],
    null,
  ],
};

function haystackForQuestion(q) {
  return [
    q.word,
    q.sentence,
    q.translation,
    q.correct,
    q.wrong1,
    q.wrong2,
    q.wrong3,
    q.article_ref,
    q.explanation,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function questionMatchesSlotKeywords(q, keywords) {
  if (!keywords || !keywords.length) return true;
  const h = haystackForQuestion(q);
  return keywords.some((kw) => h.includes(kw));
}

/** Вопрос без path_slots на уровне 1: только если текст попадает в тему слота (как узкие уроки Duolingo). */
function untaggedMatchesLessonSlot(q, lang, lessonSlot) {
  const lev = Number(q.level) || 1;
  if (lev !== 1) return true;
  const L = String(lang || 'uvs');
  const slot = Math.max(0, Number(lessonSlot) || 0);
  const byLang = SLOT_KEYWORDS[L];
  if (!byLang || slot >= byLang.length) return true;
  const kws = byLang[slot];
  if (kws == null || !kws.length) return true;
  return questionMatchesSlotKeywords(q, kws);
}

/**
 * Пул вопросов для урока: узкая выборка по теме слота, при нехватке — смесь с остальным пулом.
 */
function narrowPoolForLessonSlot(uniqPool, lang, lessonSlot, minPreferred) {
  const L = String(lang || 'uvs');
  const slot = Math.max(0, Number(lessonSlot) || 0);
  const byLang = SLOT_KEYWORDS[L];
  if (!byLang || slot >= byLang.length) return uniqPool;
  const kws = byLang[slot];
  if (kws == null) return uniqPool;

  const narrow = uniqPool.filter((q) => questionMatchesSlotKeywords(q, kws));
  const need = Math.min(uniqPool.length, Math.max(minPreferred, 24));
  if (narrow.length >= need) return narrow;

  const qkey = (q) => (q && q.id != null && q.id !== undefined ? `id:${q.id}` : haystackForQuestion(q));
  const keyN = new Set(narrow.map((q) => qkey(q)));
  const rest = uniqPool.filter((q) => !keyN.has(qkey(q)));
  const take = Math.min(rest.length, Math.max(0, need - narrow.length + Math.ceil(uniqPool.length * 0.15)));
  const start = (slot * 17) % Math.max(1, rest.length);
  const rotated = rest.length ? [...rest.slice(start), ...rest.slice(0, start)] : [];
  return [...narrow, ...rotated.slice(0, take)];
}

function slotLevelExpected(lang, lessonSlot) {
  const L = String(lang || 'uvs');
  const arr = PATH_LEVEL_BY_SLOT[L];
  if (!arr || lessonSlot < 0 || lessonSlot >= arr.length) return null;
  return Number(arr[lessonSlot]) || null;
}

function computeMasteryByLevelFromLessons(lang, masteryByLesson) {
  const mbl = masteryByLesson && typeof masteryByLesson === 'object' ? masteryByLesson : {};
  const L = String(lang || 'uvs');
  const levels = PATH_LEVEL_BY_SLOT[L];
  if (!levels || !levels.length) return { 1: 0, 2: 0, 3: 0 };
  const sum = { 1: 0, n1: 0, 2: 0, n2: 0, 3: 0, n3: 0 };
  levels.forEach((lvl, idx) => {
    const v = Number(mbl[`${L}:${idx}`] || 0);
    const key = Number(lvl);
    if (key === 1) {
      sum[1] += v;
      sum.n1 += 1;
    } else if (key === 2) {
      sum[2] += v;
      sum.n2 += 1;
    } else if (key === 3) {
      sum[3] += v;
      sum.n3 += 1;
    }
  });
  return {
    1: sum.n1 ? Math.min(100, Math.round(sum[1] / sum.n1)) : 0,
    2: sum.n2 ? Math.min(100, Math.round(sum[2] / sum.n2)) : 0,
    3: sum.n3 ? Math.min(100, Math.round(sum[3] / sum.n3)) : 0,
  };
}

module.exports = {
  PATH_LEVEL_BY_SLOT,
  /** @deprecated используйте MODULE_BY_SLOT_BY_LANG; для УВС длина 27 */
  MODULE_BY_SLOT: MODULE_20,
  MODULE_BY_SLOT_BY_LANG,
  SLOT_KEYWORDS,
  narrowPoolForLessonSlot,
  questionMatchesSlotKeywords,
  untaggedMatchesLessonSlot,
  slotLevelExpected,
  slotIndicesForModule,
  clearQuestionCoverageForModule,
  computeMasteryByLevelFromLessons,
};
