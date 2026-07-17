/* =========================================================
   地図作成カレンダーアプリ
   データはGitHubリポジトリ内の data/tasks.json に保存されます。
   バックエンドサーバは使用せず、ブラウザから直接GitHub Contents API
   を呼び出して読み書きします。GitHub未接続の間はサンプルデータで
   操作感を確認できます。
   ========================================================= */

const CONFIG_KEY = 'sprayTaskApp.config.v2';

const STAGES = [
  { key: 'orderData', label: '申込データ', group: 'data', dividerAfter: true },
  { key: 'mapDraft', label: '地図仮完', group: 'map' },
  { key: 'correctionReq', label: '修正依頼', group: 'map' },
  { key: 'mapConfirmed', label: '地図確認完', group: 'map', dividerAfter: true },
  { key: 'duplicate', label: '重複処理', group: 'final' },
  { key: 'concierge', label: 'コンシェルジュ', group: 'final' },
];
const STAGE_GROUPS = [
  { key: 'data', label: '受付', count: 1 },
  { key: 'map', label: '地図関連', count: 3 },
  { key: 'final', label: '最終確認', count: 2 },
];

const state = {
  config: null,       // { owner, repo, branch, path, token }
  tasks: [],
  subjectFolders: {}, // { 実施主体名: コワークストレージの保管フォルダURL }
  sha: null,
  demoMode: false,     // GitHub未接続時はサンプルデータで表示
  activeTab: 'list',
  calendarMonth: startOfMonth(new Date()),
};

/* ---------- ユーティリティ ---------- */

function todayISO() { return formatDateISO(new Date()); }
function formatDateISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addDaysISO(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return formatDateISO(d);
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr + 'T00:00:00');
  const today = new Date(todayISO() + 'T00:00:00');
  return Math.round((target - today) / 86400000);
}
function weekdayLabel(dateStr) {
  const wd = ['日', '月', '火', '水', '木', '金', '土'];
  return wd[new Date(dateStr + 'T00:00:00').getDay()];
}
function uid() { return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function allStagesDone(t) { return STAGES.every((s) => t[s.key]); }

function formatMD(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/* Base64 <-> UTF-8 (日本語対応) */
function utf8ToB64(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g,
    (_, p1) => String.fromCharCode('0x' + p1)));
}
function b64ToUtf8(b64) {
  const clean = b64.replace(/\n/g, '');
  return decodeURIComponent(atob(clean).split('').map(
    (c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
  ).join(''));
}

/* ---------- サンプルデータ(GitHub未接続時のデモ表示用) ---------- */

function sampleTasks() {
  return [
    { id: 't1', subject: 'スカイテック北関東', sprayDate: addDaysISO(3),
      orderData: true, mapDraft: true, correctionReq: false, mapConfirmed: false, duplicate: false, concierge: false,
      comments: { mapDraft: '地図の仮完了まで進みました。' } },
    { id: 't2', subject: 'グリーンウィング栃木', sprayDate: addDaysISO(1),
      orderData: true, mapDraft: true, correctionReq: true, mapConfirmed: true, duplicate: true, concierge: false,
      comments: { duplicate: '重複エリアの確認完了。コンシェルジュ対応待ちです。' } },
    { id: 't3', subject: '北関東エアサービス', sprayDate: addDaysISO(-2),
      orderData: false, mapDraft: false, correctionReq: false, mapConfirmed: false, duplicate: false, concierge: false,
      comments: {} },
    { id: 't4', subject: 'スカイテック北関東', sprayDate: addDaysISO(10),
      orderData: true, mapDraft: true, correctionReq: true, mapConfirmed: true, duplicate: true, concierge: true,
      comments: { concierge: '全工程完了しました。' } },
  ];
}

/* ---------- 設定の読み書き ---------- */

function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn('localStorageが利用できない環境です(プレビュー表示など)。設定は保存されません。', err);
    return null;
  }
}
function saveConfig(cfg) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); }
  catch (err) { console.warn('localStorageへの保存に失敗しました。', err); }
}

/* ---------- GitHub Contents API ---------- */

function githubApiUrl(cfg, withRef = true) {
  const base = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.path}`;
  return withRef ? `${base}?ref=${encodeURIComponent(cfg.branch)}` : base;
}

async function githubGetFile(cfg) {
  // ブラウザがこのGETリクエストをキャッシュしてしまうと、常に古いshaを
  // 使い続けてしまい、何度リトライしても409が解消しない原因になる。
  // 毎回必ずネットワークから最新を取得するようにする。
  const res = await fetch(githubApiUrl(cfg), {
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });
  if (res.status === 404) return { notFound: true };
  if (!res.ok) throw new Error(`GitHub読み込みエラー (${res.status}): ${await res.text()}`);
  const json = await res.json();
  return { sha: json.sha, data: JSON.parse(b64ToUtf8(json.content)) };
}

async function githubPutFile(cfg, dataObj, message, sha) {
  const body = { message, content: utf8ToB64(JSON.stringify(dataObj, null, 2)), branch: cfg.branch };
  if (sha) body.sha = sha;
  const res = await fetch(githubApiUrl(cfg, false), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub書き込みエラー (${res.status}): ${await res.text()}`);
  return (await res.json()).content.sha;
}

function setSyncStatus(mode, text) {
  const el = document.getElementById('syncStatus');
  el.className = 'sync-status ' + mode;
  el.textContent = text;
}

async function loadFromGitHub() {
  if (!state.config) return;
  setSyncStatus('loading', '読み込み中…');
  try {
    const result = await githubGetFile(state.config);
    if (result.notFound) {
      state.tasks = [];
      state.sha = null;
      state.demoMode = false;
      setSyncStatus('error', 'tasks.json未作成 (設定画面から初期化してください)');
      render();
      return;
    }
    state.tasks = (result.data && result.data.tasks) || [];
    state.tasks.forEach((t) => { t.comments = t.comments || {}; });
    state.subjectFolders = (result.data && result.data.subjectFolders) || {};
    state.sha = result.sha;
    state.demoMode = false;
    setSyncStatus('ok', '接続中: ' + state.config.repo);
    render();
  } catch (err) {
    console.error(err);
    setSyncStatus('error', '読み込み失敗');
    alert('GitHubからの読み込みに失敗しました。\n' + err.message);
  }
}

// チェックボックスを連続でクリックすると、1つ前の保存が終わる前に次の保存が
// 始まってしまい、お互いのshaがずれて409エラーになりやすい。
// そのため実際の保存処理は必ず1件ずつ順番に実行されるようキューで直列化する。
let _saveQueue = Promise.resolve();

function saveToGitHub(message) {
  if (state.demoMode || !state.config) {
    render();
    return Promise.resolve(true);
  }
  const run = _saveQueue.then(() => saveToGitHubNow(message));
  // 失敗しても次の保存がキューで止まらないようにしておく
  _saveQueue = run.catch(() => {});
  return run;
}

async function saveToGitHubNow(message) {
  setSyncStatus('loading', '保存中…');
  // 他の人(または同じ人の別画面・ウィジェット)がほぼ同時に保存すると、
  // GitHub側のファイルが少し変わっていて409エラーになることがある。
  // その場合は最新のshaを取り直して数回まで自動リトライする。
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const latest = await githubGetFile(state.config);
      const sha = latest.notFound ? undefined : latest.sha;
      const newSha = await githubPutFile(state.config, { tasks: state.tasks, subjectFolders: state.subjectFolders }, message, sha);
      state.sha = newSha;
      setSyncStatus('ok', '接続中: ' + state.config.repo);
      return true;
    } catch (err) {
      const isConflict = /\(409\)/.test(err.message);
      if (isConflict && attempt < MAX_ATTEMPTS) {
        console.warn(`保存が競合したため再試行します (${attempt}/${MAX_ATTEMPTS})`, err);
        setSyncStatus('loading', '競合を解消して再試行中…');
        const backoff = 150 * attempt + Math.random() * 200;
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }
      console.error(err);
      setSyncStatus('error', '保存失敗');
      alert('GitHubへの保存に失敗しました。\n' + err.message);
      return false;
    }
  }
  return false;
}

/* ---------- タスク操作 ---------- */

function findTask(id) { return state.tasks.find((t) => t.id === id); }

async function addTask() {
  const subject = document.getElementById('inpSubject').value.trim();
  const date = document.getElementById('inpDate').value;
  if (!subject || !date) {
    alert('実施主体と散布実施日は必須です。');
    return;
  }
  const task = { id: uid(), subject, sprayDate: date, comments: {} };
  STAGES.forEach((s) => { task[s.key] = false; });
  state.tasks.push(task);
  document.getElementById('inpSubject').value = '';
  document.getElementById('inpDate').value = '';
  const ok = await saveToGitHub(`add task: ${subject}`);
  if (!ok) {
    // 保存に失敗したものを画面に残すと「見た目は追加されているのに実は
    // GitHubには保存されていない」というズレが起きるので、元に戻す。
    state.tasks = state.tasks.filter((t) => t.id !== task.id);
  }
  renderSubjectDatalist();
  render();
}

async function toggleStage(taskId, stageKey) {
  const t = findTask(taskId);
  if (!t) return;
  t[stageKey] = !t[stageKey];
  const ok = await saveToGitHub(`toggle ${stageKey}: ${t.subject}`);
  if (!ok) t[stageKey] = !t[stageKey]; // 保存に失敗したら画面上も元に戻す
  render();
}

async function editStageComment(taskId, stageKey) {
  const t = findTask(taskId);
  if (!t) return;
  const previous = t.comments[stageKey];
  const current = previous || '';
  const text = window.prompt('コメントを入力してください(空欄で削除できます):', current);
  if (text === null) return;
  if (text.trim() === '') delete t.comments[stageKey];
  else t.comments[stageKey] = text.trim();
  const ok = await saveToGitHub(`comment ${stageKey}: ${t.subject}`);
  if (!ok) {
    // 保存に失敗したら元のコメント状態に戻す
    if (previous === undefined) delete t.comments[stageKey];
    else t.comments[stageKey] = previous;
  }
  render();
}

/* ---------- 一覧表示 ---------- */

function subjectsList() { return [...new Set(state.tasks.map((t) => t.subject))]; }
function renderSubjectDatalist() {
  document.getElementById('subjectList').innerHTML =
    subjectsList().map((s) => `<option value="${escapeHtml(s)}">`).join('');
}

function stageCellHtml(t, stage) {
  const on = !!t[stage.key];
  const comment = t.comments[stage.key];
  const hasComment = !!comment;
  return `
    <td class="${stage.dividerAfter ? 'divider-after' : ''}">
      <div class="stage-cellwrap">
        <div class="stage-box ${on ? 'on' : ''} ${hasComment ? 'has-comment' : ''}"
             data-task="${t.id}" data-stage="${stage.key}">
          ${on ? '✓' : ''}
        </div>
        ${hasComment ? `<div class="comment-badge">!</div>` : ''}
        ${hasComment ? `<div class="stage-tip show">${escapeHtml(comment)}</div>` : ''}
      </div>
    </td>
  `;
}

function renderList() {
  const container = document.getElementById('listContainer');
  if (state.tasks.length === 0) {
    container.innerHTML = '<p style="padding:20px;color:var(--color-muted);">案件がありません。上のフォームから登録してください。</p>';
    return;
  }
  const sorted = state.tasks.slice().sort((a, b) => (a.sprayDate || '').localeCompare(b.sprayDate || ''));

  const groupRowCells = STAGE_GROUPS.map((g) =>
    `<th colspan="${g.count}" class="group-${g.key}">${escapeHtml(g.label)}</th>`
  ).join('');
  const labelRowCells = STAGES.map((s) =>
    `<th class="group-${s.group} ${s.dividerAfter ? 'divider-after' : ''}">${escapeHtml(s.label)}</th>`
  ).join('');

  const rows = sorted.map((t) => {
    const d = daysUntil(t.sprayDate);
    const urgent = d !== null && d <= 3 && d >= 0;
    const overdue = d !== null && d < 0;
    return `
      <tr class="${overdue ? 'row-overdue' : ''}">
        <td class="col-subject">
          <span class="subject-pill">${escapeHtml(t.subject)}</span>
          <button class="btn-folder-link ${state.subjectFolders[t.subject] ? 'set' : ''}" data-subject="${escapeHtml(t.subject)}" title="${state.subjectFolders[t.subject] ? '保管フォルダを開く(右クリックで変更)' : '保管フォルダのリンクを設定'}">📁</button>
        </td>
        ${STAGES.map((s) => stageCellHtml(t, s)).join('')}
        <td class="spray-date ${urgent ? 'urgent' : ''} ${overdue ? 'overdue-text' : ''}">${formatMD(t.sprayDate)}</td>
        <td style="text-align:center;">
          <button class="btn-delete-task" data-task="${t.id}" title="タスクを削除">×</button>
        </td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <table class="task-table">
      <thead>
        <tr class="group-row">
          <th rowspan="2" class="col-subject">実施主体</th>
          ${groupRowCells}
          <th rowspan="2">散布実施日</th>
          <th rowspan="2"></th>
        </tr>
        <tr class="label-row">
          ${labelRowCells}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  container.querySelectorAll('.stage-box').forEach((box) => {
    box.addEventListener('click', () => toggleStage(box.dataset.task, box.dataset.stage));
    box.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      editStageComment(box.dataset.task, box.dataset.stage);
    });
  });

  container.querySelectorAll('.btn-folder-link').forEach((btn) => {
    btn.addEventListener('click', () => openOrSetSubjectFolder(btn.dataset.subject, false));
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openOrSetSubjectFolder(btn.dataset.subject, true);
    });
  });

  container.querySelectorAll('.btn-delete-task').forEach((btn) => {
    btn.addEventListener('click', () => deleteTaskConfirm(btn.dataset.task));
  });
}

async function openOrSetSubjectFolder(subject, forceEdit) {
  const current = state.subjectFolders[subject] || '';
  if (current && !forceEdit) {
    window.open(current, '_blank', 'noopener');
    return;
  }
  const url = window.prompt(`\u300c${subject}\u300d\u306e\u4fdd\u7ba1\u30d5\u30a9\u30eb\u30c0\uff08\u30b3\u30ef\u30fc\u30af\u30b9\u30c8\u30ec\u30fc\u30b8\uff09\u306e\u30ea\u30f3\u30af\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\uff08\u7a7a\u6b04\u3067\u524a\u9664\u3067\u304d\u307e\u3059\uff09:`, current);
  if (url === null) return;
  const trimmed = url.trim();
  const previous = state.subjectFolders[subject];
  if (trimmed === '') delete state.subjectFolders[subject];
  else state.subjectFolders[subject] = trimmed;
  const ok = await saveToGitHub(`set folder link: ${subject}`);
  if (!ok) {
    if (previous === undefined) delete state.subjectFolders[subject];
    else state.subjectFolders[subject] = previous;
  }
  render();
}

async function deleteTaskConfirm(taskId) {
  const t = findTask(taskId);
  if (!t) return;
  const ok = window.confirm(`「${t.subject}」のタスクを削除します。よろしいですか?`);
  if (!ok) return;
  const index = state.tasks.indexOf(t);
  state.tasks = state.tasks.filter((x) => x.id !== taskId);
  const saved = await saveToGitHub(`delete task: ${t.subject}`);
  if (!saved) state.tasks.splice(index, 0, t); // 保存に失敗したら元に戻す
  render();
}

/* ---------- カレンダー表示 ---------- */

function renderCalendar() {
  const label = document.getElementById('calendarLabel');
  const grid = document.getElementById('calendarGrid');
  const month = state.calendarMonth;
  label.textContent = `${month.getFullYear()}年 ${month.getMonth() + 1}月`;

  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
  const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const startWeekday = firstDay.getDay();
  const totalDays = lastDay.getDate();

  const tasksByDate = {};
  for (const t of state.tasks) {
    if (!t.sprayDate) continue;
    (tasksByDate[t.sprayDate] = tasksByDate[t.sprayDate] || []).push(t);
  }

  const cells = [];
  ['日', '月', '火', '水', '木', '金', '土'].forEach((w) => {
    cells.push(`<div class="calendar-cell empty" style="min-height:auto;font-weight:600;text-align:center;">${w}</div>`);
  });
  for (let i = 0; i < startWeekday; i++) cells.push('<div class="calendar-cell empty"></div>');
  for (let day = 1; day <= totalDays; day++) {
    const dateStr = formatDateISO(new Date(month.getFullYear(), month.getMonth(), day));
    const isToday = dateStr === todayISO();
    const dayTasks = tasksByDate[dateStr] || [];
    const dots = dayTasks.slice(0, 3).map((t) => {
      const done = allStagesDone(t);
      return `<span class="cal-task-dot ${done ? 'done' : 'pending'}">${escapeHtml(t.subject)}</span>`;
    }).join('');
    const more = dayTasks.length > 3 ? `<span style="color:var(--color-muted);">他${dayTasks.length - 3}件</span>` : '';
    cells.push(`
      <div class="calendar-cell" data-date="${dateStr}">
        <div class="day-num ${isToday ? 'today' : ''}">${day}</div>
        ${dots}${more}
      </div>
    `);
  }

  grid.innerHTML = cells.join('');
  grid.querySelectorAll('.calendar-cell[data-date]').forEach((cell) => {
    cell.addEventListener('click', () => openCalendarDayPanel(cell.dataset.date));
  });
}

function openCalendarDayPanel(dateStr) {
  const panel = document.getElementById('calendarDayPanel');
  const tasks = state.tasks.filter((t) => t.sprayDate === dateStr);
  panel.hidden = false;
  if (tasks.length === 0) {
    panel.innerHTML = `<h3>${dateStr}</h3><p style="color:var(--color-muted);">この日の案件はありません。</p>`;
    return;
  }
  panel.innerHTML = `<h3>${dateStr} (${weekdayLabel(dateStr)}) の案件</h3>` +
    tasks.map((t) => `<div style="padding:8px 0;border-top:1px solid var(--color-border);">
      ${escapeHtml(t.subject)} ${allStagesDone(t) ? '<span style="color:var(--color-success);">✓ 全工程完了</span>' : ''}
    </div>`).join('');
}

/* ---------- 設定モーダル ---------- */

function openSettingsModal() {
  const cfg = state.config || {};
  document.getElementById('cfgOwner').value = cfg.owner || '';
  document.getElementById('cfgRepo').value = cfg.repo || '';
  document.getElementById('cfgBranch').value = cfg.branch || 'main';
  document.getElementById('cfgPath').value = cfg.path || 'data/tasks.json';
  document.getElementById('cfgToken').value = cfg.token || '';
  document.getElementById('settingsMessage').textContent = '';
  document.getElementById('modalSettings').hidden = false;
}
function closeSettingsModal() { document.getElementById('modalSettings').hidden = true; }

function readSettingsForm() {
  return {
    owner: document.getElementById('cfgOwner').value.trim(),
    repo: document.getElementById('cfgRepo').value.trim(),
    branch: document.getElementById('cfgBranch').value.trim() || 'main',
    path: document.getElementById('cfgPath').value.trim() || 'data/tasks.json',
    token: document.getElementById('cfgToken').value.trim(),
  };
}

async function handleSettingsSave() {
  const cfg = readSettingsForm();
  if (!cfg.owner || !cfg.repo || !cfg.token) {
    document.getElementById('settingsMessage').textContent = 'ユーザー名・リポジトリ名・トークンは必須です。';
    document.getElementById('settingsMessage').className = 'settings-message error';
    return;
  }
  state.config = cfg;
  saveConfig(cfg);
  document.getElementById('settingsMessage').textContent = '接続を確認しています…';
  document.getElementById('settingsMessage').className = 'settings-message';
  await loadFromGitHub();
  document.getElementById('settingsMessage').textContent = '設定を保存しました。';
  document.getElementById('settingsMessage').className = 'settings-message ok';
  renderSubjectDatalist();
  closeSettingsModal();
}

async function handleInitFile() {
  const cfg = readSettingsForm();
  if (!cfg.owner || !cfg.repo || !cfg.token) {
    document.getElementById('settingsMessage').textContent = 'ユーザー名・リポジトリ名・トークンを入力してから初期化してください。';
    document.getElementById('settingsMessage').className = 'settings-message error';
    return;
  }
  state.config = cfg;
  saveConfig(cfg);
  try {
    const existing = await githubGetFile(cfg);
    if (!existing.notFound) {
      document.getElementById('settingsMessage').textContent = 'tasks.jsonはすでに存在します。「保存して接続」を押してください。';
      document.getElementById('settingsMessage').className = 'settings-message error';
      return;
    }
    const newSha = await githubPutFile(cfg, { tasks: [], subjectFolders: {} }, 'initialize tasks.json', undefined);
    state.sha = newSha;
    state.tasks = [];
    state.subjectFolders = {};
    state.demoMode = false;
    document.getElementById('settingsMessage').textContent = 'tasks.jsonを作成しました。';
    document.getElementById('settingsMessage').className = 'settings-message ok';
    setSyncStatus('ok', '接続中: ' + cfg.repo);
    renderSubjectDatalist();
    render();
  } catch (err) {
    console.error(err);
    document.getElementById('settingsMessage').textContent = '初期化に失敗しました: ' + err.message;
    document.getElementById('settingsMessage').className = 'settings-message error';
  }
}

/* ---------- 全体描画 ---------- */

function render() {
  if (state.activeTab === 'list') renderList();
  else renderCalendar();
}

/* ---------- イベント登録 ---------- */

function bindEvents() {
  document.querySelectorAll('.tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      state.activeTab = tabBtn.dataset.tab;
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('tab--active'));
      tabBtn.classList.add('tab--active');
      document.getElementById('viewList').hidden = state.activeTab !== 'list';
      document.getElementById('viewCalendar').hidden = state.activeTab !== 'calendar';
      render();
    });
  });

  document.getElementById('btnAdd').addEventListener('click', addTask);

  document.getElementById('btnSettings').addEventListener('click', openSettingsModal);
  document.getElementById('btnSettingsCancel').addEventListener('click', closeSettingsModal);
  document.getElementById('btnSettingsSave').addEventListener('click', handleSettingsSave);
  document.getElementById('btnInitFile').addEventListener('click', handleInitFile);

  document.getElementById('btnReload').addEventListener('click', () => {
    if (state.demoMode || !state.config) {
      alert('GitHub未接続です。現在はサンプルデータを表示しています。設定画面から接続してください。');
      return;
    }
    loadFromGitHub();
  });

  document.getElementById('btnPrevMonth').addEventListener('click', () => {
    const m = state.calendarMonth;
    state.calendarMonth = new Date(m.getFullYear(), m.getMonth() - 1, 1);
    document.getElementById('calendarDayPanel').hidden = true;
    render();
  });
  document.getElementById('btnNextMonth').addEventListener('click', () => {
    const m = state.calendarMonth;
    state.calendarMonth = new Date(m.getFullYear(), m.getMonth() + 1, 1);
    document.getElementById('calendarDayPanel').hidden = true;
    render();
  });
}

/* ---------- 初期化 ---------- */

function init() {
  bindEvents();
  state.config = loadConfig();
  if (!state.config) {
    // GitHub未接続:サンプルデータで操作感を確認できるデモモードで起動
    state.demoMode = true;
    state.tasks = sampleTasks();
    setSyncStatus('demo', '未接続(サンプルデータ表示中)');
    renderSubjectDatalist();
    render();
  } else {
    loadFromGitHub();
  }
}

document.addEventListener('DOMContentLoaded', init);
