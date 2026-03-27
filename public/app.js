const API = '/api';

let currentUser = null;
let questions = [];
let currentIndex = 0;
let score = 0;
let pointsPerQuestion = 10;
let lessonAttemptId = null;
/** Индекс узла в STATUTE_SECTIONS для выбранного языка; задаёт слот урока и подпись в квизе. */
let lessonSlotIndex = 0;
/** Урок уровня 1: сердца не списываются (сервер hearts_unlimited). */
let lessonHeartsUnlimited = false;
let gameState = { hearts_current: 5, streak_current: 0, xp_total: 0 };
let uiTickerStarted = false;
/** Урок запущен с карты «Обучение»; по «Выбрать уровень снова» возвращаем на путь, а не остаёмся в «Задания». */
let quizLaunchedFromPath = false;

const screens = {
  home: 'screen-home',
  login: 'screen-login',
  register: 'screen-register',
  path: 'screen-path',
  quiz: 'screen-quiz',
  placement: 'screen-placement',
  leaderboard: 'screen-leaderboard',
  profile: 'screen-profile',
  admin: 'screen-admin',
};

const LANG_NAMES = {
  uvs: 'уставе внутренней службы',
  du: 'дисциплинарном уставе',
  gks: 'уставе гарнизонной и караульной служб',
  su: 'строевом уставе'
};

const PROFICIENCY_OPTIONS = [
  { level: 1, tier: 'Новичок', desc: 'Лёгкие вопросы', text: 'Только начинаю изучать уставы' },
  { level: 2, tier: 'Средний', desc: 'Вопросы средней сложности', text: 'Знаю основные положения и порядок службы' },
  { level: 3, tier: 'Эксперт', desc: 'Сложные ситуационные задачи', text: 'Уверенно ориентируюсь в нормах уставов' }
];

const RANKS = [
  { title: 'Рядовой', minXp: 0 },
  { title: 'Ефрейтор', minXp: 120 },
  { title: 'Младший сержант', minXp: 280 },
  { title: 'Сержант', minXp: 500 },
  { title: 'Старший сержант', minXp: 780 },
  { title: 'Прапорщик', minXp: 1120 },
  { title: 'Лейтенант', minXp: 1520 },
  { title: 'Капитан', minXp: 2000 },
  { title: 'Полковник', minXp: 2600 },
  { title: 'Генерал-майор', minXp: 3200 },
  { title: 'Генерал-лейтенант', minXp: 3900 },
  { title: 'Генерал-полковник', minXp: 4700 },
  { title: 'Главнокомандующий', minXp: 5600 }
];

function getRankByXp(xpTotal) {
  const xp = Math.max(0, Number(xpTotal || 0));
  let current = RANKS[0];
  let next = null;
  for (let i = 0; i < RANKS.length; i += 1) {
    const rank = RANKS[i];
    if (xp >= rank.minXp) {
      current = rank;
      next = RANKS[i + 1] || null;
    }
  }
  if (!next) {
    return {
      current,
      next: null,
      progressPct: 100,
      progressText: 'Максимальное звание достигнуто',
    };
  }
  const span = Math.max(1, next.minXp - current.minXp);
  const inRank = Math.max(0, xp - current.minXp);
  const progressPct = Math.max(0, Math.min(100, Math.round((inRank / span) * 100)));
  const left = Math.max(0, next.minXp - xp);
  return {
    current,
    next,
    progressPct,
    progressText: `${left} XP до звания «${next.title}»`,
  };
}

function showScreen(name, opts = {}) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(screens[name]);
  if (el) {
    el.classList.add('active');
    // Управляемый фокус при смене экранов (улучшает UX для клавиатуры и screen readers)
    let focusTarget = el.querySelector('h1, h2');
    if (!focusTarget) {
      focusTarget = el.querySelector('button, input, select, textarea, a[href]');
    }
    if (focusTarget) {
      if (focusTarget.tagName === 'H1' || focusTarget.tagName === 'H2') {
        focusTarget.setAttribute('tabindex', '-1');
      }
      setTimeout(() => focusTarget.focus({ preventScroll: true }), 0);
    }
  }

  // Подсветка активного пункта меню (sidebar)
  updateSidebarActive(name);

  if (name === 'leaderboard') loadLeaderboard();
  if (name === 'path') loadPathScreen();
  if (name === 'quiz' && !opts.skipQuizReset) resetQuizUI();
  if (name === 'placement') resetPlacementUI();
  if (name === 'profile') loadProfileScreen();
  if (name === 'admin') loadAdminScreen();
}

function updateSidebarActive(name) {
  document.querySelectorAll('.sidebar-item').forEach((i) => i.classList.remove('active'));
  const active = document.querySelector(`.sidebar-item[data-nav="${name}"]`);
  if (active) active.classList.add('active');
}

let toastTimer = null;
function showToast(msg, variant = 'error') {
  const el = document.getElementById('toast');
  if (!el) return;

  el.textContent = msg || '';
  el.classList.add('toast');
  el.classList.remove('hidden', 'toast-error', 'toast-success');

  if (variant === 'success') el.classList.add('toast-success');
  else el.classList.add('toast-error');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add('hidden');
    el.classList.remove('toast-error', 'toast-success');
  }, 3500);
}

function escapeText(s) {
  const div = document.createElement('div');
  div.textContent = String(s ?? '');
  return div.innerHTML;
}

function compactText(s, max = 120) {
  const text = String(s ?? '').trim().replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function setFieldError(inputId, errSpanId, message) {
  const input = document.getElementById(inputId);
  const span = document.getElementById(errSpanId);
  if (span) span.textContent = message || '';
  if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function userIsAdmin() {
  if (!currentUser) return false;
  const v = currentUser.is_admin;
  return v === true || v === 1 || v === '1' || v === 'true';
}

function setAuthUI() {
  const homeAuth = document.getElementById('home-buttons');
  const homeUser = document.getElementById('home-authenticated');
  const logoutBtn = document.getElementById('logout-btn');
  const userInfo = document.getElementById('user-info');
  const navLogin = document.getElementById('nav-login');
  const navRegister = document.getElementById('nav-register');

  if (currentUser) {
    homeAuth?.classList.add('hidden');
    homeUser?.classList.remove('hidden');
    document.getElementById('welcome-name').textContent = currentUser.username;
    logoutBtn?.classList.remove('hidden');
    if (userInfo) {
      const avatarUrl = gameState?.avatar_url || getLocalAvatar();
      const uname = String(currentUser.username || 'Пользователь');
      const avatarMarkup = avatarUrl
        ? `<img src="${escapeHtml(avatarUrl)}" alt="" class="sidebar-user-avatar" aria-hidden="true">`
        : `<span class="sidebar-user-avatar-fallback" aria-hidden="true">${escapeHtml(uname.slice(0, 1).toUpperCase())}</span>`;
      userInfo.innerHTML = `${avatarMarkup}<span class="sidebar-user-name">${escapeHtml(uname)}</span>`;
      userInfo.classList.remove('hidden');
    }
    navLogin?.classList.add('hidden');
    navRegister?.classList.add('hidden');
    const showAdmin = userIsAdmin();
    const navAdmin = document.getElementById('sidebar-nav-admin');
    const headerAdmin = document.getElementById('header-nav-admin');
    if (navAdmin) {
      if (showAdmin) navAdmin.classList.remove('hidden');
      else navAdmin.classList.add('hidden');
    }
    if (headerAdmin) {
      if (showAdmin) headerAdmin.classList.remove('hidden');
      else headerAdmin.classList.add('hidden');
    }
  } else {
    homeAuth?.classList.remove('hidden');
    homeUser?.classList.add('hidden');
    logoutBtn?.classList.add('hidden');
    userInfo?.classList.add('hidden');
    navLogin?.classList.remove('hidden');
    navRegister?.classList.remove('hidden');
    document.getElementById('sidebar-nav-admin')?.classList.add('hidden');
    document.getElementById('header-nav-admin')?.classList.add('hidden');
  }
}

function updateQuizMeta() {
  const el = document.getElementById('quiz-meta');
  if (!el) return;
  let refillPart = '';
  const nextRefill = gameState.hearts_next_refill_at ? new Date(gameState.hearts_next_refill_at).getTime() : null;
  const heartsMax = gameState.hearts_max ?? 5;
  if (!lessonHeartsUnlimited && (gameState.hearts_current ?? 0) < heartsMax && nextRefill) {
    const sec = Math.max(0, Math.ceil((nextRefill - Date.now()) / 1000));
    refillPart = ` · +❤️ через ${formatMmSs(sec)}`;
  }
  const heartsCur = Math.max(0, Math.min(heartsMax, Number(gameState.hearts_current ?? 0)));
  const heartsIcons = lessonHeartsUnlimited
    ? '<span class="hearts-infinity" aria-hidden="true">❤️ ∞</span>'
    : Array.from({ length: heartsMax }).map((_, i) => (
      `<span class="heart ${i < heartsCur ? 'full' : 'empty'}" aria-hidden="true"></span>`
    )).join('');

  const streak = Number(gameState.streak_current ?? 0);
  const qStreak = Number(gameState.question_streak_current ?? 0);
  const xp = Number(gameState.xp_total ?? 0);

  const heartsTitle = lessonHeartsUnlimited
    ? 'Лёгкий уровень: жизни не расходуются'
    : 'Жизни';

  el.innerHTML = `
    <span class="hearts${lessonHeartsUnlimited ? ' hearts-unlimited' : ''}" title="${heartsTitle}">${heartsIcons}</span>
    <span class="meta-chip" title="Дней подряд">🔥 ${streak}</span>
    <span class="meta-chip" title="Стрик правильных ответов">⚡ ${qStreak}</span>
    <span class="meta-chip" title="Опыт">XP ${xp}</span>
    ${refillPart ? `<span class="meta-refill">${refillPart.replace(' · ', '')}</span>` : ''}
  `;
}

function formatMmSs(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getAvatarStorageKey() {
  const id = currentUser?.id || 'guest';
  return `avatar:${id}`;
}

function getLocalAvatar() {
  try {
    return localStorage.getItem(getAvatarStorageKey()) || '';
  } catch {
    return '';
  }
}

function setLocalAvatar(dataUrl) {
  try {
    localStorage.setItem(getAvatarStorageKey(), dataUrl);
  } catch {
    // ignore storage failures
  }
}

async function fetchMe() {
  const res = await fetch(`${API}/me`, { credentials: 'include' });
  const data = await res.json();
  currentUser = data.user;
  setAuthUI();
  if (currentUser) {
    await refreshGameState();
    const hub = document.getElementById('quiz-quests-hub');
    if (hub && !hub.classList.contains('hidden')) refreshQuestsHub();
  } else {
    updateQuizMeta();
  }
}

async function refreshGameState() {
  if (!currentUser) return;
  const res = await fetch(`${API}/game-state`, { credentials: 'include' });
  if (!res.ok) return;
  gameState = await res.json();
  if (!gameState.avatar_url) {
    const localAvatar = getLocalAvatar();
    if (localAvatar) gameState.avatar_url = localAvatar;
  }
  updateQuizMeta();
}

function renderProfileAvatar() {
  const avatarEl = document.getElementById('profile-avatar');
  if (!avatarEl) return;
  const avatarUrl = gameState?.avatar_url;
  if (avatarUrl) {
    avatarEl.innerHTML = `<img src="${avatarUrl}" alt="Аватар профиля" class="profile-avatar-img">`;
  } else {
    avatarEl.textContent = '👤';
  }
}

async function loadLeaderboard() {
  const tbody = document.getElementById('leaderboard-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const [boardRes, myRes] = await Promise.all([
    fetch(`${API}/leaderboard`),
    currentUser ? fetch(`${API}/my-best`, { credentials: 'include' }) : null
  ]);

  const board = await boardRes.json();
  board.forEach((row, i) => {
    const tr = document.createElement('tr');
    const date = new Date(row.created_at).toLocaleDateString('ru-RU');
    const avatar = row.avatar_url
      ? `<img src="${escapeHtml(row.avatar_url)}" alt="Аватар ${escapeHtml(row.username)}" class="leaderboard-avatar">`
      : `<span class="leaderboard-avatar-fallback" aria-hidden="true">${escapeHtml((row.username || '?').slice(0, 1).toUpperCase())}</span>`;
    tr.innerHTML = `
      <td class="rank">${i + 1}</td>
      <td><div class="leaderboard-user-cell">${avatar}<span>${escapeHtml(row.username)}</span></div></td>
      <td>${row.score}</td>
      <td>${date}</td>
    `;
    tbody.appendChild(tr);
  });

  const myBestEl = document.getElementById('my-best');
  if (currentUser && myRes) {
    const myData = await myRes.json();
    myBestEl.textContent = `Ваши суммарные очки: ${myData.best} XP`;
  } else {
    myBestEl.textContent = 'Войдите, чтобы видеть свой лучший результат';
  }
}

function clampProgress(current, target) {
  const c = Number(current || 0);
  const t = Number(target || 1);
  if (!Number.isFinite(c) || !Number.isFinite(t) || t <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((c / t) * 100)));
}

function renderAchievements(items) {
  const wrap = document.getElementById('achievements-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  items.forEach((a) => {
    const row = document.createElement('div');
    row.className = `achievement-row ${a.done ? 'done' : ''}`;
    row.innerHTML = `
      <div class="achievement-icon" aria-hidden="true">${a.icon}</div>
      <div class="achievement-content">
        <div class="achievement-top">
          <strong>${escapeHtml(a.title)}</strong>
          <span>${a.value}/${a.target}</span>
        </div>
        <div class="achievement-progress">
          <span style="width:${clampProgress(a.value, a.target)}%"></span>
        </div>
        <small>${escapeHtml(a.desc)}</small>
      </div>
    `;
    wrap.appendChild(row);
  });
}

function openAchievementsModal() {
  const modal = document.getElementById('achievements-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeAchievementsModal() {
  const modal = document.getElementById('achievements-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  document.body.classList.remove('modal-open');
}

async function loadProfileScreen() {
  if (!currentUser) {
    showScreen('login');
    return;
  }
  await refreshGameState();
  const [myBestRes, boardRes] = await Promise.all([
    fetch(`${API}/my-best`, { credentials: 'include' }).catch(() => null),
    fetch(`${API}/leaderboard`).catch(() => null),
  ]);

  let myBest = 0;
  let rankTop = 999;
  if (myBestRes && myBestRes.ok) {
    const data = await myBestRes.json().catch(() => ({}));
    myBest = Number(data.best || 0);
  }
  if (boardRes && boardRes.ok) {
    const board = await boardRes.json().catch(() => []);
    const idx = (board || []).findIndex((row) => String(row.username) === String(currentUser.username));
    rankTop = idx >= 0 ? (idx + 1) : 999;
  }

  const xp = Number(gameState.xp_total || 0);
  const streak = Number(gameState.streak_current || 0);
  const qStreak = Number(gameState.question_streak_best || gameState.question_streak_current || 0);

  const nameEl = document.getElementById('profile-name');
  const joinedEl = document.getElementById('profile-joined');
  const xpEl = document.getElementById('profile-xp');
  const streakEl = document.getElementById('profile-streak');
  const qstreakEl = document.getElementById('profile-qstreak');
  const bestEl = document.getElementById('profile-best');
  const summaryEl = document.getElementById('profile-side-summary');
  const rankEl = document.getElementById('profile-rank');
  const rankFillEl = document.getElementById('profile-rank-progress-fill');
  const rankTextEl = document.getElementById('profile-rank-progress-text');

  if (nameEl) nameEl.textContent = currentUser.username || 'Пользователь';
  if (joinedEl) joinedEl.textContent = currentUser.email || 'Профиль военнослужащего';
  if (xpEl) xpEl.textContent = String(xp);
  if (streakEl) streakEl.textContent = String(streak);
  if (qstreakEl) qstreakEl.textContent = String(qStreak);
  if (bestEl) bestEl.textContent = `${myBest} XP`;
  if (summaryEl) summaryEl.textContent = `Ваш текущий ранг: ${rankTop <= 100 ? `ТОП-${rankTop}` : 'вне ТОП-100'}.`;
  renderProfileAvatar();

  const rankState = getRankByXp(xp);
  if (rankEl) rankEl.textContent = rankState.current.title;
  if (rankFillEl) rankFillEl.style.width = `${rankState.progressPct}%`;
  if (rankTextEl) rankTextEl.textContent = rankState.progressText;

  const achievements = [
    { icon: '🔥', title: 'Энтузиаст', desc: 'Удержите серию дней', value: streak, target: 3, done: streak >= 3 },
    { icon: '🗓️', title: 'Железная дисциплина', desc: 'Удержите серию 7 дней', value: streak, target: 7, done: streak >= 7 },
    { icon: '⚡', title: 'Опытный боец', desc: 'Наберите 100 XP', value: xp, target: 100, done: xp >= 100 },
    { icon: '🏅', title: 'Ветеран', desc: 'Наберите 500 XP', value: xp, target: 500, done: xp >= 500 },
    { icon: '👑', title: 'Легенда уставов', desc: 'Наберите 2000 XP', value: xp, target: 2000, done: xp >= 2000 },
    { icon: '🎯', title: 'Точность', desc: 'Сделайте стрик 10 ответов', value: qStreak, target: 10, done: qStreak >= 10 },
    { icon: '🎖️', title: 'Снайпер', desc: 'Сделайте стрик 20 ответов', value: qStreak, target: 20, done: qStreak >= 20 },
    { icon: '📈', title: 'Личный рекорд', desc: 'Наберите 300 XP в лучшем результате', value: myBest, target: 300, done: myBest >= 300 },
    { icon: '🏆', title: 'Штурм вершины', desc: 'Наберите 1000 XP в лучшем результате', value: myBest, target: 1000, done: myBest >= 1000 },
  ];
  renderAchievements(achievements);
}

async function handleAvatarFileChange(e) {
  const file = e.target?.files?.[0];
  if (!file) return;
  const maxMb = 4;
  if (file.size > maxMb * 1024 * 1024) {
    showToast(`Файл слишком большой. Максимум ${maxMb} МБ.`, 'error');
    return;
  }
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    showToast('Поддерживаются только PNG, JPG, WEBP.', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    const dataUrl = String(reader.result || '');
    if (!dataUrl.startsWith('data:image/')) {
      showToast('Ошибка чтения изображения.', 'error');
      return;
    }
    try {
      // Сжимаем и приводим к квадрату 256x256 перед отправкой.
      // Если сжатие по какой-то причине недоступно, используем исходный dataUrl.
      let compressedDataUrl = dataUrl;
      try {
        compressedDataUrl = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const size = 256;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Canvas error'));
            return;
          }
          const sw = img.naturalWidth || img.width;
          const sh = img.naturalHeight || img.height;
          const srcSize = Math.min(sw, sh);
          const sx = Math.floor((sw - srcSize) / 2);
          const sy = Math.floor((sh - srcSize) / 2);
          ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, size, size);
          resolve(canvas.toDataURL('image/webp', 0.82));
        };
        img.onerror = () => reject(new Error('Image decode error'));
        img.src = dataUrl;
        });
      } catch {
        compressedDataUrl = dataUrl;
      }

      const res = await fetch(`${API}/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ avatarDataUrl: compressedDataUrl }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Резерв: сохраняем локально в браузере, если сервер отверг запрос
        setLocalAvatar(compressedDataUrl);
        gameState.avatar_url = compressedDataUrl;
        renderProfileAvatar();
        const details = data.error ? ` (${data.error})` : '';
        showToast(`Сервер не сохранил аватар${details}. Аватар сохранён локально.`, 'success');
        return;
      }
      gameState.avatar_url = data.avatar_url || compressedDataUrl;
      setLocalAvatar(gameState.avatar_url);
      renderProfileAvatar();
      showToast('Аватар обновлён', 'success');
    } catch (err) {
      // Резерв при сетевой ошибке
      setLocalAvatar(compressedDataUrl);
      gameState.avatar_url = compressedDataUrl;
      renderProfileAvatar();
      showToast(`Сеть недоступна (${err?.message || 'ошибка'}). Аватар сохранён локально.`, 'success');
    } finally {
      const input = document.getElementById('profile-avatar-input');
      if (input) input.value = '';
    }
  };
  reader.readAsDataURL(file);
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clearFieldErrors(formId) {
  const formEl = document.getElementById(formId);
  formEl?.querySelectorAll('input').forEach((i) => i.setAttribute('aria-invalid', 'false'));
  document.querySelectorAll(`#${formId} .field-error, #${formId} .form-error`).forEach(el => el.textContent = '');
}

function validateEmailClient(email) {
  if (!email?.trim()) return 'Введите email';
  if (!EMAIL_REGEX.test(email.trim())) return 'Некорректный формат email (пример: user@mail.com)';
  return null;
}

function validatePasswordClient(pw, isRegister = false) {
  if (!pw) return 'Введите пароль';
  if (pw.length < 6) return 'Пароль должен быть не менее 6 символов';
  if (isRegister) {
    if (!/[A-Za-z]/.test(pw)) return 'Пароль должен содержать буквы';
    if (!/[0-9]/.test(pw)) return 'Пароль должен содержать цифры';
  }
  return null;
}

function validateUsernameClient(name) {
  if (!name?.trim()) return 'Введите имя пользователя';
  if (name.trim().length < 2) return 'Имя должно быть не менее 2 символов';
  if (name.trim().length > 30) return 'Имя должно быть не более 30 символов';
  return null;
}

function showFormError(formId, msg) {
  const el = document.querySelector(`#${formId} .form-error`);
  if (el) el.textContent = msg || '';
}

async function handleLogin(e) {
  e.preventDefault();
  clearFieldErrors('login-form');
  const form = e.target;
  const fd = new FormData(form);
  const email = fd.get('email')?.trim() || '';
  const password = fd.get('password') || '';

  const emailErr = validateEmailClient(email);
  if (emailErr) { setFieldError('login-email', 'login-email-err', emailErr); return; }
  const passErr = validatePasswordClient(password);
  if (passErr) { setFieldError('login-password', 'login-password-err', passErr); return; }

  try {
    const res = await fetch(`${API}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      credentials: 'include'
    });
    const data = await res.json();
    if (!res.ok) {
      showFormError('login-form', data.error || 'Ошибка входа');
      return;
    }
    currentUser = data.user;
    await refreshGameState();
    setAuthUI();
    showScreen('home');
    form.reset();
  } catch (err) {
    showFormError('login-form', 'Ошибка сети');
    showToast('Ошибка сети. Попробуйте позже.', 'error');
  }
}

async function handleRegister(e) {
  e.preventDefault();
  clearFieldErrors('register-form');
  const form = e.target;
  const fd = new FormData(form);
  const email = fd.get('email')?.trim() || '';
  const username = fd.get('username')?.trim() || '';
  const password = fd.get('password') || '';
  const password2 = fd.get('password2') || '';

  const emailErr = validateEmailClient(email);
  if (emailErr) { setFieldError('reg-email', 'reg-email-err', emailErr); return; }
  const userErr = validateUsernameClient(username);
  if (userErr) { setFieldError('reg-username', 'reg-username-err', userErr); return; }
  const passErr = validatePasswordClient(password, true);
  if (passErr) { setFieldError('reg-password', 'reg-password-err', passErr); return; }
  if (password !== password2) {
    setFieldError('reg-password2', 'reg-password2-err', 'Пароли не совпадают');
    return;
  }

  try {
    const res = await fetch(`${API}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username, password }),
      credentials: 'include'
    });
    const data = await res.json();
    if (!res.ok) {
      showFormError('register-form', data.error || 'Ошибка регистрации');
      return;
    }
    currentUser = data.user;
    await refreshGameState();
    setAuthUI();
    showScreen('home');
    form.reset();
  } catch (err) {
    showFormError('register-form', 'Ошибка сети');
    showToast('Ошибка сети. Попробуйте позже.', 'error');
  }
}

async function handleLogout() {
  await fetch(`${API}/logout`, { method: 'POST', credentials: 'include' });
  currentUser = null;
  setAuthUI();
  showScreen('home');
}

async function loadAdminScreen() {
  const wrap = document.getElementById('admin-materials-list');
  if (!wrap || !userIsAdmin()) return;
  wrap.innerHTML = '<p class="text-muted">Загрузка…</p>';
  try {
    const res = await fetch(`${API}/admin/lessons`, { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      wrap.innerHTML = `<p class="text-muted">${escapeHtml(data.error || 'Нет доступа')}</p>`;
      return;
    }
    const rows = data.materials || [];
    if (!rows.length) {
      wrap.innerHTML = '<p class="text-muted">Пока нет загруженных материалов.</p>';
      return;
    }
    wrap.innerHTML = '';
    rows.forEach((r) => {
      const div = document.createElement('div');
      div.className = 'admin-material-row';
      const dt = r.created_at ? new Date(r.created_at).toLocaleString('ru-RU') : '—';
      div.innerHTML = `
        <div>
          <div class="admin-material-title">${escapeHtml(r.title || '')}</div>
          <div class="admin-material-meta">${escapeHtml(String(r.lang || '').toUpperCase())} · ур. ${escapeHtml(String(r.level))} · ${dt}</div>
        </div>
        <span class="admin-material-meta">${escapeHtml(r.original_filename || '')}</span>
        <span class="admin-material-meta">${r.text_length || 0} зн.</span>
        <span class="admin-material-meta">+${r.question_count || 0} вопр.</span>
      `;
      wrap.appendChild(div);
    });
  } catch {
    wrap.innerHTML = '<p class="text-muted">Ошибка загрузки списка.</p>';
  }
}

function parseContentDispositionFilename(cd) {
  if (!cd) return 'test.html';
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^["']|["']$/g, ''));
    } catch {
      /* fall through */
    }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(cd);
  if (quoted) return quoted[1].trim();
  const plain = /filename\s*=\s*([^;]+)/i.exec(cd);
  return plain ? plain[1].trim().replace(/^["']|["']$/g, '') : 'test.html';
}

async function downloadAdminHtmlExport(url, options) {
  const res = await fetch(url, { ...options, credentials: 'include' });
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const msg = data.error || `Ошибка ${res.status}`;
    throw new Error(msg);
  }
  if (!ct.includes('text/html')) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Сервер вернул не HTML');
  }
  const blob = await res.blob();
  const name = parseContentDispositionFilename(res.headers.get('Content-Disposition'));
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

async function handleAdminExportFile() {
  const errEl = document.getElementById('admin-upload-err');
  if (errEl) errEl.textContent = '';
  const fileInput = document.getElementById('admin-file');
  const file = fileInput?.files?.[0];
  if (!file) {
    if (errEl) errEl.textContent = 'Выберите файл';
    return;
  }
  const fd = new FormData();
  fd.append('file', file);
  fd.append('title', document.getElementById('admin-title')?.value?.trim() || '');
  fd.append('lang', document.getElementById('admin-lang')?.value || 'uvs');
  fd.append('level', document.getElementById('admin-level')?.value || '1');
  fd.append('max_questions', document.getElementById('admin-max-q')?.value || '12');
  try {
    await downloadAdminHtmlExport(`${API}/admin/lessons/export-upload`, { method: 'POST', body: fd });
    showToast('Файл теста скачан — откройте его в браузере', 'success');
  } catch (e) {
    const msg = e.message || 'Ошибка сети';
    if (errEl) errEl.textContent = msg;
    showToast(msg, 'error');
  }
}

async function handleAdminExportText() {
  const errEl = document.getElementById('admin-text-err');
  if (errEl) errEl.textContent = '';
  const body = {
    title: document.getElementById('admin-text-title')?.value?.trim() || '',
    lang: document.getElementById('admin-text-lang')?.value || 'uvs',
    level: Number(document.getElementById('admin-text-level')?.value || 1),
    max_questions: Number(document.getElementById('admin-text-max')?.value || 12),
    text: document.getElementById('admin-text-body')?.value || '',
  };
  try {
    await downloadAdminHtmlExport(`${API}/admin/lessons/export-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    showToast('Файл теста скачан — откройте его в браузере', 'success');
  } catch (e) {
    const msg = e.message || 'Ошибка сети';
    if (errEl) errEl.textContent = msg;
    showToast(msg, 'error');
  }
}

async function handleAdminUpload(e) {
  e.preventDefault();
  const errEl = document.getElementById('admin-upload-err');
  if (errEl) errEl.textContent = '';
  const fileInput = document.getElementById('admin-file');
  const file = fileInput?.files?.[0];
  if (!file) {
    if (errEl) errEl.textContent = 'Выберите файл';
    return;
  }
  const fd = new FormData();
  fd.append('file', file);
  fd.append('title', document.getElementById('admin-title')?.value?.trim() || '');
  fd.append('lang', document.getElementById('admin-lang')?.value || 'uvs');
  fd.append('level', document.getElementById('admin-level')?.value || '1');
  fd.append('max_questions', document.getElementById('admin-max-q')?.value || '12');
  try {
    const res = await fetch(`${API}/admin/lessons/upload`, {
      method: 'POST',
      body: fd,
      credentials: 'include',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (errEl) errEl.textContent = data.error || 'Ошибка загрузки';
      showToast(data.error || 'Ошибка загрузки', 'error');
      return;
    }
    const hint = data.hint ? ` ${data.hint}` : '';
    showToast(`Добавлено вопросов: ${data.questions_added}.${hint}`, 'success');
    fileInput.value = '';
    loadAdminScreen();
  } catch {
    if (errEl) errEl.textContent = 'Ошибка сети';
    showToast('Ошибка сети', 'error');
  }
}

async function handleAdminText(e) {
  e.preventDefault();
  const errEl = document.getElementById('admin-text-err');
  if (errEl) errEl.textContent = '';
  const body = {
    title: document.getElementById('admin-text-title')?.value?.trim() || '',
    lang: document.getElementById('admin-text-lang')?.value || 'uvs',
    level: Number(document.getElementById('admin-text-level')?.value || 1),
    max_questions: Number(document.getElementById('admin-text-max')?.value || 12),
    text: document.getElementById('admin-text-body')?.value || '',
  };
  try {
    const res = await fetch(`${API}/admin/lessons/from-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (errEl) errEl.textContent = data.error || 'Ошибка';
      showToast(data.error || 'Ошибка', 'error');
      return;
    }
    const hint = data.hint ? ` ${data.hint}` : '';
    showToast(`Добавлено вопросов: ${data.questions_added}.${hint}`, 'success');
    loadAdminScreen();
  } catch {
    if (errEl) errEl.textContent = 'Ошибка сети';
    showToast('Ошибка сети', 'error');
  }
}

async function handleChangePassword(e) {
  e.preventDefault();
  const errEl = document.getElementById('change-password-err');
  if (errEl) errEl.textContent = '';

  const form = e.target;
  const fd = new FormData(form);
  const oldPassword = String(fd.get('oldPassword') || '');
  const newPassword = String(fd.get('newPassword') || '');
  const newPassword2 = String(fd.get('newPassword2') || '');

  const passErr = validatePasswordClient(newPassword, true);
  if (passErr) {
    if (errEl) errEl.textContent = passErr;
    return;
  }
  if (newPassword !== newPassword2) {
    if (errEl) errEl.textContent = 'Новые пароли не совпадают';
    return;
  }

  try {
    const res = await fetch(`${API}/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ oldPassword, newPassword, newPassword2 }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (errEl) errEl.textContent = data.error || 'Не удалось изменить пароль';
      return;
    }
    form.reset();
    closeChangePasswordModal();
    showToast('Пароль успешно изменён', 'success');
  } catch {
    if (errEl) errEl.textContent = 'Ошибка сети';
    showToast('Ошибка сети. Попробуйте позже.', 'error');
  }
}

function openChangePasswordModal() {
  const modal = document.getElementById('change-password-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');
  setTimeout(() => document.getElementById('old-password')?.focus(), 0);
}

function closeChangePasswordModal() {
  const modal = document.getElementById('change-password-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  document.body.classList.remove('modal-open');
  const form = document.getElementById('change-password-form');
  const errEl = document.getElementById('change-password-err');
  if (errEl) errEl.textContent = '';
  form?.reset();
}

function getSelectedLang() {
  return document.getElementById('quiz-lang')?.value || 'uvs';
}

let pathLang = 'uvs';

/** SVG для узлов пути (военная тематика, цвет через currentColor) */
const PATH_ORBIT_ICONS = {
  star: '<svg class="path-orbit-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12 2.2l2.6 6.5 7 .6-5.4 4.2 2 6.7L12 17.5 5.8 20.2l2-6.7L2.4 9.3l7-.6L12 2.2z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/><path d="M12 7.2v3.2M12 14.2v.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  check: '<svg class="path-orbit-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6.5 12.2l3.5 3.5 7.5-8.2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  advance: '<svg class="path-orbit-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 6l5 6-5 6M14 6l5 6-5 6" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  lock: '<svg class="path-orbit-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="6" y="10" width="12" height="10" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M8 10V8a4 4 0 0 1 8 0v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="14.5" r="1.3" fill="currentColor"/></svg>',
};

const PATH_MILESTONE_ICONS = {
  crate: '<svg class="path-milestone-svg" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M5 12l11-4 11 4v14l-11 4-11-4V12z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5 12l11 4 11-4M16 16v14" stroke="currentColor" stroke-width="1.2"/><path d="M10 9l6 2.2 6-2.2" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>',
  medal: '<svg class="path-milestone-svg" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 4h7l2.5 6H8V4zm9 0h7v6h-7.5L17 4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="16" cy="20" r="6.5" stroke="currentColor" stroke-width="1.3"/><path d="M16 17.2l1.3 2.7 2.9.4-2.1 2 0.5 2.9-2.6-1.4-2.6 1.4.5-2.9-2.1-2 2.9-.4 1.3-2.7z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>',
  banner: '<svg class="path-milestone-svg" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M10 5v20M10 6h12l-3 4 3 4H10" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 26h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  trophy: '<svg class="path-milestone-svg" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M9 8h14v3a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5V8z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M7 9H5a2 2 0 0 0 0 4h2M25 9h2a2 2 0 0 1 0 4h-2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M12 16v3h8v-3M11 26h10v2H11v-2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
};

const STATUTE_SECTIONS = {
  uvs: [
    { id: 'uvs-m1-r1', module: 1, section: 1, title: 'Военная присяга: порядок и значение', level: 1 },
    { id: 'uvs-m1-r2', module: 1, section: 2, title: 'Государственный флаг и торжественные церемонии', level: 1 },
    { id: 'uvs-m1-r3', module: 1, section: 3, title: 'Праздничные дни и символика части', level: 1 },
    { id: 'uvs-m1-r4', module: 1, section: 4, title: 'Воинское приветствие и обращение в строю', level: 1 },
    { id: 'uvs-m1-r5', module: 1, section: 5, title: 'Боевое Знамя: статус и содержание', level: 1 },
    { id: 'uvs-m1-r6', module: 1, section: 6, title: 'Хранение, охрана и учёт Боевого Знамени', level: 1 },
    { id: 'uvs-m1-r7', module: 1, section: 7, title: 'Учёт личного состава и поверки', level: 1 },
    { id: 'uvs-m1-r8', module: 1, section: 8, title: 'Размещение, казарма и оружейная комната', level: 1 },
    { id: 'uvs-m1-r9', module: 1, section: 9, title: 'Распорядок дня, сон и питание', level: 1 },
    { id: 'uvs-m1-r10', module: 1, section: 10, title: 'Санитария, быт и сохранность помещений', level: 1 },
    { id: 'uvs-m2-r1', module: 2, section: 1, title: 'Права и обязанности военнослужащих', level: 2 },
    { id: 'uvs-m2-r2', module: 2, section: 2, title: 'Взаимоотношения между военнослужащими', level: 2 },
    { id: 'uvs-m2-r3', module: 2, section: 3, title: 'Воинская часть: общие обязанности и распорядок', level: 2 },
    { id: 'uvs-m3-r1', module: 3, section: 1, title: 'Распределение времени и внутренний порядок', level: 3 },
    { id: 'uvs-m3-r2', module: 3, section: 2, title: 'Суточный наряд и обязанности лиц наряда', level: 3 },
    { id: 'uvs-m3-r3', module: 3, section: 3, title: 'Пожарная безопасность и охрана труда на службе', level: 3 },
    { id: 'uvs-m4-r1', module: 4, section: 1, title: 'Имущество части: учёт и материальная ответственность', level: 1 },
    { id: 'uvs-m4-r2', module: 4, section: 2, title: 'Служебные помещения: допуск и санитарное состояние', level: 2 },
    { id: 'uvs-m4-r3', module: 4, section: 3, title: 'Наряды вне расположения части', level: 3 },
    { id: 'uvs-m5-r1', module: 5, section: 1, title: 'Взаимодействие с гражданскими лицами', level: 2 },
    { id: 'uvs-m5-r2', module: 5, section: 2, title: 'Особые случаи нарушения распорядка', level: 3 },
    { id: 'uvs-m5-r3', module: 5, section: 3, title: 'Итоговая проверка: типовые ситуации УВС', level: 3 },
    { id: 'uvs-m6-r1', module: 6, section: 1, title: 'Служебные журналы и учёт в подразделении', level: 1 },
    { id: 'uvs-m6-r2', module: 6, section: 2, title: 'Комендантский час и порядок посещений', level: 2 },
    { id: 'uvs-m6-r3', module: 6, section: 3, title: 'Взаимодействие дежурных служб части', level: 2 },
    { id: 'uvs-m6-r4', module: 6, section: 4, title: 'Типовые нарушения распорядка и реакция наряда', level: 3 },
    { id: 'uvs-m6-r5', module: 6, section: 5, title: 'Смешанные ситуации: закрепление УВС', level: 3 },
  ],
  du: [
    { id: 'du-m1-r1', module: 1, section: 1, title: 'Основы воинской дисциплины', level: 1 },
    { id: 'du-m1-r2', module: 1, section: 2, title: 'Подчиненность и единоначалие', level: 1 },
    { id: 'du-m1-r3', module: 1, section: 3, title: 'Статус военнослужащего и субординация в быту', level: 1 },
    { id: 'du-m2-r1', module: 2, section: 1, title: 'Поощрения в подразделении', level: 2 },
    { id: 'du-m2-r2', module: 2, section: 2, title: 'Дисциплинарные взыскания', level: 2 },
    { id: 'du-m2-r3', module: 2, section: 3, title: 'Взыскания: виды и последствия для службы', level: 2 },
    { id: 'du-m3-r1', module: 3, section: 1, title: 'Права и порядок обжалования', level: 3 },
    { id: 'du-m3-r2', module: 3, section: 2, title: 'Разбор дисциплинарных кейсов', level: 3 },
    { id: 'du-m3-r3', module: 3, section: 3, title: 'Документооборот при проведении разбирательств', level: 3 },
    { id: 'du-m4-r1', module: 4, section: 1, title: 'Нарушения сроков и регламента в подразделении', level: 1 },
    { id: 'du-m4-r2', module: 4, section: 2, title: 'Дисциплинарный комитет: практика', level: 2 },
    { id: 'du-m4-r3', module: 4, section: 3, title: 'Ответственность командира за воспитание', level: 3 },
    { id: 'du-m5-r1', module: 5, section: 1, title: 'Конфликт приказов и исполнение', level: 2 },
    { id: 'du-m5-r2', module: 5, section: 2, title: 'Тяжёлые нарушения и особый порядок', level: 3 },
    { id: 'du-m5-r3', module: 5, section: 3, title: 'Итоговая проверка: кейсы ДУ', level: 3 },
    { id: 'du-m6-r1', module: 6, section: 1, title: 'Сроки наложения взысканий и погашение', level: 1 },
    { id: 'du-m6-r2', module: 6, section: 2, title: 'Поощрения: порядок объявления и учёт', level: 2 },
    { id: 'du-m6-r3', module: 6, section: 3, title: 'Взыскания и служебное положение военнослужащего', level: 2 },
    { id: 'du-m6-r4', module: 6, section: 4, title: 'Сложные случаи подчинённости и приказа', level: 3 },
    { id: 'du-m6-r5', module: 6, section: 5, title: 'Итог: смешанные кейсы ДУ', level: 3 },
  ],
  gks: [
    { id: 'gks-m1-r1', module: 1, section: 1, title: 'Организация караульной службы', level: 1 },
    { id: 'gks-m1-r2', module: 1, section: 2, title: 'Пост и обязанности часового', level: 1 },
    { id: 'gks-m1-r3', module: 1, section: 3, title: 'Порядок заступления и смены на посту', level: 1 },
    { id: 'gks-m2-r1', module: 2, section: 1, title: 'Развод и смена караула', level: 2 },
    { id: 'gks-m2-r2', module: 2, section: 2, title: 'Сигналы и меры безопасности', level: 2 },
    { id: 'gks-m2-r3', module: 2, section: 3, title: 'Патрули и передвижение по объекту', level: 2 },
    { id: 'gks-m3-r1', module: 3, section: 1, title: 'Действия при тревоге', level: 3 },
    { id: 'gks-m3-r2', module: 3, section: 2, title: 'Оборона объекта: практика', level: 3 },
    { id: 'gks-m3-r3', module: 3, section: 3, title: 'Взаимодействие караула и внутреннего наряда', level: 3 },
    { id: 'gks-m4-r1', module: 4, section: 1, title: 'Охрана периметра и контрольно-пропускной режим', level: 1 },
    { id: 'gks-m4-r2', module: 4, section: 2, title: 'Разоружение и задержание нарушителя', level: 2 },
    { id: 'gks-m4-r3', module: 4, section: 3, title: 'Служба в ночных условиях', level: 3 },
    { id: 'gks-m5-r1', module: 5, section: 1, title: 'Пожарная тревога на посту', level: 2 },
    { id: 'gks-m5-r2', module: 5, section: 2, title: 'Неординарные посетители и переговоры', level: 3 },
    { id: 'gks-m5-r3', module: 5, section: 3, title: 'Итоговая проверка: УГиКС', level: 3 },
    { id: 'gks-m6-r1', module: 6, section: 1, title: 'Пропускной режим и документы на КПП', level: 1 },
    { id: 'gks-m6-r2', module: 6, section: 2, title: 'Взаимодействие караула и внутреннего наряда', level: 2 },
    { id: 'gks-m6-r3', module: 6, section: 3, title: 'Действия при ЧС на объекте охраны', level: 2 },
    { id: 'gks-m6-r4', module: 6, section: 4, title: 'Смена на посту в сложных условиях', level: 3 },
    { id: 'gks-m6-r5', module: 6, section: 5, title: 'Итог: смешанные сценарии УГиКС', level: 3 },
  ],
  su: [
    { id: 'su-m1-r1', module: 1, section: 1, title: 'Строй и строевая стойка', level: 1 },
    { id: 'su-m1-r2', module: 1, section: 2, title: 'Команды и строевые приемы', level: 1 },
    { id: 'su-m1-r3', module: 1, section: 3, title: 'Равнение, интервалы и дистанции', level: 1 },
    { id: 'su-m2-r1', module: 2, section: 1, title: 'Движение строевым шагом', level: 2 },
    { id: 'su-m2-r2', module: 2, section: 2, title: 'Повороты и перестроения', level: 2 },
    { id: 'su-m2-r3', module: 2, section: 3, title: 'Снятие, ходьба и остановки по команде', level: 2 },
    { id: 'su-m3-r1', module: 3, section: 1, title: 'Торжественный марш', level: 3 },
    { id: 'su-m3-r2', module: 3, section: 2, title: 'Сложные строевые сценарии', level: 3 },
    { id: 'su-m3-r3', module: 3, section: 3, title: 'Рапорты в строю и обращение к начальнику', level: 3 },
    { id: 'su-m4-r1', module: 4, section: 1, title: 'Строевой смотр и внешний вид', level: 1 },
    { id: 'su-m4-r2', module: 4, section: 2, title: 'Команды управления и строевые песни', level: 2 },
    { id: 'su-m4-r3', module: 4, section: 3, title: 'Марш на плацу с разворотами', level: 3 },
    { id: 'su-m5-r1', module: 5, section: 1, title: 'Строевые сценарии на торжественных мероприятиях', level: 2 },
    { id: 'su-m5-r2', module: 5, section: 2, title: 'Флаг, знамёна и почётный караул в строю', level: 3 },
    { id: 'su-m5-r3', module: 5, section: 3, title: 'Итоговая проверка: СУ', level: 3 },
    { id: 'su-m6-r1', module: 6, section: 1, title: 'Построение и проверка внешнего вида', level: 1 },
    { id: 'su-m6-r2', module: 6, section: 2, title: 'Сложные перестроения и марш в колонне', level: 2 },
    { id: 'su-m6-r3', module: 6, section: 3, title: 'Торжественный выход и рапортование', level: 2 },
    { id: 'su-m6-r4', module: 6, section: 4, title: 'Ошибки в строю и их исправление', level: 3 },
    { id: 'su-m6-r5', module: 6, section: 5, title: 'Итог: смешанные задания СУ', level: 3 },
  ],
};

/** Подписи узла в духе Duolingo: урок внутри модуля + волна (УВС мод. 1) или сложность. */
function pathLessonMeta(section, lang) {
  const list = STATUTE_SECTIONS[lang] || [];
  const mod = Number(section.module) || 1;
  const secNum = Number(section.section) || 1;
  const inMod = list.filter((s) => Number(s.module) === mod);
  const total = Math.max(1, inMod.length);
  const main = `Урок ${secNum} из ${total}`;
  let sub = null;
  if (lang === 'uvs' && mod === 1 && total >= 8) {
    sub = `Волна ${Math.min(5, Math.ceil(secNum / 2))}`;
  } else {
    sub = `Ур. ${Number(section.level) || 1}`;
  }
  return { main, sub };
}

function formatQuizLessonContextLine(lang) {
  const list = STATUTE_SECTIONS[lang] || [];
  const sec = list[lessonSlotIndex];
  if (!sec) return '';
  const m = pathLessonMeta(sec, lang);
  const parts = [`Модуль ${Number(sec.module) || 1}`, m.main];
  if (m.sub) parts.push(m.sub);
  return parts.join(' · ');
}

function updateQuizLessonContext() {
  const el = document.getElementById('quiz-lesson-context');
  if (!el) return;
  const qBlock = document.getElementById('quiz-question');
  if (!qBlock || qBlock.classList.contains('hidden')) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  const langSelect = document.getElementById('quiz-lang');
  const lang = langSelect ? langSelect.value : pathLang || 'uvs';
  const line = formatQuizLessonContextLine(lang);
  if (!line) {
    el.classList.add('hidden');
    return;
  }
  el.textContent = line;
  el.classList.remove('hidden');
}

const HANDBOOK_BY_LANG = {
  uvs: {
    title: 'Справочник УВС',
    subtitle: 'Ключевые положения внутренней службы',
    points: [
      'Военнослужащий обязан соблюдать распорядок дня и уставные взаимоотношения.',
      'Дневальный по роте не оставляет пост без разрешения дежурного по роте.',
      'Дежурный по роте отвечает за порядок, наличие личного состава и сохранность оружия.',
      'Суточный наряд назначается для поддержания внутреннего порядка и охраны.',
    ],
  },
  du: {
    title: 'Справочник ДУ',
    subtitle: 'Ключевые нормы воинской дисциплины',
    points: [
      'За один дисциплинарный проступок применяется только одно взыскание.',
      'Поощрения и взыскания должны быть справедливы и соответствовать обстоятельствам.',
      'Начальник вправе отдавать приказы и требовать их исполнения.',
      'Подчинённый обязан соблюдать дисциплину и уважать честь и достоинство сослуживцев.',
    ],
  },
  gks: {
    title: 'Справочник УГиКС',
    subtitle: 'Караульная служба: кратко',
    points: [
      'Часовой обязан бдительно охранять и стойко оборонять пост.',
      'Часовой подчиняется начальнику караула и своему разводящему.',
      'Смена караула проводится в установленное время по уставному порядку.',
      'При угрозе посту часовой действует решительно и согласно уставу.',
    ],
  },
  su: {
    title: 'Справочник СУ',
    subtitle: 'Базовые правила строевой подготовки',
    points: [
      'Команды подаются чётко, громко и в установленной последовательности.',
      'В строю военнослужащий сохраняет интервал, дистанцию и равнение.',
      'Строевая стойка принимается по команде «Смирно».',
      'Повороты и перестроения выполняются одновременно по исполнительной команде.',
    ],
  },
};

async function loadPathScreen() {
  if (!currentUser) return;
  const lang = pathLang || getSelectedLang();
  const pathRes = await fetch(`${API}/path?lang=${encodeURIComponent(lang)}`, { credentials: 'include' });
  if (!pathRes.ok) return;
  const pathData = await pathRes.json();
  renderPath(pathData);
  bindPathSectionTabs();
}

function bindPathSectionTabs() {
  document.querySelectorAll('.section-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.section-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      pathLang = tab.dataset.lang || 'uvs';
      loadPathScreen();
    });
  });
}

function renderPath(pathData) {
  const container = document.getElementById('path-list');
  if (!container) return;
  container.innerHTML = '';
  const lang = pathData?.language || pathLang || 'uvs';
  const unit = (pathData.units || [])[0] || { title: 'Путь по уставу', skills: [] };
  const skillByLevel = new Map((unit.skills || []).map((s) => [Number(s.level), s]));
  const mbl = pathData.mastery_by_lesson && typeof pathData.mastery_by_lesson === 'object'
    ? pathData.mastery_by_lesson
    : {};
  const lessonKey = (idx) => `${lang}:${idx}`;
  const rawSections = (STATUTE_SECTIONS[lang] || []).map((s, idx) => ({
    ...s,
    idx,
    mastery: Number(mbl[lessonKey(idx)] || 0),
  }));
  const moduleComplete = {};
  for (const s of rawSections) {
    if (moduleComplete[s.module] === undefined) moduleComplete[s.module] = true;
  }
  for (const s of rawSections) {
    if (s.mastery < 100) moduleComplete[s.module] = false;
  }
  const maxModuleNum = rawSections.reduce((acc, s) => Math.max(acc, Number(s.module) || 1), 1);
  const moduleUnlocked = { 1: true };
  for (let m = 2; m <= maxModuleNum; m += 1) {
    moduleUnlocked[m] = Boolean(moduleComplete[m - 1]);
  }
  const sections = rawSections.map((s) => {
    const skill = skillByLevel.get(Number(s.level)) || {};
    const baseLocked = Boolean(skill.locked);
    const lockByModule = !moduleUnlocked[Number(s.module) || 1];
    return {
      ...s,
      lessons: Number(skill.lessons || 20),
      locked: baseLocked || lockByModule,
    };
  });
  const firstOpen = sections.find((s) => !s.locked) || sections[0] || { idx: 0, title: 'Раздел', module: 1, section: 1 };
  const doneCount = sections.filter((s) => s.mastery >= 100).length;
  const focusIndex = Math.max(0, sections.findIndex((s) => !s.locked && s.mastery < 100));
  const focusSafeIndex = focusIndex >= 0 ? focusIndex : Math.max(0, sections.length - 1);
  const currentLevel = Number(selectedProficiency || firstOpen.level || 1);
  const mascotTarget =
    sections.find((s) => !s.locked && s.level === currentLevel && s.mastery < 100) ||
    sections.find((s) => !s.locked && s.level === currentLevel) ||
    sections[focusSafeIndex] ||
    sections[0];
  const progressRatio = sections.length ? doneCount / sections.length : 0;
  const soldierRank = progressRatio < 0.34 ? 'recruit' : progressRatio < 0.67 ? 'fighter' : 'veteran';
  const handbook = HANDBOOK_BY_LANG[lang] || HANDBOOK_BY_LANG.uvs;
  const handbookPoints = (handbook.points || [])
    .map((p) => `<li class="path-handbook-item">${escapeHtml(p)}</li>`)
    .join('');

  const heroSection = mascotTarget || firstOpen;
  const heroIdx = sections.findIndex((s) => s.idx === heroSection.idx);
  const nextSection = heroIdx >= 0 ? sections[heroIdx + 1] : null;
  const footerNextText = nextSection
    ? `Далее: ${nextSection.title}`
    : doneCount >= sections.length && sections.length
      ? 'Разделы курса пройдены — закрепите материал или повторите модуль.'
      : 'Продолжайте узлы пути по порядку.';

  const shell = document.createElement('div');
  shell.className = 'path-map-shell';
  shell.innerHTML = `
    <div class="path-hero">
      <div class="path-hero-row">
        <div class="path-hero-head">
          <div class="path-hero-top">Модуль ${Number(heroSection.module) || 1}, раздел ${Number(heroSection.section) || 1}</div>
          <h3>${escapeHtml(heroSection.title || unit.title || 'Путь обучения')}</h3>
        </div>
        <button type="button" class="btn path-handbook-btn" id="path-handbook-btn">Справочник</button>
      </div>
      <p class="path-hero-hint">Изучайте разделы по порядку и переходите к следующему узлу после закрепления темы.</p>
      <div class="path-handbook hidden" id="path-handbook">
        <div class="path-handbook-title">${escapeHtml(handbook.title)}</div>
        <div class="path-handbook-subtitle">${escapeHtml(handbook.subtitle)}</div>
        <ul class="path-handbook-list">${handbookPoints}</ul>
      </div>
    </div>
    <div class="path-map">
      <div class="path-track" id="path-track"></div>
      <div class="path-mascot ${soldierRank}" id="path-mascot" aria-hidden="true">
        <img class="path-mascot-img" src="/path-mascot.png" width="110" height="110" alt="" decoding="async" />
      </div>
    </div>
    <footer class="path-next-footer">
      <div class="path-next-footer-rule"></div>
      <p class="path-next-footer-text">${escapeHtml(footerNextText)}</p>
    </footer>
  `;
  container.appendChild(shell);
  const handbookBtn = shell.querySelector('#path-handbook-btn');
  const handbookPanel = shell.querySelector('#path-handbook');
  handbookBtn?.addEventListener('click', () => {
    handbookPanel?.classList.toggle('hidden');
    handbookBtn.textContent = handbookPanel?.classList.contains('hidden') ? 'Справочник' : 'Скрыть';
  });

  const track = shell.querySelector('#path-track');
  let prevModule = null;
  sections.forEach((section, i) => {
    if (section.module !== prevModule) {
      const m = Number(section.module) || 1;
      const moduleRow = document.createElement('div');
      moduleRow.className = 'path-module-title-row';
      const moduleTitle = document.createElement('div');
      moduleTitle.className = 'path-module-title';
      moduleTitle.textContent = `Модуль ${m}`;
      moduleRow.appendChild(moduleTitle);
      if (moduleComplete[m]) {
        const repeatBtn = document.createElement('button');
        repeatBtn.type = 'button';
        repeatBtn.className = 'btn btn-outline path-module-repeat-btn';
        repeatBtn.textContent = 'Повторить модуль';
        repeatBtn.addEventListener('click', async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const res = await fetch(`${API}/path/module/clear-coverage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lang, module: m }),
            credentials: 'include',
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            showToast(data.error || 'Не удалось сбросить учёт пройденных вопросов', 'error');
            return;
          }
          showToast(
            `Модуль ${m}: уроки можно пройти снова — подберутся другие вопросы из темы.`,
            'success',
          );
          await loadPathScreen();
        });
        moduleRow.appendChild(repeatBtn);
      }
      track?.appendChild(moduleRow);
      if (section.module > 1 && !moduleUnlocked[section.module]) {
        const gate = document.createElement('div');
        gate.className = 'path-module-gate';
        gate.innerHTML = `
          <div class="path-module-gate-badge">ДАЛЕЕ</div>
          <h4>🔒 Модуль ${section.module}</h4>
          <p>Доступ откроется после завершения предыдущего модуля.</p>
          <button type="button" class="btn btn-outline" disabled>Сначала завершите модуль ${section.module - 1}</button>
        `;
        track?.appendChild(gate);
      }
      prevModule = section.module;
    }
    const side = i % 2 === 0 ? 'left' : 'right';
    const isCurrent = Boolean(!section.locked && mascotTarget && section.idx === mascotTarget.idx);
    const row = document.createElement('div');
    row.className = `path-duo-row path-duo-row--${side}`;
    row.dataset.pathRow = String(i);

    const stack = document.createElement('div');
    stack.className = 'path-duo-stack';

    const callout = document.createElement('div');
    callout.className = isCurrent ? 'path-callout' : 'path-callout path-callout--hidden';
    callout.textContent = section.mastery >= 100 && isCurrent ? 'Закрепить' : 'В БОЙ!';

    const orbit = document.createElement('button');
    orbit.type = 'button';
    orbit.className = 'path-orbit-btn';
    if (section.locked) orbit.classList.add('path-orbit-btn--locked');
    else if (section.mastery >= 100) orbit.classList.add('path-orbit-btn--done');
    else if (isCurrent) orbit.classList.add('path-orbit-btn--current');
    else orbit.classList.add('path-orbit-btn--open');
    orbit.dataset.sectionIdx = String(section.idx);
    const lessonMeta = pathLessonMeta(section, lang);
    orbit.setAttribute(
      'aria-label',
      `${section.title}. ${lessonMeta.main}${lessonMeta.sub ? `, ${lessonMeta.sub}` : ''}. Освоение ${section.mastery}%`,
    );
    orbit.disabled = section.locked;
    let orbitSvg;
    if (section.locked) orbitSvg = PATH_ORBIT_ICONS.lock;
    else if (section.mastery >= 100) orbitSvg = PATH_ORBIT_ICONS.check;
    else if (isCurrent) orbitSvg = PATH_ORBIT_ICONS.advance;
    else orbitSvg = PATH_ORBIT_ICONS.star;
    orbit.innerHTML = `<span class="path-orbit-face">${orbitSvg}</span>`;

    const meta = document.createElement('div');
    meta.className = 'path-lesson-meta';
    const lm = pathLessonMeta(section, lang);
    meta.innerHTML = `
      <span class="path-meta-row">
        <span class="path-meta-badge">${escapeHtml(lm.main)}</span>
        ${lm.sub ? `<span class="path-meta-wave">${escapeHtml(lm.sub)}</span>` : ''}
      </span>
      <strong class="path-meta-title">${escapeHtml(section.title)}</strong>
      <small class="path-meta-sub">Освоение ${Math.max(0, Math.min(100, section.mastery))}% · 20 вопросов</small>
    `;

    stack.appendChild(callout);
    stack.appendChild(orbit);
    stack.appendChild(meta);
    row.appendChild(stack);
    track?.appendChild(row);

    if (!section.locked) {
      orbit.addEventListener('click', () => {
        selectedProficiency = Number(section.level);
        lessonSlotIndex = Number(section.idx) || 0;
        startQuizWithPreset(lang, Number(section.level));
      });
    }

    const milestoneAfter = lang === 'uvs' && Number(section.module) === 1 && [3, 6, 9].includes(Number(section.section));
    if (milestoneAfter) {
      const kinds = { 3: 'crate', 6: 'medal', 9: 'banner' };
      const labels = { 3: 'Ящик снаряжения', 6: 'Награда за рубеж', 9: 'Боевое знамя — рубеж' };
      const sec = Number(section.section);
      const k = kinds[sec];
      const mile = document.createElement('div');
      mile.className = 'path-duo-row path-duo-row--center path-milestone-row';
      mile.innerHTML = `
        <div class="path-milestone path-milestone--${k}">
          <div class="path-milestone-icon" aria-hidden="true">${PATH_MILESTONE_ICONS[k]}</div>
          <span class="path-milestone-label">${labels[sec]}</span>
        </div>
      `;
      track?.appendChild(mile);
    }

    const nextSec = sections[i + 1];
    const isLastInModule = !nextSec || Number(nextSec.module) !== Number(section.module);
    if (isLastInModule) {
      const mod = Number(section.module) || 1;
      const done = Boolean(moduleComplete[mod]);
      const trophyRow = document.createElement('div');
      trophyRow.className = 'path-duo-row path-duo-row--center path-milestone-row path-milestone-trophy-row';
      trophyRow.innerHTML = `
        <div class="path-milestone path-milestone--trophy ${done ? 'path-milestone--trophy-done' : 'path-milestone--trophy-pending'}">
          <div class="path-milestone-icon" aria-hidden="true">${PATH_MILESTONE_ICONS.trophy}</div>
          <span class="path-milestone-label">${done ? `Модуль ${mod} пройден` : `Финиш модуля ${mod}`}</span>
        </div>
      `;
      track?.appendChild(trophyRow);
    }
  });

  const mascot = shell.querySelector('#path-mascot');
  const mapEl = shell.querySelector('.path-map');
  const trackEl = shell.querySelector('#path-track');
  const targetNode = shell.querySelector(`.path-orbit-btn[data-section-idx="${mascotTarget?.idx}"]`);
  if (mascot && mapEl && targetNode) {
    const padding = 10;
    const mapH = mapEl.clientHeight;
    const mH = mascot.offsetHeight || 110;
    const mapRect = mapEl.getBoundingClientRect();
    const nodeRect = targetNode.getBoundingClientRect();
    const nodeY = nodeRect.top - mapRect.top;
    const nodeH = nodeRect.height;
    const nodeCenterY = nodeY + nodeH / 2;

    const rowEl = targetNode.closest('.path-duo-row');
    let minTopRel = padding + 4;
    if (trackEl && rowEl) {
      const kids = [...trackEl.children];
      const rowIdx = kids.indexOf(rowEl);
      for (let i = 0; i < rowIdx; i += 1) {
        const ch = kids[i];
        if (!ch.classList) continue;
        if (ch.classList.contains('path-module-title-row') || ch.classList.contains('path-module-gate')) {
          const r = ch.getBoundingClientRect();
          minTopRel = Math.max(minTopRel, r.bottom - mapRect.top + 14);
        }
      }
    }

    let topPx = nodeCenterY - mH / 2;
    topPx = Math.max(minTopRel, Math.min(mapH - mH - padding, topPx));
    mascot.style.left = 'auto';
    mascot.style.right = `${padding}px`;
    mascot.style.top = `${Math.round(topPx)}px`;
  } else if (mascot && sections.length > 1) {
    const topPct = Math.round(14 + (focusSafeIndex / (sections.length - 1)) * 66);
    mascot.style.left = 'auto';
    mascot.style.right = '10px';
    mascot.style.top = `${topPct}%`;
  } else if (mascot) {
    mascot.style.left = 'auto';
    mascot.style.right = '10px';
    mascot.style.top = '44%';
  }
}

const MONTHLY_QUEST_TARGET = 5;
const RU_MONTH_SHORT = ['ЯНВ', 'ФЕВ', 'МАР', 'АПР', 'МАЙ', 'ИЮН', 'ИЮЛ', 'АВГ', 'СЕН', 'ОКТ', 'НОЯ', 'ДЕК'];

function monthlyQuestStorageKey() {
  const d = new Date();
  return `ustavy_monthly_claims_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getMonthlyQuestClaimCount() {
  try {
    const n = Number(localStorage.getItem(monthlyQuestStorageKey()) || '0');
    return Number.isFinite(n) ? Math.min(MONTHLY_QUEST_TARGET, Math.max(0, n)) : 0;
  } catch {
    return 0;
  }
}

function bumpMonthlyQuestClaims() {
  try {
    const k = monthlyQuestStorageKey();
    const next = Math.min(MONTHLY_QUEST_TARGET, getMonthlyQuestClaimCount() + 1);
    localStorage.setItem(k, String(next));
  } catch {
    /* ignore */
  }
  updateMonthlyQuestUI();
}

function daysLeftInMonth() {
  const d = new Date();
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return Math.max(0, last.getDate() - d.getDate());
}

function declDaysRu(n) {
  const k = n % 10;
  const k100 = n % 100;
  if (k100 >= 11 && k100 <= 14) return `${n} дней`;
  if (k === 1) return `${n} день`;
  if (k >= 2 && k <= 4) return `${n} дня`;
  return `${n} дней`;
}

function formatUntilMidnightLocal() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return 'скоро';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 1) return `${h} ч`;
  return `${Math.max(1, m)} мин`;
}

function updateMonthlyQuestUI() {
  const badge = document.getElementById('quest-monthly-badge');
  const daysEl = document.getElementById('quest-monthly-days-left');
  const fill = document.getElementById('quest-monthly-fill');
  const cnt = document.getElementById('quest-monthly-count');
  if (!badge || !fill || !cnt) return;
  const now = new Date();
  badge.textContent = RU_MONTH_SHORT[now.getMonth()] || '—';
  if (daysEl) {
    const left = daysLeftInMonth();
    daysEl.textContent = left === 0 ? 'последний день' : declDaysRu(left);
  }
  const p = getMonthlyQuestClaimCount();
  const pct = Math.round((p / MONTHLY_QUEST_TARGET) * 100);
  fill.style.width = `${pct}%`;
  cnt.textContent = `${p} / ${MONTHLY_QUEST_TARGET}`;
}

let questHubCountdownTimer = null;

function clearQuestHubTimer() {
  if (questHubCountdownTimer) {
    clearInterval(questHubCountdownTimer);
    questHubCountdownTimer = null;
  }
}

function updateQuestDailyCountdownEl() {
  const el = document.getElementById('quest-daily-reset');
  if (el) el.textContent = formatUntilMidnightLocal();
}

function setQuestsHubVisible(visible) {
  const hub = document.getElementById('quiz-quests-hub');
  if (!hub) return;
  hub.classList.toggle('hidden', !visible);
  if (visible) {
    updateMonthlyQuestUI();
    updateQuestDailyCountdownEl();
    clearQuestHubTimer();
    questHubCountdownTimer = setInterval(() => {
      const h = document.getElementById('quiz-quests-hub');
      if (h && !h.classList.contains('hidden')) updateQuestDailyCountdownEl();
    }, 60000);
    refreshQuestsHub();
  } else {
    clearQuestHubTimer();
  }
}

async function refreshQuestsHub() {
  const hub = document.getElementById('quiz-quests-hub');
  if (!hub || hub.classList.contains('hidden')) return;
  updateQuestDailyCountdownEl();
  const wrap = document.getElementById('quests-list');
  if (!currentUser) {
    if (wrap) wrap.innerHTML = '<p class="quest-daily-hint" style="margin:0">Войдите в аккаунт, чтобы видеть задания дня.</p>';
    return;
  }
  const lang = document.getElementById('quiz-lang')?.value || pathLang || getSelectedLang() || 'uvs';
  try {
    const res = await fetch(`${API}/quests/daily?lang=${encodeURIComponent(lang)}`, { credentials: 'include' });
    if (!res.ok) {
      if (wrap) wrap.innerHTML = '<p class="quest-daily-hint" style="margin:0">Не удалось загрузить задания.</p>';
      return;
    }
    const quests = await res.json();
    renderQuests(Array.isArray(quests) ? quests : []);
  } catch {
    if (wrap) wrap.innerHTML = '<p class="quest-daily-hint" style="margin:0">Ошибка сети при загрузке заданий.</p>';
  }
}

function questDailyIconClass(type) {
  switch (type) {
    case 'xp_earned': return 'quest-daily-icon--xp';
    case 'question_streak': return 'quest-daily-icon--streak';
    case 'lessons_completed':
    case 'perfect_lessons': return 'quest-daily-icon--book';
    default: return 'quest-daily-icon--time';
  }
}

function questDailyGlyph(type) {
  switch (type) {
    case 'xp_earned': return '✦';
    case 'correct_answers': return '✓';
    case 'question_streak': return '🔥';
    case 'perfect_lessons': return '★';
    case 'lessons_completed': return '📘';
    case 'answers_given': return '⚡';
    default: return '🎯';
  }
}

function renderQuests(quests) {
  const wrap = document.getElementById('quests-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  const langPick = document.getElementById('quiz-lang')?.value || pathLang || getSelectedLang() || 'uvs';
  (quests || []).forEach((q) => {
    const row = document.createElement('div');
    row.className = 'quest-daily-row';
    const tgt = Math.max(1, Number(q.target) || 1);
    const prog = Math.min(tgt, Number(q.progress) || 0);
    const done = prog >= tgt;
    const pct = Math.min(100, Math.round((prog / tgt) * 100));
    const title = q.title || q.id;
    const iconC = questDailyIconClass(q.type);
    const glyph = questDailyGlyph(q.type);
    const claimed = Boolean(q.claimed);
    row.innerHTML = `
      <span class="quest-daily-icon ${iconC}" aria-hidden="true">${glyph}</span>
      <div class="quest-daily-body">
        <div class="quest-daily-label">${escapeHtml(title)}</div>
        <div class="quest-daily-track"><div class="quest-daily-fill" style="width:${pct}%"></div></div>
        <div class="quest-daily-meta">${prog} / ${tgt}</div>
      </div>
      <button type="button" class="quest-chest-btn${done && !claimed ? ' quest-chest-btn--ready' : ''}" aria-label="${claimed ? 'Награда получена' : done ? 'Забрать награду +20 XP' : 'Награда пока недоступна'}" ${(!done || claimed) ? 'disabled' : ''}>🎁</button>
    `;
    const btn = row.querySelector('.quest-chest-btn');
    if (btn && done && !claimed) {
      btn.addEventListener('click', async () => {
        const res = await fetch(`${API}/quests/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quest_id: q.id, lang: langPick }),
          credentials: 'include',
        });
        if (!res.ok) return;
        const data = await res.json();
        gameState = data.game_state || gameState;
        updateQuizMeta();
        bumpMonthlyQuestClaims();
        renderQuests(data.quests || []);
      });
    }
    wrap.appendChild(row);
  });
}

async function startQuizWithPreset(lang, level) {
  showScreen('quiz', { skipQuizReset: true });
  quizLaunchedFromPath = true;
  syncQuizLangCards(lang);
  setQuestsHubVisible(false);
  await loadQuestions(lang, level);
  if (!questions.length) {
    setQuestsHubVisible(true);
    return;
  }
  currentIndex = 0;
  score = 0;
  document.getElementById('quiz-start').classList.add('hidden');
  document.getElementById('quiz-question').classList.remove('hidden');
  document.getElementById('quiz-result').classList.add('hidden');
  renderQuestion();
}

let placementAttempt = null;
let placementQuestions = [];
let placementAnswers = [];
let placementIndex = 0;

function resetPlacementUI() {
  placementAttempt = null;
  placementQuestions = [];
  placementAnswers = [];
  placementIndex = 0;
  const start = document.getElementById('placement-start');
  const q = document.getElementById('placement-question');
  const result = document.getElementById('placement-result');
  if (start) start.classList.remove('hidden');
  if (q) q.classList.add('hidden');
  if (result) result.classList.add('hidden');
}

async function startPlacement() {
  const lang = pathLang || getSelectedLang();
  const res = await fetch(`${API}/placement/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang }),
    credentials: 'include'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error || 'Не удалось начать тестирование', 'error');
    return;
  }
  placementAttempt = data.attempt_id;
  placementQuestions = data.questions || [];
  placementAnswers = [];
  placementIndex = 0;
  document.getElementById('placement-start')?.classList.add('hidden');
  document.getElementById('placement-question')?.classList.remove('hidden');
  renderPlacementQuestion();
}

function renderPlacementQuestion() {
  const q = placementQuestions[placementIndex];
  if (!q) return;
  document.getElementById('placement-progress').textContent = `${placementIndex + 1} / ${placementQuestions.length}`;
  document.getElementById('placement-prompt').textContent = q.prompt;
  const opts = document.getElementById('placement-options');
  opts.innerHTML = '';
  (q.options || []).forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quiz-option';
    btn.textContent = opt;
    btn.addEventListener('click', () => {
      placementAnswers.push({ idx: q.idx, answer: opt });
      placementIndex += 1;
      if (placementIndex >= placementQuestions.length) {
        completePlacement();
      } else {
        renderPlacementQuestion();
      }
    });
    opts.appendChild(btn);
  });
}

async function completePlacement() {
  const res = await fetch(`${API}/placement/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attempt_id: placementAttempt, answers: placementAnswers }),
    credentials: 'include'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error || 'Не удалось завершить тестирование', 'error');
    return;
  }
  selectedProficiency = Number(data.recommended_level || 1);
  document.getElementById('placement-question')?.classList.add('hidden');
  document.getElementById('placement-result')?.classList.remove('hidden');
  document.getElementById('placement-level-result').textContent = String(selectedProficiency);
  document.getElementById('placement-result-message').textContent =
    `Мы рекомендуем начать с уровня ${selectedProficiency}. Это можно изменить в любой момент.`;
}

async function loadQuestions(lang, level, slotIdx) {
  const l = lang || document.getElementById('quiz-lang')?.value || 'uvs';
  const lev = level ?? selectedProficiency ?? 1;
  const slot = slotIdx != null ? Number(slotIdx) : lessonSlotIndex;
  // Сразу включаем UI-режим бесконечных жизней для лёгкого уровня.
  lessonHeartsUnlimited = Number(lev) === 1;
  updateQuizMeta();
  const res = await fetch(`${API}/lesson/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lang: l,
      level: lev,
      question_count: 20,
      lesson_slot: Number.isFinite(slot) ? slot : 0,
    }),
    credentials: 'include'
  });
  if (!res.ok) {
    if (res.status === 401) {
      showScreen('login');
      return;
    }
    const data = await res.json().catch(() => ({}));
    showToast(data.error || 'Не удалось запустить урок', 'error');
    return;
  }
  const data = await res.json();
  lessonAttemptId = data.attempt_id;
  questions = data.exercises || [];
  pointsPerQuestion = data.points_per_exercise || 10;
  lessonHeartsUnlimited = Boolean(data.hearts_unlimited) || Number(lev) === 1;
  gameState.hearts_current = data.hearts_current ?? gameState.hearts_current;
  gameState.hearts_next_refill_at = data.hearts_next_refill_at ?? gameState.hearts_next_refill_at;
  if (data.hearts_max != null) gameState.hearts_max = data.hearts_max;
  if (data.question_streak_current != null) gameState.question_streak_current = data.question_streak_current;
  updateQuizMeta();
}

function setQuizCourseDropdownOpen(open) {
  const dd = document.getElementById('quiz-course-dropdown');
  const tr = document.getElementById('quiz-course-trigger');
  if (!dd || !tr) return;
  dd.classList.toggle('hidden', !open);
  tr.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function closeQuizCourseDropdown() {
  setQuizCourseDropdownOpen(false);
}

function syncQuizLangCards(langValue) {
  const v = String(langValue || 'uvs').trim() || 'uvs';
  const input = document.getElementById('quiz-lang');
  if (input) input.value = v;
  document.querySelectorAll('.quiz-course-option').forEach((btn) => {
    const on = btn.dataset.lang === v;
    btn.classList.toggle('selected', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const sel = document.querySelector(`.quiz-course-option[data-lang="${v}"]`);
  const badgeEl = document.getElementById('quiz-course-trigger-badge');
  const labelEl = document.getElementById('quiz-course-trigger-label');
  const descEl = document.getElementById('quiz-course-trigger-desc');
  if (sel && badgeEl && labelEl && descEl) {
    badgeEl.textContent = sel.dataset.badge || '';
    labelEl.textContent = sel.dataset.title || '';
    descEl.textContent = sel.dataset.desc || '';
  }
}

function resetQuizUI() {
  quizLaunchedFromPath = false;
  document.getElementById('quiz-start').classList.remove('hidden');
  document.getElementById('quiz-question').classList.add('hidden');
  document.getElementById('quiz-result').classList.add('hidden');
  document.getElementById('quiz-step-lang').classList.remove('hidden');
  document.getElementById('quiz-step-level').classList.add('hidden');
  syncQuizLangCards('uvs');
  const lessonCtx = document.getElementById('quiz-lesson-context');
  if (lessonCtx) {
    lessonCtx.textContent = '';
    lessonCtx.classList.add('hidden');
  }
  selectedProficiency = null;
  lessonAttemptId = null;
  lessonHeartsUnlimited = false;
  answerInFlight = false;
  setQuestsHubVisible(true);
  closeQuizCourseDropdown();
}

/** После результата свободного квиза: снова выбор уровня, язык не сбрасываем. */
function resetQuizToLevelStep() {
  document.getElementById('quiz-start').classList.remove('hidden');
  document.getElementById('quiz-question').classList.add('hidden');
  document.getElementById('quiz-result').classList.add('hidden');
  document.getElementById('quiz-step-lang').classList.add('hidden');
  document.getElementById('quiz-step-level').classList.remove('hidden');
  syncQuizLangCards(document.getElementById('quiz-lang')?.value || 'uvs');
  const lessonCtx = document.getElementById('quiz-lesson-context');
  if (lessonCtx) {
    lessonCtx.textContent = '';
    lessonCtx.classList.add('hidden');
  }
  selectedProficiency = null;
  lessonAttemptId = null;
  lessonHeartsUnlimited = false;
  answerInFlight = false;
  renderProficiencyOptions();
  setQuestsHubVisible(true);
  closeQuizCourseDropdown();
}

let selectedProficiency = null;

function renderProficiencyOptions() {
  const container = document.getElementById('proficiency-options');
  if (!container) return;
  container.innerHTML = '';
  PROFICIENCY_OPTIONS.forEach((opt, i) => {
    const div = document.createElement('button');
    div.type = 'button';
    div.className = 'level-card' + (i === 0 ? ' selected' : '');
    div.dataset.level = opt.level;
    div.innerHTML = `
      <span class="level-card-badge">${escapeHtml(opt.tier)}</span>
      <span class="level-card-desc">${escapeHtml(opt.desc)}</span>
      <span class="level-card-text">${escapeHtml(opt.text)}</span>
    `;
    div.addEventListener('click', () => {
      container.querySelectorAll('.level-card').forEach(el => el.classList.remove('selected'));
      div.classList.add('selected');
      selectedProficiency = opt.level;
    });
    container.appendChild(div);
  });
  selectedProficiency = 1;
}

async function startQuiz() {
  quizLaunchedFromPath = false;
  setQuestsHubVisible(false);
  const langSelect = document.getElementById('quiz-lang');
  const lang = langSelect ? langSelect.value : 'uvs';
  const level = selectedProficiency !== null ? selectedProficiency : 1;

  await loadQuestions(lang, level);
  if (questions.length === 0) {
    showToast(`Нет вопросов для раздела "${lang}" и уровня ${level}. Попробуйте другой уровень или раздел.`, 'error');
    setQuestsHubVisible(true);
    return;
  }

  currentIndex = 0;
  score = 0;
  document.getElementById('quiz-start').classList.add('hidden');
  document.getElementById('quiz-question').classList.remove('hidden');
  document.getElementById('quiz-result').classList.add('hidden');
  renderQuestion();
}

function renderQuestion() {
  const feedbackEl = document.getElementById('quiz-answer-feedback');
  if (feedbackEl) feedbackEl.classList.add('hidden');
  const quizContainerEl = document.getElementById('quiz-container');
  if (quizContainerEl) quizContainerEl.classList.remove('layout-match');

  const q = questions[currentIndex];
  if (!q) {
    finishQuiz();
    return;
  }

  const pts = q.points || pointsPerQuestion;
  document.getElementById('quiz-progress').textContent = `${currentIndex + 1} / ${questions.length}`;
  document.getElementById('quiz-score').textContent = `${score} очков`;
  updateQuizLessonContext();
  const wordEl = document.getElementById('quiz-word');
  const sentenceEl = document.getElementById('quiz-sentence');
  const hintEl = document.getElementById('quiz-hint');
  const opts = document.getElementById('quiz-options');
  opts.classList.remove('choice-grid');
  opts.innerHTML = '';

  const qType = String(q.type || '').trim().toLowerCase();

  if (qType === 'sentence') {
    wordEl.classList.add('hidden');
    sentenceEl.classList.remove('hidden');
    sentenceEl.textContent = q.sentence;
    hintEl.textContent = 'Вставьте правильное слово:';
    renderChoiceOptions(q, pts, opts);
  } else if (qType === 'word') {
    wordEl.classList.remove('hidden');
    sentenceEl.classList.add('hidden');
    wordEl.textContent = q.word;
    hintEl.textContent = 'Выберите правильное определение:';
    renderChoiceOptions(q, pts, opts);
  } else if (qType === 'word_bank') {
    wordEl.classList.add('hidden');
    sentenceEl.classList.remove('hidden');
    sentenceEl.textContent = q.prompt;
    hintEl.textContent = 'Выберите слово из банка:';
    renderChoiceOptions(q, pts, opts);
  } else if (qType === 'match_pairs') {
    if (quizContainerEl) quizContainerEl.classList.add('layout-match');
    wordEl.classList.add('hidden');
    sentenceEl.classList.remove('hidden');
    sentenceEl.textContent = q.prompt || 'Соедините пары';
    hintEl.textContent = 'Выберите соответствия и отправьте';
    renderMatchPairs(q, pts, opts);
  } else if (qType === 'reorder_sentence') {
    wordEl.classList.add('hidden');
    sentenceEl.classList.remove('hidden');
    sentenceEl.textContent = q.prompt || 'Соберите предложение';
    hintEl.textContent = 'Нажимайте слова по порядку';
    renderReorder(q, pts, opts);
  } else if (qType === 'typed_answer') {
    wordEl.classList.add('hidden');
    sentenceEl.classList.remove('hidden');
    sentenceEl.textContent = q.prompt || 'Введите ответ';
    hintEl.textContent = 'Введите термин по определению:';
    renderTypedAnswer(q, pts, opts);
  } else if (qType === 'reverse_word' || qType === 'reverse-word') {
    wordEl.classList.add('hidden');
    sentenceEl.classList.remove('hidden');
    sentenceEl.textContent = q.definition || '';
    hintEl.textContent = q.prompt || 'Выберите термин по определению:';
    renderChoiceOptions(q, pts, opts);
  } else if (qType === 'article_ref_choice' || qType === 'article-ref-choice') {
    wordEl.classList.add('hidden');
    sentenceEl.classList.remove('hidden');
    sentenceEl.textContent = q.statement || '';
    hintEl.textContent = q.prompt || 'Выберите ссылку на устав:';
    renderChoiceOptions(q, pts, opts);
  } else if (qType === 'true_false' || qType === 'true-false' || qType.endsWith('_tf')) {
    wordEl.classList.add('hidden');
    sentenceEl.classList.remove('hidden');
    sentenceEl.textContent = q.statement || '';
    hintEl.textContent = q.prompt || 'Верно ли утверждение?';
    renderTrueFalse(q, pts, opts);
  } else {
    wordEl.classList.remove('hidden');
    sentenceEl.classList.add('hidden');
    wordEl.textContent = q.prompt || q.definition || q.statement || 'Задание';
    hintEl.textContent = q.options ? 'Выберите ответ:' : 'Введите ответ:';
    renderChoiceOptions(q, pts, opts);
  }
}

function renderTrueFalse(q, pts, opts) {
  opts.classList.add('choice-grid', 'true-false-grid');
  const labels = [
    { val: true, text: 'Верно' },
    { val: false, text: 'Неверно' },
  ];
  labels.forEach(({ val, text }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quiz-option true-false-btn';
    btn.textContent = text;
    btn.dataset.points = pts;
    btn.addEventListener('click', () => selectAnswer(val, q, pts, btn, opts));
    opts.appendChild(btn);
  });
}

function renderTypedAnswer(q, pts, opts) {
  const wrap = document.createElement('div');
  wrap.className = 'typed-wrap';

  const def = document.createElement('div');
  def.className = 'typed-definition';
  def.textContent = q.definition || '';
  wrap.appendChild(def);

  if (q.hint) {
    const hint = document.createElement('div');
    hint.className = 'typed-hint';
    hint.id = 'typed-hint';
    hint.textContent = `Подсказка: ${q.hint}`;
    wrap.appendChild(hint);
  }

  const input = document.createElement('input');
  input.className = 'typed-input';
  input.type = 'text';
  input.placeholder = 'Ваш ответ...';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Введите ответ');
  if (q.hint) input.setAttribute('aria-describedby', 'typed-hint');
  wrap.appendChild(input);

  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn btn-primary';
  submit.textContent = 'Проверить';
  submit.addEventListener('click', () => {
    selectAnswer(input.value, q, pts, submit, opts);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit.click();
  });

  opts.appendChild(wrap);
  opts.appendChild(submit);
  setTimeout(() => input.focus(), 0);
}

function renderChoiceOptions(q, pts, opts) {
  opts.classList.add('choice-grid');
  const options = Array.isArray(q?.options) ? q.options : [];
  if (!options.length) {
    const empty = document.createElement('div');
    empty.className = 'quiz-hint';
    empty.textContent = 'Для этого задания нет вариантов ответа.';
    opts.appendChild(empty);
    return;
  }
  options.forEach(opt => {
    const full = String(opt ?? '');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quiz-option quiz-option-compact';
    btn.textContent = compactText(full, 115);
    btn.title = full;
    btn.dataset.answerValue = full;
    btn.dataset.points = pts;
    btn.addEventListener('click', () => selectAnswer(full, q, pts, btn, opts));
    opts.appendChild(btn);
  });
}

function renderMatchPairs(q, pts, opts) {
  const left = q.left || [];
  const right = q.right || [];

  const wrapper = document.createElement('div');
  wrapper.className = 'match-wrapper';
  const state = {}; // { [leftTerm]: rightDefinition }
  const rightToLeft = new Map(); // { rightDefinition: leftTerm }
  let activeLeft = null;

  const leftTitle = document.createElement('p');
  leftTitle.className = 'match-title';
  leftTitle.textContent = '1) Выберите термин';
  wrapper.appendChild(leftTitle);

  const leftGrid = document.createElement('div');
  leftGrid.className = 'match-left-grid';
  wrapper.appendChild(leftGrid);

  const leftButtons = new Map(); // leftTerm -> button
  left.forEach((l) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quiz-option match-left-card';
    btn.setAttribute('aria-label', `Термин: ${l}`);
    btn.dataset.left = l;

    const assigned = document.createElement('div');
    assigned.className = 'match-assigned';
    assigned.textContent = '—';

    btn.innerHTML = `<span class="match-card-main">${escapeHtml(l)}</span>`;
    btn.appendChild(assigned);

    btn.addEventListener('click', () => {
      activeLeft = l;
      leftButtons.forEach((b, k) => b.classList.toggle('active', k === activeLeft));
    });

    leftGrid.appendChild(btn);
    leftButtons.set(l, btn);
  });

  const rightTitle = document.createElement('p');
  rightTitle.className = 'match-title';
  rightTitle.textContent = '2) Выберите определение';
  wrapper.appendChild(rightTitle);

  const rightGrid = document.createElement('div');
  rightGrid.className = 'match-right-grid';
  wrapper.appendChild(rightGrid);

  const rightButtons = new Map(); // rightDef -> button
  right.forEach((r) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quiz-option match-right-card';
    btn.setAttribute('aria-label', `Определение: ${r}`);
    btn.dataset.right = r;

    const assigned = document.createElement('div');
    assigned.className = 'match-card-main';
    assigned.textContent = r;

    btn.appendChild(assigned);

    btn.addEventListener('click', () => {
      if (!activeLeft) {
        showToast('Сначала выберите термин слева.', 'error');
        return;
      }

      // Если определение уже назначено на другой термин — переключим.
      const prevLeftForDef = rightToLeft.get(r);
      const prevDefForActive = state[activeLeft];

      if (prevDefForActive === r) {
        // Снять назначение, если кликнули повторно
        delete state[activeLeft];
        rightToLeft.delete(r);
      } else {
        if (prevLeftForDef && prevLeftForDef !== activeLeft) {
          delete state[prevLeftForDef];
        }
        if (prevDefForActive) {
          rightToLeft.delete(prevDefForActive);
        }
        state[activeLeft] = r;
        rightToLeft.set(r, activeLeft);
      }

      // Обновить подписи на карточках терминов
      leftButtons.forEach((btnEl, leftTerm) => {
        const matchAssigned = btnEl.querySelector('.match-assigned');
        if (!matchAssigned) return;
        const assignedDef = state[leftTerm];
        matchAssigned.textContent = assignedDef ? assignedDef : '—';
        btnEl.classList.toggle('has-assigned', Boolean(assignedDef));
      });

      // Подсветить занятые определения
      rightButtons.forEach((btnEl, rightDef) => {
        btnEl.classList.toggle('has-assigned', rightToLeft.has(rightDef));
      });
    });

    rightGrid.appendChild(btn);
    rightButtons.set(r, btn);
  });

  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn btn-primary';
  submit.textContent = 'Проверить пары';
  submit.addEventListener('click', () => selectAnswer(state, q, pts, submit, opts));
  wrapper.appendChild(submit);

  opts.appendChild(wrapper);
}

function renderReorder(q, pts, opts) {
  const source = [...(q.tokens || [])];
  const answerTokens = [];
  const answer = document.createElement('div');
  answer.className = 'reorder-answer';
  const bank = document.createElement('div');
  bank.className = 'reorder-bank';
  const updateAnswer = () => {
    answer.textContent = answerTokens.join(' ');
  };
  const redrawBank = () => {
    bank.innerHTML = '';
    source.forEach((token, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'quiz-option';
      b.textContent = token;
      b.addEventListener('click', () => {
        answerTokens.push(token);
        source.splice(idx, 1);
        updateAnswer();
        redrawBank();
      });
      bank.appendChild(b);
    });
  };
  redrawBank();
  updateAnswer();
  opts.appendChild(answer);
  opts.appendChild(bank);

  const controls = document.createElement('div');
  controls.className = 'reorder-controls';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn btn-outline';
  reset.textContent = 'Сброс';
  reset.addEventListener('click', () => {
    source.splice(0, source.length, ...(q.tokens || []));
    answerTokens.splice(0, answerTokens.length);
    updateAnswer();
    redrawBank();
  });
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn btn-primary';
  submit.textContent = 'Проверить порядок';
  submit.addEventListener('click', () => selectAnswer(answerTokens, q, pts, submit, opts));
  controls.appendChild(reset);
  controls.appendChild(submit);
  opts.appendChild(controls);
}

let answerInFlight = false;
async function selectAnswer(selected, question, pts, btn, optsEl) {
  if (answerInFlight) return;
  answerInFlight = true;
  const res = await fetch(`${API}/lesson/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      attempt_id: lessonAttemptId,
      exercise_id: question.exercise_id,
      answer: selected
    }),
    credentials: 'include'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error || 'Не удалось отправить ответ', 'error');
    answerInFlight = false;
    return;
  }
  const isCorrect = Boolean(data.is_correct);
  const correct = data.correct_answer;
  const explanation = data.explanation || null;
  const articleRef = data.article_ref || null;

  [...optsEl.querySelectorAll('.quiz-option, select, .btn')].forEach(b => {
    b.classList.add('disabled');
    b.disabled = true;
    if (typeof correct === 'string') {
      const candidate = (b.dataset?.answerValue || b.textContent || '').trim();
      if (candidate === String(correct).trim()) b.classList.add('correct');
    }
    if (b === btn && !isCorrect) b.classList.add('wrong');
  });

  if (isCorrect) {
    score += pts;
  }
  gameState.hearts_current = data.hearts_current ?? gameState.hearts_current;
  gameState.hearts_next_refill_at = data.hearts_next_refill_at ?? gameState.hearts_next_refill_at;
  if (data.question_streak_current != null) gameState.question_streak_current = data.question_streak_current;
  if (data.question_streak_best != null) gameState.question_streak_best = data.question_streak_best;
  updateQuizMeta();

  if (isCorrect) {
    const st = Number(data.question_streak_current || 0);
    const praiseToast = {
      3: 'Три верных подряд — отличный темп!',
      5: 'Пять подряд без ошибок — так держать!',
      7: 'Серия из семи — впечатляюще!',
      10: 'Десять подряд — блестяще!',
      15: 'Пятнадцать верных — безупречная работа!',
    };
    if (praiseToast[st]) showToast(praiseToast[st], 'success');
    else if (st > 15 && st % 5 === 0) showToast(`${st} верных ответов подряд!`, 'success');
  }

  function advanceToNext() {
    currentIndex++;
    const feedbackEl = document.getElementById('quiz-answer-feedback');
    if (feedbackEl) feedbackEl.classList.add('hidden');
    if (currentIndex < questions.length) {
      renderQuestion();
    } else {
      finishQuiz();
    }
    answerInFlight = false;
  }

  const feedbackEl = document.getElementById('quiz-answer-feedback');
  const correctEl = document.getElementById('quiz-feedback-correct');
  const explanationEl = document.getElementById('quiz-feedback-explanation');
  const articleEl = document.getElementById('quiz-feedback-article');
  const titleEl = document.getElementById('quiz-feedback-title');

  if (feedbackEl && correctEl) {
    if (titleEl) {
      if (!isCorrect) titleEl.textContent = 'Не совсем...';
      else {
        const st = Number(data.question_streak_current || 0);
        if (st >= 10) titleEl.textContent = 'Блестяще!';
        else if (st >= 5) titleEl.textContent = 'Превосходно!';
        else if (st >= 3) titleEl.textContent = 'Отлично!';
        else titleEl.textContent = 'Замечательно!';
      }
    }

      if (typeof correct === 'object' && Array.isArray(correct)) {
        if (question?.type === 'match_pairs') {
          const pairs = correct
            .map((p) => (p?.left && p?.right ? `${p.left} — ${p.right}` : String(p)))
            .filter(Boolean)
            .map((p) => `• ${escapeText(p)}`);
          correctEl.innerHTML = pairs.join('<br>') || '—';
        } else {
          correctEl.textContent = correct.map((p) => (p.left && p.right ? `${p.left} — ${p.right}` : String(p))).join('; ') || '—';
        }
    } else if (typeof correct === 'object') {
      correctEl.textContent = 'Правильный ответ отмечен выше.';
    } else {
      correctEl.textContent = correct || '—';
    }

    const fullExplanation = explanation || (isCorrect ? 'Ответ верный.' : 'Правильный ответ установлен уставом.');
    const hideExplanation = question?.type === 'match_pairs' || (!explanation && isCorrect);
    const oldMoreBtn = feedbackEl.querySelector('.quiz-feedback-more-btn');
    if (oldMoreBtn) oldMoreBtn.remove();
    explanationEl.classList.toggle('hidden', hideExplanation);
    if (!hideExplanation) {
      const isLong = String(fullExplanation).length > 240;
      explanationEl.textContent = isLong ? compactText(fullExplanation, 240) : fullExplanation;
      if (isLong) {
        const moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'btn btn-outline quiz-feedback-more-btn';
        moreBtn.textContent = 'Показать полностью';
        let expanded = false;
        moreBtn.addEventListener('click', () => {
          expanded = !expanded;
          explanationEl.textContent = expanded ? fullExplanation : compactText(fullExplanation, 240);
          moreBtn.textContent = expanded ? 'Свернуть' : 'Показать полностью';
        });
        explanationEl.insertAdjacentElement('afterend', moreBtn);
      }
    }

    articleEl.textContent = articleRef ? `Ссылка на устав: ${articleRef}` : '';
    articleEl.classList.toggle('hidden', !articleRef);

    feedbackEl.classList.remove('hidden');

    const nextBtn = document.getElementById('quiz-feedback-next');
    if (nextBtn) {
      const goNext = () => {
        nextBtn.removeEventListener('click', goNext);
        advanceToNext();
      };
      nextBtn.addEventListener('click', goNext);
    } else {
      setTimeout(advanceToNext, 800);
    }
  } else {
    setTimeout(advanceToNext, 800);
  }
}

async function finishQuiz() {
  lessonHeartsUnlimited = false;
  document.getElementById('quiz-question').classList.add('hidden');
  const resultEl = document.getElementById('quiz-result');
  resultEl.classList.remove('hidden');
  let awardedXp = 0;
  if (lessonAttemptId) {
    const completeRes = await fetch(`${API}/lesson/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attempt_id: lessonAttemptId }),
      credentials: 'include'
    });
    const completeData = await completeRes.json().catch(() => ({}));
    if (completeRes.ok) {
      awardedXp = completeData.xp_awarded || 0;
      score = completeData.score ?? score;
      gameState.hearts_current = completeData.hearts_current ?? gameState.hearts_current;
      gameState.streak_current = completeData.streak_current ?? gameState.streak_current;
      gameState.xp_total = completeData.xp_total ?? gameState.xp_total;
      updateQuizMeta();
      // refresh quests and path progress after completing a lesson
      loadPathScreen();
    }
  }
  document.getElementById('result-score').textContent = score;

  const maxScore = questions.reduce((s, q) => s + (q.points || 10), 0);
  let msg = '';
  if (score === maxScore) msg = 'Отлично! Все ответы верные!';
  else if (score >= maxScore * 0.7) msg = 'Хороший результат!';
  else msg = 'Продолжайте практиковаться!';
  const xpSuffix = awardedXp > 0 ? ` Вы получили ${awardedXp} XP.` : '';
  document.getElementById('result-message').textContent = `${msg}${xpSuffix}`;
}

function init() {
  fetchMe();
  if (!uiTickerStarted) {
    uiTickerStarted = true;
    setInterval(() => {
      updateQuizMeta();
    }, 1000);
    setInterval(() => {
      if (currentUser) refreshGameState();
    }, 30000);
  }

  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', e => {
      if (el.tagName === 'A') e.preventDefault();
      const nav = el.getAttribute('data-nav');
      if ((nav === 'quiz' || nav === 'path' || nav === 'placement' || nav === 'profile' || nav === 'admin') && !currentUser) {
        showScreen('login');
        return;
      }
      if (nav === 'admin' && !userIsAdmin()) {
        showToast('Нет прав администратора', 'error');
        return;
      }
      showScreen(nav);
    });
  });

  document.getElementById('login-form')?.addEventListener('submit', handleLogin);
  document.getElementById('register-form')?.addEventListener('submit', handleRegister);
  document.getElementById('logout-btn')?.addEventListener('click', handleLogout);
  document.getElementById('change-password-form')?.addEventListener('submit', handleChangePassword);
  document.getElementById('open-change-password-btn')?.addEventListener('click', openChangePasswordModal);
  document.getElementById('close-change-password-btn')?.addEventListener('click', closeChangePasswordModal);
  document.getElementById('cancel-change-password-btn')?.addEventListener('click', closeChangePasswordModal);
  document.getElementById('change-password-modal')?.addEventListener('click', (e) => {
    if (e.target?.id === 'change-password-modal') closeChangePasswordModal();
  });
  document.getElementById('profile-avatar-btn')?.addEventListener('click', () => {
    document.getElementById('profile-avatar-input')?.click();
  });
  document.getElementById('profile-avatar-input')?.addEventListener('change', handleAvatarFileChange);
  document.getElementById('open-achievements-btn')?.addEventListener('click', openAchievementsModal);
  document.getElementById('close-achievements-btn')?.addEventListener('click', closeAchievementsModal);
  document.getElementById('ok-achievements-btn')?.addEventListener('click', closeAchievementsModal);
  document.getElementById('achievements-modal')?.addEventListener('click', (e) => {
    if (e.target?.id === 'achievements-modal') closeAchievementsModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeChangePasswordModal();
      closeAchievementsModal();
      closeQuizCourseDropdown();
    }
  });

  document.getElementById('quiz-course-trigger')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const dd = document.getElementById('quiz-course-dropdown');
    const wasOpen = dd && !dd.classList.contains('hidden');
    setQuizCourseDropdownOpen(!wasOpen);
  });

  document.getElementById('quiz-course-list')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.quiz-course-option');
    if (!btn || !btn.dataset.lang) return;
    document.getElementById('quiz-lang').value = btn.dataset.lang;
    syncQuizLangCards(btn.dataset.lang);
    if (!document.getElementById('quiz-step-level').classList.contains('hidden')) {
      renderProficiencyOptions();
    }
    refreshQuestsHub();
    closeQuizCourseDropdown();
  });

  document.addEventListener('click', () => {
    const dd = document.getElementById('quiz-course-dropdown');
    if (dd && !dd.classList.contains('hidden')) {
      closeQuizCourseDropdown();
    }
  });

  document.querySelector('.quiz-course-bar-inner')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
  });

  document.getElementById('quiz-lang-next')?.addEventListener('click', () => {
    closeQuizCourseDropdown();
    document.getElementById('quiz-step-lang').classList.add('hidden');
    document.getElementById('quiz-step-level').classList.remove('hidden');
    renderProficiencyOptions();
  });

  document.getElementById('quiz-level-next')?.addEventListener('click', startQuiz);

  document.getElementById('quiz-level-back')?.addEventListener('click', () => {
    document.getElementById('quiz-step-level').classList.add('hidden');
    document.getElementById('quiz-step-lang').classList.remove('hidden');
  });

  document.getElementById('quiz-retry')?.addEventListener('click', () => {
    document.getElementById('quiz-result').classList.add('hidden');
    if (quizLaunchedFromPath) {
      quizLaunchedFromPath = false;
      showScreen('path');
      resetQuizUI();
      return;
    }
    resetQuizToLevelStep();
  });

  document.getElementById('path-placement-btn')?.addEventListener('click', () => {
    showScreen('placement');
  });

  document.getElementById('path-review-btn')?.addEventListener('click', async () => {
    const res = await fetch(`${API}/review-queue`, { credentials: 'include' });
    const queue = await res.json().catch(() => []);
    if (!Array.isArray(queue) || queue.length === 0) {
      showToast('Сейчас нет задач на повторение. Пройдите новый урок.', 'error');
      return;
    }
    const lang = pathLang || getSelectedLang();
    selectedProficiency = 1;
    lessonSlotIndex = 0;
    await startQuizWithPreset(lang, 1);
  });

  document.getElementById('placement-start-btn')?.addEventListener('click', startPlacement);
  document.getElementById('placement-finish-btn')?.addEventListener('click', () => {
    showScreen('path');
  });

  document.getElementById('admin-upload-form')?.addEventListener('submit', handleAdminUpload);
  document.getElementById('admin-text-form')?.addEventListener('submit', handleAdminText);
  document.getElementById('admin-btn-download-file')?.addEventListener('click', handleAdminExportFile);
  document.getElementById('admin-btn-download-text')?.addEventListener('click', handleAdminExportText);

  const hash = window.location.hash.slice(1);
  if (hash && screens[hash]) showScreen(hash);
}

init();
