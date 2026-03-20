const API = '/api';

let currentUser = null;
let questions = [];
let currentIndex = 0;
let score = 0;
let pointsPerQuestion = 10;
let lessonAttemptId = null;
/** Урок уровня 1: сердца не списываются (сервер hearts_unlimited). */
let lessonHeartsUnlimited = false;
let gameState = { hearts_current: 5, streak_current: 0, xp_total: 0 };
let uiTickerStarted = false;

const screens = {
  home: 'screen-home',
  login: 'screen-login',
  register: 'screen-register',
  path: 'screen-path',
  quiz: 'screen-quiz',
  placement: 'screen-placement',
  leaderboard: 'screen-leaderboard',
  profile: 'screen-profile'
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

function showScreen(name) {
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
  if (name === 'quiz') resetQuizUI();
  if (name === 'placement') resetPlacementUI();
  if (name === 'profile') loadProfileScreen();
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
  } else {
    homeAuth?.classList.remove('hidden');
    homeUser?.classList.add('hidden');
    logoutBtn?.classList.add('hidden');
    userInfo?.classList.add('hidden');
    navLogin?.classList.remove('hidden');
    navRegister?.classList.remove('hidden');
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

const STATUTE_SECTIONS = {
  uvs: [
    { id: 'uvs-m1-r1', module: 1, section: 1, title: 'Воинские ритуалы', level: 1 },
    { id: 'uvs-m1-r2', module: 1, section: 2, title: 'Боевое знамя части: хранение и охрана', level: 1 },
    { id: 'uvs-m2-r1', module: 2, section: 1, title: 'Права и обязанности военнослужащих', level: 2 },
    { id: 'uvs-m2-r2', module: 2, section: 2, title: 'Взаимоотношения между военнослужащими', level: 2 },
    { id: 'uvs-m3-r1', module: 3, section: 1, title: 'Распределение времени и внутренний порядок', level: 3 },
    { id: 'uvs-m3-r2', module: 3, section: 2, title: 'Суточный наряд и обязанности лиц наряда', level: 3 },
  ],
  du: [
    { id: 'du-m1-r1', module: 1, section: 1, title: 'Основы воинской дисциплины', level: 1 },
    { id: 'du-m1-r2', module: 1, section: 2, title: 'Подчиненность и единоначалие', level: 1 },
    { id: 'du-m2-r1', module: 2, section: 1, title: 'Поощрения в подразделении', level: 2 },
    { id: 'du-m2-r2', module: 2, section: 2, title: 'Дисциплинарные взыскания', level: 2 },
    { id: 'du-m3-r1', module: 3, section: 1, title: 'Права и порядок обжалования', level: 3 },
    { id: 'du-m3-r2', module: 3, section: 2, title: 'Разбор дисциплинарных кейсов', level: 3 },
  ],
  gks: [
    { id: 'gks-m1-r1', module: 1, section: 1, title: 'Организация караульной службы', level: 1 },
    { id: 'gks-m1-r2', module: 1, section: 2, title: 'Пост и обязанности часового', level: 1 },
    { id: 'gks-m2-r1', module: 2, section: 1, title: 'Развод и смена караула', level: 2 },
    { id: 'gks-m2-r2', module: 2, section: 2, title: 'Сигналы и меры безопасности', level: 2 },
    { id: 'gks-m3-r1', module: 3, section: 1, title: 'Действия при тревоге', level: 3 },
    { id: 'gks-m3-r2', module: 3, section: 2, title: 'Оборона объекта: практика', level: 3 },
  ],
  su: [
    { id: 'su-m1-r1', module: 1, section: 1, title: 'Строй и строевая стойка', level: 1 },
    { id: 'su-m1-r2', module: 1, section: 2, title: 'Команды и строевые приемы', level: 1 },
    { id: 'su-m2-r1', module: 2, section: 1, title: 'Движение строевым шагом', level: 2 },
    { id: 'su-m2-r2', module: 2, section: 2, title: 'Повороты и перестроения', level: 2 },
    { id: 'su-m3-r1', module: 3, section: 1, title: 'Торжественный марш', level: 3 },
    { id: 'su-m3-r2', module: 3, section: 2, title: 'Сложные строевые сценарии', level: 3 },
  ],
};

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
  const moduleCompletion = {
    1: Number(skillByLevel.get(1)?.mastery || 0) >= 100,
    2: Number(skillByLevel.get(2)?.mastery || 0) >= 100,
    3: Number(skillByLevel.get(3)?.mastery || 0) >= 100,
  };
  const moduleUnlocked = {
    1: true,
    2: moduleCompletion[1],
    3: moduleCompletion[2],
  };
  const sections = (STATUTE_SECTIONS[lang] || []).map((s, idx) => {
    const skill = skillByLevel.get(Number(s.level)) || {};
    const baseLocked = Boolean(skill.locked);
    const lockByModule = !moduleUnlocked[Number(s.module) || 1];
    return {
      ...s,
      idx,
      mastery: Number(skill.mastery || 0),
      lessons: Number(skill.lessons || 0),
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

  const shell = document.createElement('div');
  shell.className = 'path-map-shell';
  shell.innerHTML = `
    <div class="path-hero">
      <div class="path-hero-row">
        <div class="path-hero-head">
          <div class="path-hero-top">Модуль ${Number(firstOpen.module) || 1}, раздел ${Number(firstOpen.section) || 1}</div>
          <h3>${escapeHtml(firstOpen.title || unit.title || 'Путь обучения')}</h3>
        </div>
        <button type="button" class="btn path-handbook-btn" id="path-handbook-btn">Справочник</button>
      </div>
      <p>Изучайте разделы по порядку и переходите к следующему узлу после закрепления темы.</p>
      <div class="path-handbook hidden" id="path-handbook">
        <div class="path-handbook-title">${escapeHtml(handbook.title)}</div>
        <div class="path-handbook-subtitle">${escapeHtml(handbook.subtitle)}</div>
        <ul class="path-handbook-list">${handbookPoints}</ul>
      </div>
    </div>
    <div class="path-map">
      <div class="path-track" id="path-track"></div>
      <div class="path-mascot ${soldierRank}" id="path-mascot" aria-hidden="true">
        <div class="soldier">
          <div class="soldier-shadow"></div>
          <div class="soldier-helmet"></div>
          <div class="soldier-visor"></div>
          <div class="soldier-head"></div>
          <div class="soldier-body"></div>
          <div class="soldier-vest"></div>
          <div class="soldier-pack"></div>
          <div class="soldier-arm"></div>
          <div class="soldier-arm second"></div>
          <div class="soldier-rifle"></div>
          <div class="soldier-legs"></div>
          <div class="soldier-boots"></div>
        </div>
      </div>
    </div>
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
      const moduleTitle = document.createElement('div');
      moduleTitle.className = 'path-module-title';
      moduleTitle.textContent = `Модуль ${section.module}`;
      track?.appendChild(moduleTitle);
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
    const node = document.createElement('button');
    node.type = 'button';
    node.className = `path-node ${section.locked ? 'locked' : 'open'} ${section.mastery >= 100 ? 'done' : ''} ${i % 2 ? 'right' : 'left'}`;
    node.dataset.sectionIdx = String(section.idx);
    node.disabled = section.locked;
    node.innerHTML = `
      <span class="path-node-badge">Ур. ${section.level}</span>
      <strong>${escapeHtml(section.title)}</strong>
      <small>Освоение ${Math.max(0, Math.min(100, section.mastery))}% · уроков ${section.lessons}</small>
    `;
    if (!section.locked && mascotTarget && section.idx === mascotTarget.idx) {
      const launchWrap = document.createElement('div');
      launchWrap.className = 'path-node-launch';
      launchWrap.innerHTML = `
        <span class="path-node-launch-label">В БОЙ!</span>
        <span class="path-node-launch-btn" aria-hidden="true">
          <span class="tank-icon">
            <span class="tank-body"></span>
            <span class="tank-turret"></span>
            <span class="tank-barrel"></span>
            <span class="tank-track"></span>
          </span>
        </span>
      `;
      node.appendChild(launchWrap);
    }
    if (!section.locked) {
      node.addEventListener('click', () => {
        selectedProficiency = Number(section.level);
        startQuizWithPreset(lang, Number(section.level));
      });
    }
    track?.appendChild(node);
  });

  const mascot = shell.querySelector('#path-mascot');
  const mapEl = shell.querySelector('.path-map');
  const targetNode = shell.querySelector(`.path-node[data-section-idx="${mascotTarget?.idx}"]`);
  if (mascot && mapEl && targetNode) {
    const padding = 8;
    const gap = 18;
    const mapW = mapEl.clientWidth;
    const mapH = mapEl.clientHeight;
    const mW = mascot.offsetWidth;
    const mH = mascot.offsetHeight;
    const nodeX = targetNode.offsetLeft;
    const nodeY = targetNode.offsetTop;
    const nodeW = targetNode.offsetWidth;
    const nodeH = targetNode.offsetHeight;
    const nodeCenterY = nodeY + nodeH / 2;
    const wantsLeft = targetNode.classList.contains('right');

    const candidates = [
      {
        left: wantsLeft ? nodeX - mW - gap : nodeX + nodeW + gap,
        top: nodeCenterY - mH / 2,
      },
      {
        left: wantsLeft ? nodeX + nodeW + gap : nodeX - mW - gap,
        top: nodeCenterY - mH / 2,
      },
      {
        left: nodeX + nodeW / 2 - mW / 2,
        top: nodeY + nodeH + 10,
      },
      {
        left: nodeX + nodeW / 2 - mW / 2,
        top: nodeY - mH - 10,
      },
    ];

    const clampPos = (p) => ({
      left: Math.max(padding, Math.min(mapW - mW - padding, p.left)),
      top: Math.max(padding, Math.min(mapH - mH - padding, p.top)),
    });
    const overlapsNode = (p) => {
      const aL = p.left;
      const aT = p.top;
      const aR = aL + mW;
      const aB = aT + mH;
      const bL = nodeX;
      const bT = nodeY;
      const bR = bL + nodeW;
      const bB = bT + nodeH;
      return aL < bR && aR > bL && aT < bB && aB > bT;
    };

    let chosen = null;
    for (const raw of candidates) {
      const p = clampPos(raw);
      if (!overlapsNode(p)) {
        chosen = p;
        break;
      }
    }
    if (!chosen) chosen = clampPos(candidates[0]);
    mascot.style.top = `${Math.round(chosen.top)}px`;
    mascot.style.left = `${Math.round(chosen.left)}px`;
    mascot.style.right = 'auto';
  } else if (mascot && sections.length > 1) {
    const topPct = Math.round(14 + (focusSafeIndex / (sections.length - 1)) * 66);
    mascot.style.top = `${topPct}%`;
  }
}

function renderQuests(quests) {
  const wrap = document.getElementById('quests-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  quests.forEach((q) => {
    const row = document.createElement('div');
    row.className = 'quest-row';
    const done = q.progress >= q.target;
    const title = q.title || q.id;
    row.innerHTML = `
      <div>
        <div><strong>${escapeHtml(title)}</strong></div>
        <small>${q.progress}/${q.target}</small>
      </div>
      <button class="btn ${done && !q.claimed ? 'btn-primary' : 'btn-outline'}" ${(!done || q.claimed) ? 'disabled' : ''}>
        ${q.claimed ? 'Получено' : done ? 'Забрать +20 XP' : 'В процессе'}
      </button>
    `;
    const btn = row.querySelector('button');
    if (btn && done && !q.claimed) {
      btn.addEventListener('click', async () => {
        const res = await fetch(`${API}/quests/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quest_id: q.id, lang: pathLang || getSelectedLang() }),
          credentials: 'include',
        });
        if (!res.ok) return;
        const data = await res.json();
        gameState = data.game_state || gameState;
        updateQuizMeta();
        renderQuests(data.quests || []);
      });
    }
    wrap.appendChild(row);
  });
}

async function startQuizWithPreset(lang, level) {
  showScreen('quiz');
  await loadQuestions(lang, level);
  if (!questions.length) return;
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

async function loadQuestions(lang, level) {
  const l = lang || document.getElementById('quiz-lang')?.value || 'uvs';
  const lev = level ?? selectedProficiency ?? 1;
  // Сразу включаем UI-режим бесконечных жизней для лёгкого уровня.
  lessonHeartsUnlimited = Number(lev) === 1;
  updateQuizMeta();
  const res = await fetch(`${API}/lesson/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang: l, level: lev, question_count: 24 }),
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

function resetQuizUI() {
  document.getElementById('quiz-start').classList.remove('hidden');
  document.getElementById('quiz-question').classList.add('hidden');
  document.getElementById('quiz-result').classList.add('hidden');
  document.getElementById('quiz-step-lang').classList.remove('hidden');
  document.getElementById('quiz-step-level').classList.add('hidden');
  document.querySelectorAll('#lang-cards .section-card, #lang-cards .lang-card').forEach((c, i) => c.classList.toggle('selected', i === 0));
  document.getElementById('quiz-lang').value = 'uvs';
  selectedProficiency = null;
  lessonAttemptId = null;
  lessonHeartsUnlimited = false;
  answerInFlight = false;
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
  const langSelect = document.getElementById('quiz-lang');
  const lang = langSelect ? langSelect.value : 'uvs';
  const level = selectedProficiency !== null ? selectedProficiency : 1;

  await loadQuestions(lang, level);
  if (questions.length === 0) {
    showToast(`Нет вопросов для раздела "${lang}" и уровня ${level}. Попробуйте другой уровень или раздел.`, 'error');
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
  } else if (qType === 'true_false' || qType === 'true-false') {
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
    if (titleEl) titleEl.textContent = isCorrect ? 'Замечательно!' : 'Не совсем...';

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
      if ((nav === 'quiz' || nav === 'path' || nav === 'placement' || nav === 'profile') && !currentUser) {
        showScreen('login');
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
    }
  });

  document.getElementById('quiz-lang-next')?.addEventListener('click', () => {
    document.getElementById('quiz-step-lang').classList.add('hidden');
    document.getElementById('quiz-step-level').classList.remove('hidden');
    renderProficiencyOptions();
  });

  document.getElementById('quiz-level-next')?.addEventListener('click', startQuiz);

  document.getElementById('quiz-level-back')?.addEventListener('click', () => {
    document.getElementById('quiz-step-level').classList.add('hidden');
    document.getElementById('quiz-step-lang').classList.remove('hidden');
  });

  document.querySelectorAll('.section-card, .lang-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.section-card, .lang-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      document.getElementById('quiz-lang').value = card.dataset.lang;
      if (!document.getElementById('quiz-step-level').classList.contains('hidden')) {
        renderProficiencyOptions();
      }
    });
  });

  document.getElementById('quiz-retry')?.addEventListener('click', () => {
    document.getElementById('quiz-result').classList.add('hidden');
    resetQuizUI();
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
    await startQuizWithPreset(lang, 1);
  });

  document.getElementById('placement-start-btn')?.addEventListener('click', startPlacement);
  document.getElementById('placement-finish-btn')?.addEventListener('click', () => {
    showScreen('path');
  });

  const hash = window.location.hash.slice(1);
  if (hash && screens[hash]) showScreen(hash);
}

init();
