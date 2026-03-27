/**
 * Один HTML-файл: автономный тест с вопросами, итогом /10 и разбором ответов.
 */

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugifyFilename(title) {
  const base = String(title || 'test')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `${base || 'test'}-${Date.now().toString(36)}.html`;
}

function jsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/</g, '\\u003c');
}

/**
 * @param {{ title: string, subtitle?: string, questions: object[] }} payload
 * questions: validated word/sentence from generator
 */
function buildStandaloneQuizHtml(payload) {
  const title = escapeHtml(payload.title || 'Тест');
  const subLine = String(payload.subtitle ?? '').trim();
  const subHtml = subLine ? `<p class="sub">${escapeHtml(subLine)}</p>` : '';
  const raw = payload.questions.map((q) => {
    if (q.type === 'word') {
      return {
        t: 'w',
        word: q.word,
        translation: q.translation,
        w1: q.wrong1,
        w2: q.wrong2,
        w3: q.wrong3,
        ex: q.explanation || '',
        ar: q.article_ref || '',
      };
    }
    return {
      t: 's',
      s: q.sentence,
      c: q.correct,
      w1: q.wrong1,
      w2: q.wrong2,
      w3: q.wrong3,
      ex: q.explanation || '',
      ar: q.article_ref || '',
    };
  });
  const dataJson = jsonForScript({ title: payload.title || 'Тест', items: raw });

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    :root {
      --bg: #0f1b12;
      --card: #1b2a1f;
      --border: #36513a;
      --text: #e8f1e8;
      --muted: #a6b8a7;
      --accent: #4f8a4f;
      --ok: #4ea85d;
      --bad: #e07060;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      min-height: 100vh;
      padding: 1rem;
    }
    .wrap { max-width: 640px; margin: 0 auto; }
    h1 { font-size: 1.35rem; margin: 0 0 0.35rem; }
    .sub { color: var(--muted); font-size: 0.9rem; margin-bottom: 1.25rem; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 1rem 1.1rem;
      margin-bottom: 1rem;
    }
    .q-num { font-size: 0.8rem; color: var(--muted); margin-bottom: 0.35rem; }
    .prompt { font-weight: 600; margin-bottom: 0.75rem; white-space: pre-wrap; }
    .opts { display: flex; flex-direction: column; gap: 0.45rem; }
    label.opt {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      padding: 0.55rem 0.65rem;
      border-radius: 10px;
      border: 1px solid rgba(54, 81, 58, 0.7);
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    label.opt:hover { border-color: var(--accent); background: rgba(79, 138, 79, 0.12); }
    label.opt input { margin-top: 0.2rem; }
    .actions { display: flex; gap: 0.6rem; flex-wrap: wrap; margin-top: 1rem; }
    button {
      font: inherit;
      padding: 0.65rem 1.1rem;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--accent);
      color: #fff;
      font-weight: 700;
      cursor: pointer;
    }
    button.secondary { background: transparent; color: var(--text); }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    #screen-result { display: none; }
    #screen-result.visible { display: block; }
    #screen-quiz.hidden { display: none; }
    .score-big { font-size: 2.2rem; font-weight: 800; color: #bfe6bf; margin: 0.25rem 0; }
    .stat { color: var(--muted); margin: 0.35rem 0; }
    .review-item {
      border-top: 1px solid var(--border);
      padding: 0.85rem 0;
    }
    .review-item:first-of-type { border-top: 0; }
    .ok { color: var(--ok); }
    .wrong { color: var(--bad); }
    .ex { font-size: 0.88rem; color: var(--muted); margin-top: 0.35rem; }
    .ar { font-size: 0.82rem; color: #7a9a7a; margin-top: 0.25rem; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>${title}</h1>
    ${subHtml}

    <div id="screen-quiz">
      <div class="card" id="q-card"></div>
      <div class="actions">
        <button type="button" id="btn-prev" class="secondary">Назад</button>
        <button type="button" id="btn-next">Далее</button>
      </div>
    </div>

    <div id="screen-result" class="card">
      <h2 style="margin:0 0 0.5rem;font-size:1.15rem;">Итоги</h2>
      <div class="score-big" id="out-score"></div>
      <p class="stat" id="out-stats"></p>
      <p class="stat" id="out-errors"></p>
      <h3 style="margin:1rem 0 0.5rem;font-size:1rem;">Разбор ответов</h3>
      <div id="out-review"></div>
      <div class="actions" style="margin-top:1rem;">
        <button type="button" class="secondary" id="btn-retry">Пройти снова</button>
      </div>
    </div>
  </div>

  <script>
  (function () {
    const DATA = ${dataJson};
    const items = DATA.items.map(function (raw, i) {
      if (raw.t === 'w') {
        var opts = [raw.translation, raw.w1, raw.w2, raw.w3];
        shuffle(opts);
        return {
          i: i + 1,
          prompt: 'Выберите верное определение термина «' + raw.word + '»:',
          options: opts,
          correct: raw.translation,
          explanation: raw.ex,
          article_ref: raw.ar
        };
      }
      var o2 = [raw.c, raw.w1, raw.w2, raw.w3];
      shuffle(o2);
      return {
        i: i + 1,
        prompt: 'Вставьте пропущенное слово:\\n\\n' + raw.s,
        options: o2,
        correct: raw.c,
        explanation: raw.ex,
        article_ref: raw.ar
      };
    });

    var idx = 0;
    var answers = [];

    function shuffle(a) {
      for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = a[i]; a[i] = a[j]; a[j] = t;
      }
    }

    function render() {
      var q = items[idx];
      var card = document.getElementById('q-card');
      var sel = answers[idx];
      var html = '<div class="q-num">Вопрос ' + q.i + ' из ' + items.length + '</div>';
      html += '<div class="prompt">' + esc(q.prompt) + '</div><div class="opts">';
      q.options.forEach(function (opt, oi) {
        var id = 'o' + idx + '_' + oi;
        var checked = sel === opt ? ' checked' : '';
        html += '<label class="opt" for="' + id + '"><input type="radio" name="ans" id="' + id + '" value="' + escAttr(opt) + '"' + checked + '> ' + esc(opt) + '</label>';
      });
      html += '</div>';
      card.innerHTML = html;
      document.getElementById('btn-prev').disabled = idx === 0;
      document.getElementById('btn-next').textContent = idx === items.length - 1 ? 'Завершить' : 'Далее';
    }

    function esc(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\\n/g, '<br>');
    }
    function escAttr(s) {
      return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
    }

    function collect() {
      var r = document.querySelector('#q-card input[name="ans"]:checked');
      answers[idx] = r ? r.value : null;
    }

    function finish() {
      collect();
      var correct = 0;
      for (var i = 0; i < items.length; i++) {
        if (answers[i] === items[i].correct) correct++;
      }
      var n = items.length;
      var wrong = n - correct;
      var score10 = Math.round((10 * correct / n) * 10) / 10;
      document.getElementById('out-score').textContent = 'Оценка: ' + score10 + ' из 10';
      document.getElementById('out-stats').textContent = 'Верных ответов: ' + correct + ' из ' + n;
      document.getElementById('out-errors').textContent = 'Ошибок: ' + wrong;

      var rev = '';
      for (var j = 0; j < items.length; j++) {
        var q = items[j];
        var userAns = answers[j];
        var ok = userAns === q.correct;
        rev += '<div class="review-item">';
        rev += '<div><strong>Вопрос ' + q.i + '</strong> <span class="' + (ok ? 'ok' : 'wrong') + '">' + (ok ? '✓ верно' : '✗ неверно') + '</span></div>';
        rev += '<div class="prompt" style="margin-top:0.35rem;font-weight:500;">' + esc(q.prompt) + '</div>';
        rev += '<div class="ex">Ваш ответ: ' + (userAns ? esc(userAns) : '— не выбран') + '</div>';
        rev += '<div class="ex">Правильно: <strong>' + esc(q.correct) + '</strong></div>';
        if (q.explanation) rev += '<div class="ex">' + esc(q.explanation) + '</div>';
        if (q.article_ref) rev += '<div class="ar">' + esc(q.article_ref) + '</div>';
        rev += '</div>';
      }
      document.getElementById('out-review').innerHTML = rev;

      document.getElementById('screen-quiz').classList.add('hidden');
      document.getElementById('screen-result').classList.add('visible');
    }

    function restart() {
      answers = [];
      idx = 0;
      items.forEach(function (q) {
        var o = q.options.slice();
        shuffle(o);
        q.options = o;
      });
      document.getElementById('screen-result').classList.remove('visible');
      document.getElementById('screen-quiz').classList.remove('hidden');
      render();
    }

    document.getElementById('btn-next').onclick = function () {
      collect();
      if (idx < items.length - 1) { idx++; render(); }
      else finish();
    };
    document.getElementById('btn-prev').onclick = function () {
      collect();
      if (idx > 0) { idx--; render(); }
    };
    document.getElementById('btn-retry').onclick = restart;

    render();
  })();
  </script>
</body>
</html>`;
}

module.exports = { buildStandaloneQuizHtml, slugifyFilename };
