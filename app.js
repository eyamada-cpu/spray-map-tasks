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
];

// コンシェルジュ(散布日数に応じて1日目・2日目…と増えるチェック)と
// 実施主体・OPの判定(○/／/△)の選択肢
const JUDGE_OPTIONS = [
  { v: '', label: '－' },
  { v: 'circle', label: '○\uFE0E' },
  { v: 'slash', label: '／\uFE0E' },
  { v: 'triangle', label: '△\uFE0E' },
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
  subjectMaps: {},    // { 実施主体名: [ {id, name, path, size, uploadedAt} ] }
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
function allStagesDone(t) {
  const conciergeAllDone = Array.isArray(t.conciergeDone) && t.conciergeDone.length > 0 && t.conciergeDone.every(Boolean);
  return STAGES.every((s) => t[s.key]) && conciergeAllDone;
}

// 古いデータ(散布実施日が1つだけ・コンシェルジュが単純なチェック1つだった頃)
// との互換性を保ちつつ、以下を必ず揃える。
//   ・sprayDates: 散布実施日の配列(最大3日)
//   ・conciergeDone: 散布実施日の日数と同じ長さのチェック配列(コンシェルジュは
//     散布実施日の日数にそのまま連動するため、独立した日数は持たない)
//   ・subjectJudge / opJudge: 実施主体・OPの判定欄(未設定なら空文字)
function normalizeTask(t) {
  t.comments = t.comments || {};
  if (!Array.isArray(t.sprayDates)) {
    t.sprayDates = t.sprayDate ? [t.sprayDate] : [];
  }
  if (t.sprayDates.length === 0) t.sprayDates = [''];
  if (t.sprayDates.length > 3) t.sprayDates = t.sprayDates.slice(0, 3);
  if (!Array.isArray(t.conciergeDone)) {
    const legacy = !!t.concierge;
    t.conciergeDone = [legacy];
  }
  const n = t.sprayDates.length;
  const done = t.conciergeDone.slice(0, n);
  while (done.length < n) done.push(false);
  t.conciergeDone = done;
  if (typeof t.subjectJudge !== 'string') t.subjectJudge = '';
  if (typeof t.opJudge !== 'string') t.opJudge = '';
  return t;
}

// 「一番近い、まだ来ていない散布日」を並び替えの基準にする。
// 当日になったらその日は「まだ来ていない」に含めないので、
// 当日を迎えた時点で自動的に次の散布日を基準に並び替わる。
// 全て過ぎている場合は最後の散布日を基準にする(最後尾になる)。
function effectiveSortDate(dates) {
  const today = todayISO();
  const valid = (dates || []).filter(Boolean);
  if (valid.length === 0) return '9999-12-31';
  const upcoming = valid.filter((d) => d > today).sort();
  if (upcoming.length > 0) return upcoming[0];
  return valid.slice().sort().pop();
}

// 最後の散布日(=一番遅い日付)を迎えたら(当日を含む)グレーアウトする。
function isAllDatesReached(dates) {
  const today = todayISO();
  const valid = (dates || []).filter(Boolean);
  if (valid.length === 0) return false;
  return valid.every((d) => d <= today);
}

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
    { id: 't1', subject: 'スカイテック北関東', sprayDates: [addDaysISO(3)],
      orderData: true, mapDraft: true, correctionReq: false, mapConfirmed: false, duplicate: false,
      conciergeDone: [false], subjectJudge: 'circle', opJudge: '',
      comments: { mapDraft: '地図の仮完了まで進みました。' } },
    { id: 't2', subject: 'グリーンウィング栃木', sprayDates: [addDaysISO(0), addDaysISO(1)],
      orderData: true, mapDraft: true, correctionReq: true, mapConfirmed: true, duplicate: true,
      conciergeDone: [true, false], subjectJudge: 'triangle', opJudge: 'circle',
      comments: { duplicate: '重複エリアの確認完了。コンシェルジュ対応待ちです。' } },
    { id: 't3', subject: '北関東エアサービス', sprayDates: [addDaysISO(-2)],
      orderData: false, mapDraft: false, correctionReq: false, mapConfirmed: false, duplicate: false,
      conciergeDone: [false], subjectJudge: '', opJudge: '',
      comments: {} },
    { id: 't4', subject: 'スカイテック北関東', sprayDates: [addDaysISO(-9), addDaysISO(-8), addDaysISO(10)],
      orderData: true, mapDraft: true, correctionReq: true, mapConfirmed: true, duplicate: true,
      conciergeDone: [true, true, false], subjectJudge: 'circle', opJudge: 'circle',
      comments: { duplicate: '全工程完了しました。' } },
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

/* ---------- Git Data API(地図データのアップロード用) ---------- */
// tasks.jsonの読み書きは単純なContents APIで十分だが、画像ファイルは
// 1MBを超えることがあり、Contents APIでは不安定になりやすい。
// そのためGit Data API(blob/tree/commit)を直接使い、複数ファイル+
// tasks.jsonの更新を1つのコミットにまとめて反映する。

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('ファイルの読み込みに失敗しました'));
    reader.readAsDataURL(file);
  });
}

function sanitizeFileName(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
}

async function createBlob(cfg, base64Content) {
  const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/git/blobs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: base64Content, encoding: 'base64' }),
  });
  if (!res.ok) throw new Error(`blob作成エラー (${res.status}): ${await res.text()}`);
  return (await res.json()).sha;
}

async function getBranchRefSha(cfg) {
  const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/git/ref/heads/${encodeURIComponent(cfg.branch)}`, {
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`ref取得エラー (${res.status}): ${await res.text()}`);
  return (await res.json()).object.sha;
}

async function getCommitTreeSha(cfg, commitSha) {
  const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/git/commits/${commitSha}`, {
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`commit取得エラー (${res.status}): ${await res.text()}`);
  return (await res.json()).tree.sha;
}

async function createTree(cfg, baseTreeSha, entries) {
  const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/git/trees`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_tree: baseTreeSha, tree: entries }),
  });
  if (!res.ok) throw new Error(`tree作成エラー (${res.status}): ${await res.text()}`);
  return (await res.json()).sha;
}

async function createCommitObj(cfg, message, treeSha, parentSha) {
  const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/git/commits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }),
  });
  if (!res.ok) throw new Error(`commit作成エラー (${res.status}): ${await res.text()}`);
  return (await res.json()).sha;
}

async function updateBranchRef(cfg, commitSha) {
  const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/git/refs/heads/${encodeURIComponent(cfg.branch)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: commitSha, force: false }),
  });
  if (!res.ok) throw new Error(`ref更新エラー (${res.status}): ${await res.text()}`);
  return true;
}

// 複数の地図ファイルをアップロードし、tasks.jsonのsubjectMaps更新も
// 同じコミットにまとめて反映する。他の人の保存と競合したら最新状態を
// 取り直して自動的に数回まで再試行する。
async function uploadMapFiles(subject, files) {
  if (!state.config) {
    alert('GitHub未接続です。設定画面から接続してください。');
    return false;
  }
  if (!files || files.length === 0) return false;
  setSyncStatus('loading', 'アップロード中…');
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const blobEntries = [];
      for (const f of files) {
        const base64 = await fileToBase64(f);
        const blobSha = await createBlob(state.config, base64);
        const id = uid();
        const safeName = sanitizeFileName(f.name);
        const path = `maps/${id}-${safeName}`;
        blobEntries.push({
          path, mode: '100644', type: 'blob', sha: blobSha,
          meta: { id, name: f.name, path, size: f.size, uploadedAt: new Date().toISOString() },
        });
      }

      const latestFile = await githubGetFile(state.config);
      const branchSha = await getBranchRefSha(state.config);
      const baseTreeSha = await getCommitTreeSha(state.config, branchSha);

      const nextTasks = latestFile.notFound ? state.tasks : (latestFile.data.tasks || []);
      const nextSubjectFolders = latestFile.notFound ? state.subjectFolders : (latestFile.data.subjectFolders || {});
      const nextSubjectMaps = latestFile.notFound ? { ...state.subjectMaps } : { ...(latestFile.data.subjectMaps || {}) };
      const list = (nextSubjectMaps[subject] || []).slice();
      blobEntries.forEach((e) => list.push(e.meta));
      nextSubjectMaps[subject] = list;

      const tasksJsonContent = JSON.stringify({ tasks: nextTasks, subjectFolders: nextSubjectFolders, subjectMaps: nextSubjectMaps }, null, 2);
      const tasksBlobSha = await createBlob(state.config, utf8ToB64(tasksJsonContent));

      const treeEntries = blobEntries.map((e) => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha }));
      treeEntries.push({ path: state.config.path, mode: '100644', type: 'blob', sha: tasksBlobSha });

      const newTreeSha = await createTree(state.config, baseTreeSha, treeEntries);
      const newCommitSha = await createCommitObj(state.config, `upload ${blobEntries.length} map file(s): ${subject}`, newTreeSha, branchSha);
      await updateBranchRef(state.config, newCommitSha);

      state.tasks = nextTasks;
      state.subjectFolders = nextSubjectFolders;
      state.subjectMaps = nextSubjectMaps;
      setSyncStatus('ok', '接続中: ' + state.config.repo);
      return true;
    } catch (err) {
      const isConflict = /\(409\)|\(422\)/.test(err.message);
      if (isConflict && attempt < MAX_ATTEMPTS) {
        console.warn(`アップロードが競合したため再試行します (${attempt}/${MAX_ATTEMPTS})`, err);
        setSyncStatus('loading', '競合を解消して再試行中…');
        await new Promise((resolve) => setTimeout(resolve, 150 * attempt + Math.random() * 200));
        continue;
      }
      console.error(err);
      setSyncStatus('error', 'アップロード失敗');
      alert('アップロードに失敗しました。\n' + err.message);
      return false;
    }
  }
  return false;
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
    state.tasks.forEach((t) => normalizeTask(t));
    state.subjectFolders = (result.data && result.data.subjectFolders) || {};
    state.subjectMaps = (result.data && result.data.subjectMaps) || {};
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
      const newSha = await githubPutFile(state.config, { tasks: state.tasks, subjectFolders: state.subjectFolders, subjectMaps: state.subjectMaps }, message, sha);
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

// 追加フォームの「散布日数」プルダウンに合わせて、その数だけ日付欄を出す
function renderAddDateInputs() {
  const n = Number(document.getElementById('inpDaysSelect').value);
  const wrap = document.getElementById('inpDatesWrap');
  wrap.innerHTML = Array.from({ length: n }, (_, i) => `
    <label>${i + 1}日目の散布日
      <input type="date" class="inp-date-day" data-day="${i}">
    </label>
  `).join('');
}

async function addTask() {
  const subject = document.getElementById('inpSubject').value.trim();
  const dateInputs = Array.from(document.querySelectorAll('.inp-date-day'));
  const sprayDates = dateInputs.map((inp) => inp.value).filter(Boolean);
  if (!subject || sprayDates.length === 0) {
    alert('エリアと散布実施日は必須です。');
    return;
  }
  const task = {
    id: uid(), subject, sprayDates, comments: {},
    conciergeDone: sprayDates.map(() => false),
    subjectJudge: '', opJudge: '',
  };
  STAGES.forEach((s) => { task[s.key] = false; });
  state.tasks.push(task);
  document.getElementById('inpSubject').value = '';
  document.getElementById('inpDaysSelect').value = '1';
  renderAddDateInputs();
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

// 散布実施日の日数プルダウンを変更したとき
// (コンシェルジュのチェック数はこの日数にそのまま連動する)
async function changeSprayDatesCount(taskId, n) {
  const t = findTask(taskId);
  if (!t) return;
  const previousDates = t.sprayDates.slice();
  const previousDone = t.conciergeDone.slice();
  const dates = t.sprayDates.slice(0, n);
  while (dates.length < n) dates.push('');
  t.sprayDates = dates;
  normalizeTask(t); // conciergeDoneを新しい日数に合わせて揃える
  const ok = await saveToGitHub(`spray dates count: ${t.subject}`);
  if (!ok) { t.sprayDates = previousDates; t.conciergeDone = previousDone; }
  render();
}

// 散布実施日の「n日目」の日付を変更したとき
async function setSprayDate(taskId, dayIndex, value) {
  const t = findTask(taskId);
  if (!t) return;
  const previous = t.sprayDates[dayIndex];
  t.sprayDates[dayIndex] = value;
  const ok = await saveToGitHub(`spray date ${dayIndex + 1}: ${t.subject}`);
  if (!ok) t.sprayDates[dayIndex] = previous;
  render();
}

// コンシェルジュの「n日目」チェックをON/OFF
async function toggleConciergeDay(taskId, dayIndex) {
  const t = findTask(taskId);
  if (!t) return;
  t.conciergeDone[dayIndex] = !t.conciergeDone[dayIndex];
  const ok = await saveToGitHub(`concierge day ${dayIndex + 1}: ${t.subject}`);
  if (!ok) t.conciergeDone[dayIndex] = !t.conciergeDone[dayIndex];
  render();
}

// 実施主体・OPの判定(○/／/△)を変更したとき
async function setJudge(taskId, field, value) {
  const t = findTask(taskId);
  if (!t) return;
  const previous = t[field];
  t[field] = value;
  const ok = await saveToGitHub(`${field}: ${t.subject}`);
  if (!ok) t[field] = previous;
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

// コンシェルジュ: チェックの数は散布実施日の日数にそのまま連動する
// (コンシェルジュ側には独立した日数プルダウンは持たない)
function conciergeCellHtml(t) {
  const checks = t.conciergeDone.map((done, i) => `
    <div class="concierge-day">
      <div class="stage-box ${done ? 'on' : ''}" data-task="${t.id}" data-day="${i}">${done ? '✓' : ''}</div>
      <span>${i + 1}日目</span>
    </div>
  `).join('');
  return `<td class="divider-after"><div class="concierge-days">${checks}</div></td>`;
}

// 散布実施日: 日数プルダウン(最大3日)+その数だけの日付欄。
// あとから日数・日付とも変更できる。
function sprayDatesCellHtml(t) {
  const dayOptions = [1, 2, 3].map((n) =>
    `<option value="${n}" ${t.sprayDates.length === n ? 'selected' : ''}>${n}日</option>`
  ).join('');
  const today = todayISO();
  const rows = t.sprayDates.map((d, i) => {
    const isPast = !!d && d < today;
    return `
      <div class="spray-date-row ${isPast ? 'is-past' : ''}">
        <span>${i + 1}日目</span>
        <input type="date" data-task="${t.id}" data-day="${i}" value="${d || ''}">
      </div>
    `;
  }).join('');
  return `
    <td>
      <select class="spray-dates-select" data-task="${t.id}">${dayOptions}</select>
      <div class="spray-dates-list">${rows}</div>
    </td>
  `;
}

// 実施主体・OP: ○/／/△をプルダウンで選ぶ判定欄
function judgeSelectHtml(taskId, field, value) {
  const v = value || '';
  return `
    <select class="judge-select" data-task="${escapeHtml(taskId)}" data-field="${field}">
      ${JUDGE_OPTIONS.map((o) => `<option value="${o.v}" ${v === o.v ? 'selected' : ''}>${o.label}</option>`).join('')}
    </select>
  `;
}

function renderList() {
  const container = document.getElementById('listContainer');
  if (state.tasks.length === 0) {
    container.innerHTML = '<p style="padding:20px;color:var(--color-muted);">案件がありません。上のフォームから登録してください。</p>';
    return;
  }
  state.tasks.forEach((t) => normalizeTask(t));
  // 同じ日付どうしはエリア名のあいうえお順で並べる
  const sorted = state.tasks.slice().sort((a, b) => {
    const dateCompare = effectiveSortDate(a.sprayDates).localeCompare(effectiveSortDate(b.sprayDates));
    if (dateCompare !== 0) return dateCompare;
    return (a.subject || '').localeCompare(b.subject || '', 'ja');
  });

  const groupRowCells = STAGE_GROUPS.map((g) =>
    `<th colspan="${g.count}" class="group-${g.key}">${escapeHtml(g.label)}</th>`
  ).join('');
  // 最終確認グループには、重複処理(STAGESの通常チェック)に続けて
  // コンシェルジュ(散布実施日の日数に連動したチェック)の見出しを手動で追加する。
  const labelRowCells = STAGES.map((s) =>
    `<th class="group-${s.group} ${s.dividerAfter ? 'divider-after' : ''}">${escapeHtml(s.label)}</th>`
  ).join('') + `<th class="group-final divider-after">コンシェルジュ</th>`;

  const rows = sorted.map((t) => {
    const overdue = isAllDatesReached(t.sprayDates);
    return `
      <tr class="${overdue ? 'row-overdue' : ''}">
        <td class="col-subject">
          <button class="subject-pill subject-pill-btn" data-subject="${escapeHtml(t.subject)}" title="地図データを見る・アップロードする">${escapeHtml(t.subject)}${mapCountBadgeHtml(t.subject)}</button>${urgentBadgeHtml(t)}
        </td>
        ${STAGES.map((s) => stageCellHtml(t, s)).join('')}
        ${conciergeCellHtml(t)}
        <td>${judgeSelectHtml(t.id, 'subjectJudge', t.subjectJudge)}</td>
        <td>${judgeSelectHtml(t.id, 'opJudge', t.opJudge)}</td>
        ${sprayDatesCellHtml(t)}
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
          <th rowspan="2" class="col-subject">エリア</th>
          ${groupRowCells}
          <th colspan="2" class="group-assign">担当区割当</th>
          <th rowspan="2">散布実施日</th>
          <th rowspan="2"></th>
        </tr>
        <tr class="label-row">
          ${labelRowCells}
          <th class="group-assign">実施主体</th>
          <th class="group-assign">OP</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  container.querySelectorAll('.stage-cellwrap .stage-box').forEach((box) => {
    box.addEventListener('click', () => toggleStage(box.dataset.task, box.dataset.stage));
    box.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      editStageComment(box.dataset.task, box.dataset.stage);
    });
  });

  container.querySelectorAll('.concierge-days .stage-box').forEach((box) => {
    box.addEventListener('click', () => toggleConciergeDay(box.dataset.task, Number(box.dataset.day)));
  });
  container.querySelectorAll('.spray-dates-select').forEach((sel) => {
    sel.addEventListener('change', () => changeSprayDatesCount(sel.dataset.task, Number(sel.value)));
  });
  container.querySelectorAll('.spray-date-row input[type="date"]').forEach((inp) => {
    inp.addEventListener('change', () => setSprayDate(inp.dataset.task, Number(inp.dataset.day), inp.value));
  });
  container.querySelectorAll('.judge-select').forEach((sel) => {
    sel.addEventListener('change', () => setJudge(sel.dataset.task, sel.dataset.field, sel.value));
  });

  container.querySelectorAll('.subject-pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => openMapPreviewModal(btn.dataset.subject));
  });

  container.querySelectorAll('.btn-delete-task').forEach((btn) => {
    btn.addEventListener('click', () => deleteTaskConfirm(btn.dataset.task));
  });
}

/* ---------- 地図データのプレビュー・アップロード・印刷 ---------- */

function mapCountBadgeHtml(subject) {
  const count = (state.subjectMaps[subject] || []).length;
  if (count === 0) return '';
  return ` <span class="map-count-badge">📷${count}</span>`;
}

// 一番近い散布日の3日前(当日含む)から、エリア名の横に赤字で残り日数を表示する
function urgentBadgeHtml(t) {
  const effDate = effectiveSortDate(t.sprayDates);
  if (effDate === '9999-12-31') return '';
  const d = daysUntil(effDate);
  if (d === null || d < 0 || d > 3) return '';
  return ` <span class="urgent-badge">残り${d}日</span>`;
}

let mapPreviewEditingSubject = null;

function openMapPreviewModal(subject) {
  mapPreviewEditingSubject = subject;
  document.getElementById('mapPreviewTitle').textContent = `「${subject}」の地図データ`;
  document.getElementById('mapUploadStatus').textContent = '';
  document.getElementById('mapUploadStatus').className = 'settings-message';
  renderMapPreviewGrid(subject);
  document.getElementById('modalMapPreview').hidden = false;
}

function closeMapPreviewModal() {
  document.getElementById('modalMapPreview').hidden = true;
  mapPreviewEditingSubject = null;
}

function mapPreviewItemHtml(subject, item) {
  const isPdf = /\.pdf$/i.test(item.name || '');
  const absoluteUrl = new URL(item.path, window.location.href).href;
  const thumb = isPdf
    ? `<div class="map-thumb map-thumb--pdf">PDF</div>`
    : `<img class="map-thumb" src="${escapeHtml(item.path)}" alt="${escapeHtml(item.name)}" loading="lazy">`;
  const uploadedLabel = item.uploadedAt ? formatDateISO(new Date(item.uploadedAt)) : '';
  return `
    <div class="map-preview-item" data-id="${escapeHtml(item.id)}">
      <a class="map-preview-link" href="${escapeHtml(absoluteUrl)}" target="_blank" rel="noopener" title="プレビュー">
        ${thumb}
      </a>
      <div class="map-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
      ${uploadedLabel ? `<div class="map-item-date">📅 ${escapeHtml(uploadedLabel)}</div>` : ''}
      <div class="map-item-actions">
        <a class="btn-map-save" href="${escapeHtml(absoluteUrl)}" download="${escapeHtml(item.name)}" title="このデータを保存">💾 保存</a>
        <button class="btn-map-delete" data-subject="${escapeHtml(subject)}" data-id="${escapeHtml(item.id)}" title="削除">削除</button>
      </div>
    </div>
  `;
}

function renderMapPreviewGrid(subject) {
  const grid = document.getElementById('mapPreviewGrid');
  const list = state.subjectMaps[subject] || [];
  if (list.length === 0) {
    grid.innerHTML = '<p style="color:var(--color-muted);padding:12px 0;">まだ地図データがありません。上の「＋ 地図データを追加」からアップロードしてください。</p>';
    return;
  }
  grid.innerHTML = list.map((item) => mapPreviewItemHtml(subject, item)).join('');
  grid.querySelectorAll('.btn-map-delete').forEach((btn) => {
    btn.addEventListener('click', () => deleteMapFile(btn.dataset.subject, btn.dataset.id));
  });
}

async function handleMapUploadChange(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length === 0) return;
  const subject = mapPreviewEditingSubject;
  if (!subject) return;
  const statusEl = document.getElementById('mapUploadStatus');
  statusEl.textContent = `アップロード中… (${files.length}件)`;
  statusEl.className = 'settings-message';
  const ok = await uploadMapFiles(subject, files);
  if (ok) {
    statusEl.textContent = `✅ ${files.length}件アップロードしました。`;
    statusEl.className = 'settings-message ok';
  } else {
    statusEl.textContent = '';
  }
  renderMapPreviewGrid(subject);
  render();
}

async function deleteMapFile(subject, id) {
  const list = state.subjectMaps[subject] || [];
  const idx = list.findIndex((m) => m.id === id);
  if (idx === -1) return;
  const ok = window.confirm('この地図データを一覧から削除しますか?');
  if (!ok) return;
  const previous = list.slice();
  const nextList = list.slice();
  nextList.splice(idx, 1);
  state.subjectMaps[subject] = nextList;
  const saved = await saveToGitHub(`delete map file: ${subject}`);
  if (!saved) state.subjectMaps[subject] = previous;
  renderMapPreviewGrid(subject);
  render();
}


// 実施主体の最後のタスクを削除するとき、その実施主体にアップロード済みの
// 地図データが残っていたら、タスクの削除と同時にリポジトリからも削除する。
// (地図データだけがGitHub上に残り続けてしまう「ゴミ」を防ぐため)
async function deleteTaskWithMapCleanup(subject, taskId, pathsToRemove) {
  setSyncStatus('loading', '削除中…');
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const latestFile = await githubGetFile(state.config);
      const branchSha = await getBranchRefSha(state.config);
      const baseTreeSha = await getCommitTreeSha(state.config, branchSha);

      const serverTasks = latestFile.notFound ? [] : (latestFile.data.tasks || []);
      const serverSubjectFolders = latestFile.notFound ? {} : (latestFile.data.subjectFolders || {});
      const serverSubjectMaps = latestFile.notFound ? {} : (latestFile.data.subjectMaps || {});

      const nextTasks = serverTasks.filter((x) => x.id !== taskId);
      const nextSubjectMaps = { ...serverSubjectMaps };
      delete nextSubjectMaps[subject];

      const tasksJsonContent = JSON.stringify({ tasks: nextTasks, subjectFolders: serverSubjectFolders, subjectMaps: nextSubjectMaps }, null, 2);
      const tasksBlobSha = await createBlob(state.config, utf8ToB64(tasksJsonContent));

      const treeEntries = pathsToRemove.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null }));
      treeEntries.push({ path: state.config.path, mode: '100644', type: 'blob', sha: tasksBlobSha });

      const newTreeSha = await createTree(state.config, baseTreeSha, treeEntries);
      const newCommitSha = await createCommitObj(state.config, `delete task and map files: ${subject}`, newTreeSha, branchSha);
      await updateBranchRef(state.config, newCommitSha);

      state.tasks = nextTasks;
      state.subjectFolders = serverSubjectFolders;
      state.subjectMaps = nextSubjectMaps;
      setSyncStatus('ok', '接続中: ' + state.config.repo);
      return true;
    } catch (err) {
      const isConflict = /\(409\)|\(422\)/.test(err.message);
      if (isConflict && attempt < MAX_ATTEMPTS) {
        console.warn(`削除が競合したため再試行します (${attempt}/${MAX_ATTEMPTS})`, err);
        setSyncStatus('loading', '競合を解消して再試行中…');
        await new Promise((resolve) => setTimeout(resolve, 150 * attempt + Math.random() * 200));
        continue;
      }
      console.error(err);
      setSyncStatus('error', '削除失敗');
      alert('削除に失敗しました。\n' + err.message);
      return false;
    }
  }
  return false;
}

async function deleteTaskConfirm(taskId) {
  const t = findTask(taskId);
  if (!t) return;
  const ok = window.confirm(`「${t.subject}」のタスクを削除します。よろしいですか?`);
  if (!ok) return;

  const subject = t.subject;
  const index = state.tasks.indexOf(t);
  const mapFiles = state.subjectMaps[subject] || [];
  const remainingForSubject = state.tasks.filter((x) => x.id !== taskId && x.subject === subject);
  // この実施主体の最後のタスクで、かつ地図データが残っている場合だけ、
  // タスク削除とあわせて地図データもリポジトリから消す。
  const shouldCleanupMaps = !state.demoMode && !!state.config && remainingForSubject.length === 0 && mapFiles.length > 0;

  state.tasks = state.tasks.filter((x) => x.id !== taskId);

  let saved;
  if (shouldCleanupMaps) {
    saved = await deleteTaskWithMapCleanup(subject, taskId, mapFiles.map((m) => m.path));
  } else {
    if (remainingForSubject.length === 0) delete state.subjectMaps[subject];
    saved = await saveToGitHub(`delete task: ${subject}`);
  }
  if (!saved) {
    state.tasks.splice(index, 0, t); // 保存に失敗したら元に戻す
    if (shouldCleanupMaps) state.subjectMaps[subject] = mapFiles;
  }
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
    normalizeTask(t);
    for (const ds of t.sprayDates) {
      if (!ds) continue;
      (tasksByDate[ds] = tasksByDate[ds] || []).push(t);
    }
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
  const tasks = state.tasks.filter((t) => (t.sprayDates || []).includes(dateStr));
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
    const newSha = await githubPutFile(cfg, { tasks: [], subjectFolders: {}, subjectMaps: {} }, 'initialize tasks.json', undefined);
    state.sha = newSha;
    state.tasks = [];
    state.subjectFolders = {};
    state.subjectMaps = {};
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
  document.getElementById('inpDaysSelect').addEventListener('change', renderAddDateInputs);
  renderAddDateInputs();

  document.getElementById('btnSettings').addEventListener('click', openSettingsModal);
  document.getElementById('btnSettingsCancel').addEventListener('click', closeSettingsModal);
  document.getElementById('btnSettingsSave').addEventListener('click', handleSettingsSave);
  document.getElementById('btnInitFile').addEventListener('click', handleInitFile);


  document.getElementById('btnMapPreviewClose').addEventListener('click', closeMapPreviewModal);
  document.getElementById('mapUploadInput').addEventListener('change', handleMapUploadChange);

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
