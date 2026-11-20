'use strict';
/* Wunderlost — Wunderlist-style client. Vanilla JS, no build step. */

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get: (k, d) => { try { const v = localStorage.getItem('wl_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('wl_' + k, JSON.stringify(v)); } catch {} },
};

// Scene backgrounds behind the task list. Values are CSS backgrounds.
const BACKGROUNDS = [
  { name: 'Deep sea', css: 'linear-gradient(160deg, #1e3c72 0%, #2a5298 45%, #0f2027 100%)' },
  { name: 'Aurora', css: 'radial-gradient(120% 80% at 20% 10%, #1fa58f 0%, transparent 55%), radial-gradient(90% 70% at 85% 30%, #6a3fb5 0%, transparent 60%), linear-gradient(180deg, #0b1e2d, #0a1420)' },
  { name: 'Ember', css: 'radial-gradient(110% 80% at 80% 0%, #f2994a 0%, transparent 55%), linear-gradient(165deg, #8e2e4a 0%, #3b1a3f 60%, #1b1028 100%)' },
  { name: 'Pine', css: 'linear-gradient(170deg, #2f6a4f 0%, #1d4636 50%, #0e231c 100%)' },
  { name: 'Dusk', css: 'linear-gradient(175deg, #ffb07c 0%, #c86b98 35%, #4b3b8f 70%, #1d1f4a 100%)' },
  { name: 'Slate', css: 'linear-gradient(160deg, #3c4a5e 0%, #232c3b 100%)' },
  { name: 'Walnut', css: 'linear-gradient(160deg, #8a5a3b 0%, #5a3622 55%, #2e1c12 100%)' },
  { name: 'Graphite', css: 'linear-gradient(160deg, #2a2f38 0%, #16191f 100%)' },
];
const ic = (name, cls = '') => `<svg class="ico ${cls}" aria-hidden="true"><use href="/icons.svg#${name}"/></svg>`;
const REPEAT_LABEL = { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly', yearly: 'Yearly' };
const SMART = {
  assigned: { name: 'Assigned to me', ico: 'user' },
  starred: { name: 'Starred', ico: 'star' },
  today: { name: 'Today', ico: 'calendar-check' },
  week: { name: 'Week', ico: 'calendar-days' },
  search: { name: 'Search', ico: 'search' },
};

const S = {
  me: null, lists: [], smart: {}, view: null, tasks: [], today: '', selected: null,
  addStar: false, searchQ: '', loadSeq: 0,
};

// ---------------- API ----------------
async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
  const res = await fetch('/api' + url, opts);
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401 && !url.startsWith('/auth')) { showAuth(); throw new Error('Not logged in'); }
  if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
  return data;
}

function toast(msg, action, fn) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button>${esc(action)}</button>` : '');
  t.classList.remove('hidden');
  if (action) t.querySelector('button').onclick = () => { t.classList.add('hidden'); fn(); };
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), action ? 6000 : 3000);
}
const fail = (e) => toast(e.message || String(e));

// ---------------- dates ----------------
const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
function localToday() { return dateStr(new Date()); }
function dueLabel(due) {
  const t = parseDate(localToday()), d = parseDate(due);
  const diff = Math.round((d - t) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() !== t.getFullYear() ? 'numeric' : undefined });
}
function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${dateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------- sound ----------------
let audioCtx;
function ding() {
  if (!ls.get('sound', true)) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    [880, 1318.5].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.18, now + i * 0.09 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.45);
      o.connect(g).connect(audioCtx.destination);
      o.start(now + i * 0.09); o.stop(now + i * 0.09 + 0.5);
    });
  } catch {}
}

// ---------------- auth ----------------
let authMode = 'login';
async function boot() {
  applyTheme();
  applyBackground();
  let st;
  try { st = await api('GET', '/auth/status'); } catch (e) { $('#auth-err').textContent = e.message; showAuthForm('login', {}); return; }
  if (st.user) { S.me = st.user; startApp(); } else showAuthForm(st.setupNeeded ? 'setup' : 'login', st);
}
function showAuth() { $('#app').classList.add('hidden'); api('GET', '/auth/status').then((st) => showAuthForm('login', st)).catch(() => showAuthForm('login', {})); }
function showAuthForm(mode, st) {
  authMode = mode;
  $('#auth').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#auth-err').textContent = '';
  const sub = $('#auth-sub'), btn = $('#auth-btn'), tog = $('#auth-toggle');
  $('#auth-pass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  if (mode === 'setup') { sub.textContent = 'First run — create the admin account.'; btn.textContent = 'Create admin account'; tog.classList.add('hidden'); }
  else if (mode === 'register') { sub.textContent = 'Create an account.'; btn.textContent = 'Sign up'; tog.textContent = 'Have an account? Sign in'; tog.classList.remove('hidden'); }
  else { sub.textContent = ''; btn.textContent = 'Sign in'; tog.textContent = 'Create an account'; tog.classList.toggle('hidden', !st.registrationOpen); }
  $('#auth-user').focus();
}
$('#auth-toggle').onclick = () => showAuthForm(authMode === 'login' ? 'register' : 'login', { registrationOpen: true });
$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  $('#auth-err').textContent = '';
  try {
    const body = { username: $('#auth-user').value, password: $('#auth-pass').value };
    await api('POST', authMode === 'login' ? '/auth/login' : '/auth/register', body);
    const st = await api('GET', '/auth/status');
    S.me = st.user; $('#auth-pass').value = '';
    startApp();
  } catch (err) { $('#auth-err').textContent = err.message; }
};

// ---------------- app start ----------------
async function startApp() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#user-name').textContent = S.me.username;
  $('#avatar').textContent = S.me.username[0];
  await loadLists();
  const route = parseHash();
  if (route?.task) { openTaskFromLink(route.task); }
  else if (route) setView(route, false);
  else setView(ls.get('lastView', { type: 'list', id: inbox()?.id }), false);
  connectEvents();
  registerSW();
}
const inbox = () => S.lists.find((l) => l.is_inbox);
const listById = (id) => S.lists.find((l) => l.id === Number(id));

function parseHash() {
  const m = location.hash.match(/^#(list|smart|task)\/(\w+)/);
  if (!m) return null;
  if (m[1] === 'task') return { task: Number(m[2]) };
  return m[1] === 'list' ? { type: 'list', id: Number(m[2]) } : { type: 'smart', id: m[2] };
}
window.addEventListener('hashchange', () => {
  const r = parseHash();
  if (r?.task) openTaskFromLink(r.task);
  else if (r && (r.type !== S.view?.type || r.id !== S.view?.id)) setView(r, false);
});
async function openTaskFromLink(id) {
  try {
    const t = await api('GET', `/tasks/${id}`);
    await setView({ type: 'list', id: t.list_id });
    openDetail(t.id);
  } catch { setView({ type: 'list', id: inbox()?.id }); }
}

// ---------------- sidebar ----------------
async function loadLists() {
  const d = await api('GET', '/lists');
  S.lists = d.lists; S.smart = d.smart || {};
  renderSidebar();
}
function listButton({ key, ico, name, count, active, shared, attrs = '' }) {
  return `<button class="list-item${active ? ' active' : ''}" data-key="${esc(key)}" ${attrs}>
    <span class="li-ico">${ic(ico)}</span><span class="li-name">${esc(name)}</span>
    ${shared ? `<span class="li-shared" title="Shared">${ic('users')}</span>` : ''}
    ${count ? `<span class="li-count">${count}</span>` : ''}</button>`;
}
function renderSidebar() {
  const v = S.view || {};
  const ib = inbox();
  const anyShared = S.lists.some((l) => l.members.length > 1);
  let smart = ib ? listButton({ key: `list:${ib.id}`, ico: 'inbox', name: 'Inbox', count: ib.open_count, active: v.type === 'list' && v.id === ib.id, attrs: `data-drop="${ib.id}"` }) : '';
  for (const k of ['assigned', 'starred', 'today', 'week']) {
    if (k === 'assigned' && !anyShared && !S.smart.assigned) continue;
    smart += listButton({ key: `smart:${k}`, ico: SMART[k].ico, name: SMART[k].name, count: S.smart[k] || 0, active: v.type === 'smart' && v.id === k });
  }
  $('#smart-lists').innerHTML = smart;
  $('#user-lists').innerHTML = S.lists.filter((l) => !l.is_inbox).map((l) => listButton({
    key: `list:${l.id}`, ico: 'list', name: l.name, count: l.open_count, shared: l.members.length > 1,
    active: v.type === 'list' && v.id === l.id, attrs: `draggable="true" data-drop="${l.id}" data-lid="${l.id}"`,
  })).join('');
  document.title = (S.smart.today ? `(${S.smart.today}) ` : '') + 'Wunderlost';
}
function onListClick(e) {
  const b = e.target.closest('.list-item');
  if (!b) return;
  const [type, id] = b.dataset.key.split(':');
  setView({ type, id: type === 'list' ? Number(id) : id });
}
$('#smart-lists').onclick = onListClick;
$('#user-lists').onclick = onListClick;

// list drag-reorder + drop tasks onto lists
let dragList = null;
$('#user-lists').addEventListener('dragstart', (e) => {
  const b = e.target.closest('[data-lid]');
  if (!b) return;
  dragList = Number(b.dataset.lid);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', 'list');
});
for (const nav of [$('#smart-lists'), $('#user-lists')]) {
  nav.addEventListener('dragover', (e) => {
    const b = e.target.closest('.list-item');
    if (!b) return;
    if (dragTask && b.dataset.drop) { e.preventDefault(); clearDragMarks(); b.classList.add('drop-target'); }
    else if (dragList && b.dataset.lid) { e.preventDefault(); clearDragMarks(); b.classList.add('drag-over'); }
  });
  nav.addEventListener('drop', async (e) => {
    const b = e.target.closest('.list-item');
    clearDragMarks();
    if (!b) return;
    e.preventDefault();
    if (dragTask && b.dataset.drop) {
      const id = dragTask; dragTask = null;
      try { await api('PUT', `/tasks/${id}`, { list_id: Number(b.dataset.drop) }); toast(`Moved to ${listById(b.dataset.drop)?.name}`); refresh(); } catch (err) { fail(err); }
    } else if (dragList && b.dataset.lid) {
      const ids = S.lists.filter((l) => !l.is_inbox).map((l) => l.id).filter((id) => id !== dragList);
      ids.splice(ids.indexOf(Number(b.dataset.lid)), 0, dragList);
      dragList = null;
      S.lists.sort((a, b2) => (a.is_inbox ? -1 : b2.is_inbox ? 1 : ids.indexOf(a.id) - ids.indexOf(b2.id)));
      renderSidebar();
      api('PUT', '/lists/order', { ids }).catch(fail);
    }
  });
}
document.addEventListener('dragend', () => { dragList = null; dragTask = null; clearDragMarks(); document.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging')); });
function clearDragMarks() { document.querySelectorAll('.drag-over,.drop-target').forEach((n) => n.classList.remove('drag-over', 'drop-target')); }

$('#create-list').onclick = () => promptModal('New list', '', 'Create', async (name) => {
  const { id } = await api('POST', '/lists', { name });
  await loadLists(); setView({ type: 'list', id });
});

// search
$('#search-btn').onclick = () => {
  const w = $('#search-wrap');
  w.classList.toggle('hidden');
  if (!w.classList.contains('hidden')) $('#search').focus();
  else if (S.view?.type === 'smart' && S.view.id === 'search') setView(ls.get('lastView', { type: 'list', id: inbox()?.id }));
};
let searchT;
$('#search').oninput = (e) => {
  clearTimeout(searchT);
  searchT = setTimeout(() => {
    S.searchQ = e.target.value.trim();
    if (S.searchQ) setView({ type: 'smart', id: 'search' }, false);
  }, 250);
};

// mobile drawer
const closeSide = () => $('#app').classList.remove('side-open');
$('#menu-btn').onclick = () => $('#app').classList.add('side-open');
$('#scrim').onclick = closeSide;

// ---------------- views & tasks ----------------
async function setView(view) {
  if (view.type === 'list' && !listById(view.id)) view = { type: 'list', id: inbox()?.id };
  S.view = view;
  if (view.id !== 'search') ls.set('lastView', view);
  history.replaceState(null, '', `#${view.type}/${view.id}`);
  closeSide();
  closeDetail();
  renderHeader();
  renderSidebar();
  await loadTasks();
}
function viewName() {
  const v = S.view;
  if (v.type === 'list') { const l = listById(v.id); return l?.is_inbox ? 'Inbox' : l?.name || ''; }
  if (v.id === 'search') return `Search: ${S.searchQ}`;
  return SMART[v.id]?.name || '';
}
function renderHeader() {
  const v = S.view, l = v.type === 'list' ? listById(v.id) : null;
  $('#list-title').textContent = viewName();
  $('#share-btn').classList.toggle('hidden', !l || !!l.is_inbox);
  $('#list-menu-btn').classList.toggle('hidden', !l);
  $('#add-form').classList.toggle('hidden', v.id === 'search');
  const target = l ? (l.is_inbox ? 'Inbox' : l.name) : 'Inbox';
  $('#add-input').placeholder = `Add a to-do in "${target}"…`;
  S.addStar = v.id === 'starred';
  $('#add-star').setAttribute('aria-pressed', S.addStar);
}

async function loadTasks() {
  const seq = ++S.loadSeq;
  const v = S.view;
  const q = v.type === 'list' ? `list=${v.id}` : v.id === 'search' ? `smart=search&q=${encodeURIComponent(S.searchQ)}` : `smart=${v.id}`;
  try {
    const d = await api('GET', `/tasks?${q}`);
    if (seq !== S.loadSeq) return; // a newer load superseded this one
    S.tasks = d.tasks;
    renderTasks();
    if (S.selected) { if (taskById(S.selected)) renderDetail(); else closeDetail(); }
  } catch (e) { fail(e); }
}
const taskById = (id) => S.tasks.find((t) => t.id === Number(id));

function taskRow(t) {
  const meta = [];
  const showList = S.view.type === 'smart';
  if (showList) meta.push(`<span>${esc(t.list_name)}</span>`);
  if (t.due_date && !t.completed) {
    const today = localToday();
    const cls = t.due_date < today ? 'overdue' : t.due_date === today ? 'due-today' : '';
    meta.push(`<span class="${cls}">${ic('calendar')}${esc(dueLabel(t.due_date))}</span>`);
  }
  if (t.recurrence) meta.push(`<span title="Repeats ${esc(REPEAT_LABEL[t.recurrence].toLowerCase())}">${ic('repeat')}</span>`);
  if (t.remind_at && !t.reminded && !t.completed) meta.push(`<span title="Reminder set">${ic('bell')}</span>`);
  if (t.subtasks.length) meta.push(`<span title="Subtasks done">${ic('list-checks')}${t.subtasks.filter((s) => s.completed).length}/${t.subtasks.length}</span>`);
  if (t.notes) meta.push(`<span title="Has notes">${ic('notebook-pen')}</span>`);
  if (t.assigned_name) meta.push(`<span>${ic('user-round')}${esc(t.assigned_name)}</span>`);
  const draggable = !t.completed && window.matchMedia('(pointer: fine)').matches;
  return `<li class="task${S.selected === t.id ? ' selected' : ''}" data-id="${t.id}" ${draggable ? 'draggable="true"' : ''}>
    <label class="check"><input type="checkbox" ${t.completed ? 'checked' : ''} data-act="toggle"><span></span></label>
    <div class="t-main"><div class="t-title">${esc(t.title)}</div><div class="t-meta">${meta.join('')}</div></div>
    <button class="star-btn" data-act="star" title="${t.starred ? 'Unstar' : 'Star'}" aria-pressed="${!!t.starred}">${ic('star')}</button></li>`;
}

function renderTasks() {
  const open = S.tasks.filter((t) => !t.completed), done = S.tasks.filter((t) => t.completed);
  $('#tasks').innerHTML = open.map(taskRow).join('');
  const isList = S.view.type === 'list', isSearch = S.view.id === 'search';
  const showDoneKey = `showDone:${S.view.id}`;
  const showDone = isSearch || ls.get(showDoneKey, false);
  const sd = $('#show-done');
  sd.classList.toggle('hidden', !isList || !done.length);
  sd.textContent = showDone ? 'Hide completed to-dos' : `Show completed to-dos (${done.length})`;
  $('#done-tasks').innerHTML = (isList || isSearch) && showDone ? done.map(taskRow).join('') : '';
  const empty = $('#empty');
  empty.classList.toggle('hidden', !!open.length || (showDone && done.length > 0));
  const [head, sub] = isSearch ? ['No matches', 'Try fewer words, or check completed to-dos.']
    : S.view.id === 'today' ? ['Nothing due today', 'Anything due today or overdue shows up here.']
    : S.view.id === 'week' ? ['Nothing due this week', 'To-dos due in the next 7 days show up here.']
    : S.view.id === 'starred' ? ['No starred to-dos', 'Star a to-do to pin it here.']
    : S.view.id === 'assigned' ? ['Nothing assigned to you', 'To-dos assigned to you on shared lists show up here.']
    : ['All done', 'Add a to-do above.'];
  empty.innerHTML = `${esc(head)}<small>${esc(sub)}</small>`;
}
$('#show-done').onclick = () => {
  const k = `showDone:${S.view.id}`;
  ls.set(k, !ls.get(k, false));
  renderTasks();
};

async function onTaskClick(e) {
  const li = e.target.closest('.task');
  if (!li) return;
  const id = Number(li.dataset.id), act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'toggle') { e.stopPropagation(); return toggleTask(id, li); }
  if (act === 'star') { e.stopPropagation(); const t = taskById(id); return updateTask(id, { starred: !t.starred }); }
  if (e.target.closest('.check')) return;
  openDetail(id);
}
$('#tasks').onclick = onTaskClick;
$('#done-tasks').onclick = onTaskClick;

async function toggleTask(id, li) {
  const t = taskById(id);
  if (!t) return;
  if (!t.completed) { ding(); li?.classList.add('completing'); }
  try {
    const r = await api('POST', `/tasks/${id}/toggle`);
    if (r.rolled) toast(`Next: ${dueLabel(r.task.due_date)}`);
    else if (r.task.completed) toast('Completed', 'Undo', () => toggleTask(id));
    Object.assign(t, r.task);
    if (S.view.type === 'smart' && r.task.completed) S.tasks = S.tasks.filter((x) => x.id !== id);
    setTimeout(() => { renderTasks(); if (S.selected === id) renderDetail(); }, li ? 250 : 0);
    loadLists();
  } catch (e) { fail(e); renderTasks(); }
}

async function updateTask(id, patch) {
  try {
    const t = await api('PUT', `/tasks/${id}`, patch);
    const i = S.tasks.findIndex((x) => x.id === id);
    if (i >= 0) S.tasks[i] = t;
    // Dropped out of the current view (moved list, unstarred in Starred, etc.) → reload
    if (('list_id' in patch && S.view.type === 'list') || ('starred' in patch && S.view.id === 'starred') || ('due_date' in patch && S.view.type === 'smart')) {
      await loadTasks();
    } else { renderTasks(); if (S.selected === id) renderDetail(); }
    loadLists();
    return t;
  } catch (e) { fail(e); }
}

// add task
$('#add-star').onclick = () => { S.addStar = !S.addStar; $('#add-star').setAttribute('aria-pressed', S.addStar); $('#add-input').focus(); };
$('#add-form').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#add-input'), title = input.value.trim();
  if (!title) return;
  const v = S.view;
  const body = { title, list_id: v.type === 'list' ? v.id : inbox().id, starred: S.addStar };
  if (v.id === 'today' || v.id === 'week') body.due_date = localToday();
  input.value = '';
  try {
    let t = await api('POST', '/tasks', body);
    if (v.id === 'assigned') t = await api('PUT', `/tasks/${t.id}`, { assigned_to: S.me.id });
    S.tasks.unshift(t);
    renderTasks();
    loadLists();
  } catch (err) { input.value = title; fail(err); }
};

// task drag reorder (desktop) + drag onto sidebar list
let dragTask = null;
$('#tasks').addEventListener('dragstart', (e) => {
  const li = e.target.closest('.task');
  if (!li) return;
  dragTask = Number(li.dataset.id);
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', 'task');
});
$('#tasks').addEventListener('dragover', (e) => {
  if (!dragTask || S.view.type !== 'list') return;
  const li = e.target.closest('.task');
  if (!li) return;
  e.preventDefault(); clearDragMarks(); li.classList.add('drag-over');
});
$('#tasks').addEventListener('drop', (e) => {
  const li = e.target.closest('.task');
  clearDragMarks();
  if (!dragTask || !li || S.view.type !== 'list') return;
  e.preventDefault();
  const open = S.tasks.filter((t) => !t.completed);
  const moving = open.find((t) => t.id === dragTask);
  const rest = open.filter((t) => t.id !== dragTask);
  rest.splice(rest.findIndex((t) => t.id === Number(li.dataset.id)), 0, moving);
  S.tasks = rest.concat(S.tasks.filter((t) => t.completed));
  dragTask = null;
  renderTasks();
  api('PUT', '/tasks/order', { ids: rest.map((t) => t.id) }).catch(fail);
});

// ---------------- detail pane ----------------
function openDetail(id) {
  S.selected = id;
  $('#detail').classList.add('open');
  $('#detail').setAttribute('aria-hidden', 'false');
  document.querySelectorAll('.task.selected').forEach((n) => n.classList.remove('selected'));
  document.querySelector(`.task[data-id="${id}"]`)?.classList.add('selected');
  renderDetail(true);
}
function closeDetail() {
  S.selected = null;
  $('#detail').classList.remove('open');
  $('#detail').setAttribute('aria-hidden', 'true');
  document.querySelectorAll('.task.selected').forEach((n) => n.classList.remove('selected'));
}
const setField = (el, val, force) => { if (force || document.activeElement !== el) el.value = val; };
function autosize(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }

function renderDetail(force = false) {
  const t = taskById(S.selected);
  if (!t) return;
  $('#d-check').checked = !!t.completed;
  setField($('#d-title'), t.title, force); autosize($('#d-title'));
  $('#d-star').setAttribute('aria-pressed', !!t.starred);
  setField($('#d-due'), t.due_date || '', force);
  setField($('#d-remind'), isoToLocalInput(t.remind_at), force);
  setField($('#d-repeat'), t.recurrence || '', force);
  setField($('#d-notes'), t.notes || '', force);
  const list = listById(t.list_id);
  const members = list?.members || [];
  $('#d-assign-row').classList.toggle('hidden', members.length < 2);
  $('#d-assign').innerHTML = '<option value="">Nobody</option>' + members.map((m) => `<option value="${m.id}">${esc(m.username)}${m.id === S.me.id ? ' (me)' : ''}</option>`).join('');
  $('#d-assign').value = t.assigned_to || '';
  $('#d-list').innerHTML = S.lists.map((l) => `<option value="${l.id}">${esc(l.is_inbox ? 'Inbox' : l.name)}</option>`).join('');
  $('#d-list').value = t.list_id;
  if (!$('#d-subs').contains(document.activeElement) || force) $('#d-subs').innerHTML = t.subtasks.map((s) => `<li data-sid="${s.id}" class="${s.completed ? 'done' : ''}">
    <label class="check"><input type="checkbox" ${s.completed ? 'checked' : ''}><span></span></label>
    <input class="s-title" value="${esc(s.title)}" maxlength="500"><button class="s-del" title="Delete subtask">${ic('x', 'sm')}</button></li>`).join('');
  const created = new Date(t.created_at.replace(' ', 'T') + 'Z');
  $('#d-meta').textContent = t.completed && t.completed_at
    ? `Completed ${new Date(t.completed_at.replace(' ', 'T') + 'Z').toLocaleDateString()}`
    : `Created ${created.toLocaleDateString()}`;
}

$('#d-close').onclick = closeDetail;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#modal').classList.contains('hidden')) closeModal();
    else if (S.selected) closeDetail();
  }
});
$('#d-check').onchange = () => toggleTask(S.selected);
$('#d-star').onclick = () => { const t = taskById(S.selected); updateTask(t.id, { starred: !t.starred }); };
$('#d-title').oninput = (e) => autosize(e.target);
$('#d-title').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } };
$('#d-title').onblur = (e) => { const t = taskById(S.selected); const v = e.target.value.trim(); if (t && v && v !== t.title) updateTask(t.id, { title: v }); else if (t) e.target.value = t.title; };
$('#d-due').onchange = (e) => updateTask(S.selected, { due_date: e.target.value || null });
$('#d-remind').onchange = (e) => {
  const v = e.target.value;
  updateTask(S.selected, { remind_at: v ? new Date(v).toISOString() : null }).then(() => { if (v) maybeAskPush(); });
};
$('#d-repeat').onchange = (e) => updateTask(S.selected, { recurrence: e.target.value });
$('#d-assign').onchange = (e) => updateTask(S.selected, { assigned_to: e.target.value ? Number(e.target.value) : null });
$('#d-list').onchange = (e) => updateTask(S.selected, { list_id: Number(e.target.value) }).then(() => { if (S.view.type === 'list') closeDetail(); });
document.querySelectorAll('[data-clear]').forEach((b) => b.onclick = () => {
  const id = b.dataset.clear;
  $('#' + id).value = '';
  updateTask(S.selected, id === 'd-due' ? { due_date: null } : { remind_at: null });
});
let notesT;
$('#d-notes').oninput = () => { clearTimeout(notesT); const id = S.selected; notesT = setTimeout(() => saveNotes(id), 800); };
$('#d-notes').onblur = () => { clearTimeout(notesT); saveNotes(S.selected); };
function saveNotes(id) {
  const t = taskById(id); const v = $('#d-notes').value;
  if (t && S.selected === id && v !== t.notes) updateTask(id, { notes: v });
}
$('#d-delete').onclick = () => {
  const t = taskById(S.selected);
  confirmModal(`Delete "${t.title}"?`, 'This can’t be undone.', 'Delete', async () => {
    await api('DELETE', `/tasks/${t.id}`);
    S.tasks = S.tasks.filter((x) => x.id !== t.id);
    closeDetail(); renderTasks(); loadLists();
  });
};

// subtasks
$('#d-sub-form').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#d-sub-input'), title = input.value.trim(), id = S.selected;
  if (!title) return;
  input.value = '';
  try {
    const s = await api('POST', `/tasks/${id}/subtasks`, { title });
    taskById(id)?.subtasks.push(s);
    renderDetail(); renderTasks();
  } catch (err) { fail(err); }
};
$('#d-subs').addEventListener('change', async (e) => {
  const li = e.target.closest('li'); if (!li) return;
  const sid = Number(li.dataset.sid), t = taskById(S.selected), s = t?.subtasks.find((x) => x.id === sid);
  if (!s) return;
  const patch = e.target.type === 'checkbox' ? { completed: e.target.checked } : { title: e.target.value };
  if (patch.title !== undefined && !patch.title.trim()) { e.target.value = s.title; return; }
  try { Object.assign(s, await api('PUT', `/subtasks/${sid}`, patch)); renderDetail(); renderTasks(); } catch (err) { fail(err); }
});
$('#d-subs').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('s-title')) e.target.blur(); });
$('#d-subs').addEventListener('click', async (e) => {
  if (!e.target.classList.contains('s-del')) return;
  const sid = Number(e.target.closest('li').dataset.sid), t = taskById(S.selected);
  try { await api('DELETE', `/subtasks/${sid}`); t.subtasks = t.subtasks.filter((x) => x.id !== sid); renderDetail(); renderTasks(); } catch (err) { fail(err); }
});

// ---------------- modals ----------------
function openModal(html) { $('#modal-card').innerHTML = html; $('#modal').classList.remove('hidden'); return $('#modal-card'); }
function closeModal() { $('#modal').classList.add('hidden'); $('#modal-card').innerHTML = ''; }
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

function promptModal(title, value, okLabel, fn) {
  const c = openModal(`<h2>${esc(title)}</h2><form id="pm"><input id="pm-in" maxlength="100" value="${esc(value)}" required>
    <p class="err" id="pm-err"></p><div class="actions"><button type="button" class="btn" id="pm-cancel">Cancel</button><button class="btn primary">${esc(okLabel)}</button></div></form>`);
  const inp = $('#pm-in', c); inp.focus(); inp.select();
  $('#pm-cancel', c).onclick = closeModal;
  $('#pm', c).onsubmit = async (e) => {
    e.preventDefault();
    try { await fn(inp.value.trim()); closeModal(); } catch (err) { $('#pm-err', c).textContent = err.message; }
  };
}
function confirmModal(title, body, okLabel, fn) {
  const c = openModal(`<h2>${esc(title)}</h2><p class="muted">${esc(body)}</p><p class="err" id="cm-err"></p>
    <div class="actions"><button class="btn" id="cm-cancel">Cancel</button><button class="btn danger" id="cm-ok">${esc(okLabel)}</button></div>`);
  $('#cm-cancel', c).onclick = closeModal;
  $('#cm-ok', c).onclick = async () => { try { await fn(); closeModal(); } catch (err) { $('#cm-err', c).textContent = err.message; } };
}

// list menu
$('#list-menu-btn').onclick = () => {
  const l = listById(S.view.id); if (!l) return;
  const owner = l.owner_id === S.me.id;
  const done = S.tasks.filter((t) => t.completed).length;
  const c = openModal(`<h2>${esc(l.is_inbox ? 'Inbox' : l.name)}</h2><div class="menu-list">
    ${l.is_inbox ? '' : `<button data-a="rename">${ic('pencil')}Rename list</button><button data-a="share">${ic('user-plus')}Share list</button>`}
    ${done ? `<button data-a="clear">${ic('eraser')}Delete ${done} completed to-do${done > 1 ? 's' : ''}</button>` : ''}
    ${l.is_inbox ? '' : owner ? `<button data-a="delete" class="danger">${ic('trash-2')}Delete list</button>` : `<button data-a="leave" class="danger">${ic('door-open')}Leave list</button>`}
    </div><div class="actions"><button class="btn" id="lm-close">Close</button></div>`);
  $('#lm-close', c).onclick = closeModal;
  c.querySelector('.menu-list').onclick = (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'rename') promptModal('Rename list', l.name, 'Save', async (name) => { await api('PUT', `/lists/${l.id}`, { name }); await loadLists(); renderHeader(); });
    if (a === 'share') shareModal(l.id);
    if (a === 'clear') confirmModal(`Delete ${done} completed to-dos?`, 'This can’t be undone.', 'Delete', async () => { await api('DELETE', `/lists/${l.id}/completed`); await loadTasks(); });
    if (a === 'delete') confirmModal(`Delete "${l.name}"?`, `All its to-dos will be deleted${l.members.length > 1 ? ' for everyone it’s shared with' : ''}.`, 'Delete', async () => { await api('DELETE', `/lists/${l.id}`); await loadLists(); setView({ type: 'list', id: inbox().id }); });
    if (a === 'leave') confirmModal(`Leave "${l.name}"?`, 'You’ll lose access until someone shares it again.', 'Leave', async () => { await api('DELETE', `/lists/${l.id}`); await loadLists(); setView({ type: 'list', id: inbox().id }); });
  };
};

// share
$('#share-btn').onclick = () => shareModal(S.view.id);
function shareModal(listId) {
  const l = listById(listId); if (!l) return;
  const owner = l.owner_id === S.me.id;
  const c = openModal(`<h2>Share "${esc(l.name)}"</h2>
    <div>${l.members.map((m) => `<div class="member"><span class="avatar">${esc(m.username[0])}</span><span class="name">${esc(m.username)}${m.id === l.owner_id ? ' <span class="muted small">owner</span>' : ''}</span>
      ${owner && m.id !== l.owner_id ? `<button class="link" data-rm="${m.id}">Remove</button>` : ''}</div>`).join('')}</div>
    <form class="inline" id="sh-form"><input id="sh-user" placeholder="Username" autocapitalize="none" required><button class="btn primary">Add</button></form>
    <p class="err" id="sh-err"></p><div class="actions"><button class="btn" id="sh-close">Done</button></div>`);
  $('#sh-close', c).onclick = closeModal;
  $('#sh-form', c).onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', `/lists/${l.id}/members`, { username: $('#sh-user', c).value.trim() }); await loadLists(); shareModal(l.id); }
    catch (err) { $('#sh-err', c).textContent = err.message; }
  };
  c.querySelectorAll('[data-rm]').forEach((b) => b.onclick = async () => {
    try { await api('DELETE', `/lists/${l.id}/members/${b.dataset.rm}`); await loadLists(); shareModal(l.id); } catch (err) { $('#sh-err', c).textContent = err.message; }
  });
}

// settings
$('#user-btn').onclick = settingsModal;
async function settingsModal() {
  const bg = ls.get('bg', 0);
  const pushState = await getPushState();
  const c = openModal(`<h2>Settings</h2>
    <h4>Notifications</h4>
    <div class="toggle-row"><span id="st-push-label">${esc(pushState.label)}</span>
      ${pushState.can ? `<button class="btn ${pushState.on ? '' : 'primary'}" id="st-push">${pushState.on ? 'Disable' : 'Enable'}</button>` : ''}</div>
    ${pushState.on ? '<button class="link" id="st-test" style="justify-self:start">Send a test notification</button>' : ''}
    <label class="toggle-row"><span>Completion sound</span><input type="checkbox" id="st-sound" ${ls.get('sound', true) ? 'checked' : ''}></label>
    <h4>Appearance</h4>
    <div class="seg" role="group" aria-label="Theme">${[['auto', 'monitor', 'Auto'], ['dark', 'moon', 'Dark'], ['light', 'sun', 'Light']].map(([v, i, n]) => `<button data-theme-opt="${v}" aria-pressed="${ls.get('theme', 'auto') === v}">${ic(i, 'sm')}${n}</button>`).join('')}</div>
    <div class="swatches">${BACKGROUNDS.map((b, i) => `<button class="swatch" data-bg="${i}" title="${esc(b.name)}" aria-label="${esc(b.name)} background" aria-pressed="${i === bg}" style="background:${b.css}"></button>`).join('')}</div>
    <h4>Password</h4>
    <form id="st-pw" style="display:grid;gap:8px"><input type="password" id="st-cur" placeholder="Current password" autocomplete="current-password" required>
      <input type="password" id="st-new" placeholder="New password (8+ chars)" autocomplete="new-password" minlength="8" required>
      <button class="btn">Change password</button></form>
    ${S.me.is_admin ? '<h4>Admin</h4><button class="btn" id="st-users">Manage users</button>' : ''}
    <p class="err" id="st-err"></p>
    <div class="actions"><button class="btn danger" id="st-logout">Sign out</button><button class="btn primary" id="st-close">Done</button></div>`);
  const err = $('#st-err', c);
  $('#st-close', c).onclick = closeModal;
  $('#st-sound', c).onchange = (e) => ls.set('sound', e.target.checked);
  c.querySelectorAll('[data-bg]').forEach((b) => b.onclick = () => {
    ls.set('bg', Number(b.dataset.bg)); applyBackground();
    c.querySelectorAll('[data-bg]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  });
  c.querySelectorAll('[data-theme-opt]').forEach((b) => b.onclick = () => {
    ls.set('theme', b.dataset.themeOpt); applyTheme();
    c.querySelectorAll('[data-theme-opt]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  });
  $('#st-push', c)?.addEventListener('click', async () => {
    try { if (pushState.on) await disablePush(); else await enablePush(); settingsModal(); } catch (e) { err.textContent = e.message; }
  });
  $('#st-test', c)?.addEventListener('click', async () => {
    try {
      const r = await api('POST', '/push/test');
      if (!r.subs) err.textContent = 'The server has no devices registered for your account. Tap Disable, then Enable.';
      else if (r.sent) toast(`Test sent to ${r.sent} device${r.sent > 1 ? 's' : ''}`);
      else err.textContent = 'Push failed: ' + (r.errors[0] || 'unknown error') + ' (also in docker logs)';
    } catch (e) { err.textContent = e.message; }
  });
  $('#st-pw', c).onsubmit = async (e) => {
    e.preventDefault();
    try { await api('PUT', '/auth/password', { current: $('#st-cur', c).value, password: $('#st-new', c).value }); toast('Password changed'); closeModal(); } catch (ex) { err.textContent = ex.message; }
  };
  $('#st-users', c)?.addEventListener('click', usersModal);
  $('#st-logout', c).onclick = async () => {
    try { await disablePush(true); } catch {}
    await api('POST', '/auth/logout'); location.hash = ''; location.reload();
  };
}
function applyBackground() {
  const b = BACKGROUNDS[ls.get('bg', 0)] || BACKGROUNDS[0];
  document.documentElement.style.setProperty('--bg-scene', b.css);
}
const lightMQ = window.matchMedia('(prefers-color-scheme: light)');
function applyTheme() {
  const pref = ls.get('theme', 'auto');
  const t = pref === 'auto' ? (lightMQ.matches ? 'light' : 'dark') : pref;
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]').content = t === 'light' ? '#f7f8fb' : '#141a26';
}
lightMQ.addEventListener?.('change', applyTheme);

async function usersModal() {
  const users = await api('GET', '/users');
  const c = openModal(`<h2>Users</h2>
    <div>${users.map((u) => `<div class="member"><span class="avatar">${esc(u.username[0])}</span><span class="name">${esc(u.username)}${u.is_admin ? ' <span class="muted small">admin</span>' : ''}</span>
      <button class="link" data-pw="${u.id}">Reset pw</button>${u.id !== S.me.id ? `<button class="link" style="color:var(--red)" data-del="${u.id}" data-name="${esc(u.username)}">Delete</button>` : ''}</div>`).join('')}</div>
    <h4>Add user</h4>
    <form id="u-form" style="display:grid;gap:8px"><input id="u-name" placeholder="Username" autocapitalize="none" required>
      <input id="u-pass" type="password" placeholder="Temporary password (8+ chars)" minlength="8" autocomplete="new-password" required>
      <label class="toggle-row"><span>Admin</span><input type="checkbox" id="u-admin" style="width:auto"></label>
      <button class="btn primary">Create user</button></form>
    <p class="err" id="u-err"></p><div class="actions"><button class="btn" id="u-back">Back</button></div>`);
  const err = $('#u-err', c);
  $('#u-back', c).onclick = settingsModal;
  $('#u-form', c).onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', '/users', { username: $('#u-name', c).value.trim(), password: $('#u-pass', c).value, is_admin: $('#u-admin', c).checked }); usersModal(); } catch (ex) { err.textContent = ex.message; }
  };
  c.querySelectorAll('[data-pw]').forEach((b) => b.onclick = () => {
    const pw = prompt('New password (8+ characters):');
    if (pw) api('PUT', `/users/${b.dataset.pw}/password`, { password: pw }).then(() => toast('Password reset')).catch((ex) => { err.textContent = ex.message; });
  });
  c.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => confirmModal(`Delete user "${b.dataset.name}"?`, 'Their Inbox and every list they own will be deleted, including lists shared with others.', 'Delete user', async () => {
    await api('DELETE', `/users/${b.dataset.del}`); await loadLists(); usersModal();
  }));
}

// ---------------- realtime ----------------
let es, refreshT;
function connectEvents() {
  es?.close();
  es = new EventSource('/api/events');
  es.onmessage = () => { clearTimeout(refreshT); refreshT = setTimeout(refresh, 300); };
  es.onerror = () => { /* browser auto-reconnects (retry: 5000) */ };
}
async function refresh() {
  try { await loadLists(); if (S.view.type === 'list' && !listById(S.view.id)) return setView({ type: 'list', id: inbox().id }); renderHeader(); await loadTasks(); } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.me) refresh(); });
// Day rollover: re-render so "Today"/overdue labels stay correct
setInterval(() => { if (S.me && localToday() !== S.today) { S.today = localToday(); refresh(); } }, 60000);
S.today = localToday();

// ---------------- service worker & push ----------------
let swReg;
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    swReg = await navigator.serviceWorker.register('/sw.js');
    navigator.serviceWorker.addEventListener('message', (e) => {
      const m = e.data?.type === 'open' && String(e.data.url || '').match(/task\/(\d+)/);
      if (m) openTaskFromLink(Number(m[1]));
    });
  } catch (e) { console.warn('SW registration failed', e); return; }
  resyncPush();
}
// Self-heal: if this browser already has a push subscription, make sure the server has it too.
async function resyncPush() {
  try {
    if (!('PushManager' in window) || Notification.permission !== 'granted') return;
    const reg = swReg || await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await api('POST', '/push/subscribe', sub.toJSON());
  } catch (e) { console.warn('push resync failed', e); }
}
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
async function getPushState() {
  if (!window.isSecureContext) return { can: false, label: 'Needs HTTPS for notifications' };
  if (isIOS() && !isStandalone()) return { can: false, label: 'On iPhone/iPad: Share → Add to Home Screen, then open from there to enable' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return { can: false, label: 'This browser doesn’t support push' };
  if (Notification.permission === 'denied') return { can: false, label: 'Blocked in browser/OS settings' };
  const reg = swReg || await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return { can: true, on: !!sub && Notification.permission === 'granted', label: sub ? 'Reminders on this device: on' : 'Reminders on this device: off' };
}
function urlB64ToUint8(b64) {
  const p = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notification permission not granted');
  const reg = swReg || await navigator.serviceWorker.ready;
  const { publicKey } = await api('GET', '/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(publicKey) });
  await api('POST', '/push/subscribe', sub.toJSON());
  ls.set('pushAsked', true);
  toast('Reminders enabled on this device');
}
async function disablePush(silent) {
  const reg = swReg || (await navigator.serviceWorker?.getRegistration());
  const sub = await reg?.pushManager?.getSubscription();
  if (sub) { await api('POST', '/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
  if (!silent) toast('Reminders disabled on this device');
}
async function maybeAskPush() {
  const st = await getPushState().catch(() => null);
  if (!st || st.on) return;
  if (!st.can) { if (!ls.get('pushHint', false)) { ls.set('pushHint', true); toast(st.label); } return; }
  toast('Get reminder notifications on this device?', 'Enable', () => enablePush().catch(fail));
}

boot();
