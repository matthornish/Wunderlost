const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const webpush = require('web-push');
const db = require('./db');
const { RULES, today, addDays, nextOccurrence } = require('./recur');

const PORT = Number(process.env.PORT || 3000);
const ALLOW_REGISTRATION = /^(1|true|yes)$/i.test(process.env.ALLOW_REGISTRATION || '');
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 90);
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

// ---------- Web push (VAPID keys generated once, stored in DB) ----------
let vapid = { publicKey: db.getSetting('vapid_public'), privateKey: db.getSetting('vapid_private') };
if (!vapid.publicKey || !vapid.privateKey) {
  vapid = webpush.generateVAPIDKeys();
  db.setSetting('vapid_public', vapid.publicKey);
  db.setSetting('vapid_private', vapid.privateKey);
}
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = (fn) => (req, res, next) => { try { const r = fn(req, res, next); if (r && r.catch) r.catch(next); } catch (e) { next(e); } };
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bool = (v) => (v ? 1 : 0);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const toISO = (v) => { const d = new Date(v); if (isNaN(d)) throw new HttpError(400, 'Bad date'); return d.toISOString(); };

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function setSessionCookie(req, res, token, maxAgeSec) {
  const parts = [`wl_session=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// Block cross-site form posts: every mutating API call must be JSON.
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !(req.headers['content-type'] || '').startsWith('application/json')) {
    return res.status(415).json({ error: 'JSON required' });
  }
  next();
});

// Resolve session
app.use('/api', (req, res, next) => {
  const token = parseCookies(req).wl_session;
  if (token) {
    const row = db.prepare(`SELECT u.id, u.username, u.is_admin, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
    if (row && row.expires_at > Date.now()) req.user = { id: row.id, username: row.username, is_admin: !!row.is_admin };
  }
  next();
});
const auth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Not logged in' }));
const admin = (req, res, next) => (req.user?.is_admin ? next() : res.status(403).json({ error: 'Admin only' }));

// ---------- realtime (SSE) ----------
const clients = new Map(); // userId -> Set(res)
function notifyUsers(userIds, payload = { type: 'change' }) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const uid of new Set(userIds)) for (const res of clients.get(uid) || []) res.write(msg);
}
const listMemberIds = (listId) => db.prepare('SELECT user_id FROM list_members WHERE list_id = ?').all(listId).map((r) => r.user_id);
const notifyList = (listId) => notifyUsers(listMemberIds(listId));

app.get('/api/events', auth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  if (!clients.has(req.user.id)) clients.set(req.user.id, new Set());
  clients.get(req.user.id).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.get(req.user.id)?.delete(res); });
});

// ---------- access checks ----------
function requireMember(userId, listId) {
  const row = db.prepare('SELECT l.* FROM lists l JOIN list_members m ON m.list_id = l.id WHERE l.id = ? AND m.user_id = ?').get(listId, userId);
  if (!row) throw new HttpError(404, 'List not found');
  return row;
}
function requireTask(userId, taskId) {
  const t = db.prepare('SELECT t.* FROM tasks t JOIN list_members m ON m.list_id = t.list_id WHERE t.id = ? AND m.user_id = ?').get(taskId, userId);
  if (!t) throw new HttpError(404, 'Task not found');
  return t;
}

// ---------- auth ----------
const loginAttempts = new Map(); // ip -> {count, until}
function checkRate(ip) {
  const a = loginAttempts.get(ip);
  if (a && a.until > Date.now() && a.count >= 10) throw new HttpError(429, 'Too many attempts, try again in a few minutes');
}
function failRate(ip) {
  const a = loginAttempts.get(ip);
  if (!a || a.until < Date.now()) loginAttempts.set(ip, { count: 1, until: Date.now() + 10 * 60000 });
  else a.count++;
}

function createUser(username, password, isAdmin) {
  username = str(username, 40);
  if (!/^[A-Za-z0-9_.-]{2,40}$/.test(username)) throw new HttpError(400, 'Username: 2-40 letters, numbers, . _ -');
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'Username taken');
  const hash = bcrypt.hashSync(password, 12);
  return db.transaction(() => {
    const uid = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)').run(username, hash, bool(isAdmin)).lastInsertRowid;
    const lid = db.prepare('INSERT INTO lists (name, owner_id, is_inbox) VALUES (?, ?, 1)').run('Inbox', uid).lastInsertRowid;
    db.prepare('INSERT INTO list_members (list_id, user_id, position) VALUES (?, ?, 0)').run(lid, uid);
    return uid;
  })();
}

function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, Date.now() + SESSION_DAYS * 86400000);
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}

app.get('/api/auth/status', (req, res) => {
  const hasUsers = !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
  res.json({ user: req.user || null, setupNeeded: !hasUsers, registrationOpen: !hasUsers || ALLOW_REGISTRATION });
});

app.post('/api/auth/register', wrap((req, res) => {
  const first = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
  if (!first && !ALLOW_REGISTRATION) throw new HttpError(403, 'Registration is closed. Ask the admin for an account.');
  const uid = createUser(req.body.username, req.body.password, first);
  startSession(req, res, uid);
  res.json({ ok: true });
}));

app.post('/api/auth/login', wrap((req, res) => {
  checkRate(req.ip);
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(str(req.body.username, 40));
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) {
    failRate(req.ip);
    throw new HttpError(401, 'Wrong username or password');
  }
  loginAttempts.delete(req.ip);
  startSession(req, res, u.id);
  res.json({ ok: true });
}));

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req).wl_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

app.put('/api/auth/password', auth, wrap((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(req.body.current || ''), u.password_hash)) throw new HttpError(400, 'Current password is wrong');
  if (typeof req.body.password !== 'string' || req.body.password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.password, 12), u.id);
  const token = parseCookies(req).wl_session;
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(u.id, token);
  res.json({ ok: true });
}));

// ---------- admin: users ----------
app.get('/api/users', auth, admin, (req, res) => {
  res.json(db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY username').all());
});
app.post('/api/users', auth, admin, wrap((req, res) => {
  const id = createUser(req.body.username, req.body.password, !!req.body.is_admin);
  res.json({ id });
}));
app.put('/api/users/:id/password', auth, admin, wrap((req, res) => {
  if (typeof req.body.password !== 'string' || req.body.password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const r = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.password, 12), req.params.id);
  if (!r.changes) throw new HttpError(404, 'No such user');
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
  res.json({ ok: true });
}));
app.delete('/api/users/:id', auth, admin, wrap((req, res) => {
  if (Number(req.params.id) === req.user.id) throw new HttpError(400, "You can't delete yourself");
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id); // cascades to their owned lists
  res.json({ ok: true });
}));

// ---------- lists ----------
function listsFor(userId) {
  const lists = db.prepare(`
    SELECT l.id, l.name, l.owner_id, l.is_inbox, m.position,
      (SELECT COUNT(*) FROM tasks t WHERE t.list_id = l.id AND t.completed = 0) AS open_count
    FROM lists l JOIN list_members m ON m.list_id = l.id AND m.user_id = ?
    ORDER BY l.is_inbox DESC, m.position, l.id`).all(userId);
  const memStmt = db.prepare('SELECT u.id, u.username FROM list_members m JOIN users u ON u.id = m.user_id WHERE m.list_id = ? ORDER BY u.username');
  for (const l of lists) l.members = memStmt.all(l.id);
  return lists;
}

app.get('/api/lists', auth, (req, res) => {
  const t = today(), week = addDays(t, 6);
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN t.starred = 1 THEN 1 ELSE 0 END) AS starred,
      SUM(CASE WHEN t.due_date IS NOT NULL AND t.due_date <= ? THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN t.due_date IS NOT NULL AND t.due_date <= ? THEN 1 ELSE 0 END) AS week,
      SUM(CASE WHEN t.assigned_to = ? THEN 1 ELSE 0 END) AS assigned
    FROM tasks t JOIN list_members m ON m.list_id = t.list_id AND m.user_id = ?
    WHERE t.completed = 0`).get(t, week, req.user.id, req.user.id);
  res.json({ lists: listsFor(req.user.id), smart: counts });
});

app.post('/api/lists', auth, wrap((req, res) => {
  const name = str(req.body.name, 100);
  if (!name) throw new HttpError(400, 'Name required');
  const id = db.transaction(() => {
    const id = db.prepare('INSERT INTO lists (name, owner_id) VALUES (?, ?)').run(name, req.user.id).lastInsertRowid;
    const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM list_members WHERE user_id = ?').get(req.user.id).p;
    db.prepare('INSERT INTO list_members (list_id, user_id, position) VALUES (?, ?, ?)').run(id, req.user.id, pos);
    return id;
  })();
  res.json({ id });
}));

app.put('/api/lists/order', auth, wrap((req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const st = db.prepare('UPDATE list_members SET position = ? WHERE list_id = ? AND user_id = ?');
  db.transaction(() => ids.forEach((id, i) => st.run(i + 1, id, req.user.id)))();
  res.json({ ok: true });
}));

app.put('/api/lists/:id', auth, wrap((req, res) => {
  const l = requireMember(req.user.id, req.params.id);
  if (l.is_inbox) throw new HttpError(400, "Inbox can't be renamed");
  const name = str(req.body.name, 100);
  if (!name) throw new HttpError(400, 'Name required');
  db.prepare('UPDATE lists SET name = ? WHERE id = ?').run(name, l.id);
  notifyList(l.id);
  res.json({ ok: true });
}));

app.delete('/api/lists/:id', auth, wrap((req, res) => {
  const l = requireMember(req.user.id, req.params.id);
  if (l.is_inbox) throw new HttpError(400, "Inbox can't be deleted");
  const members = listMemberIds(l.id);
  if (l.owner_id === req.user.id) db.prepare('DELETE FROM lists WHERE id = ?').run(l.id);
  else db.prepare('DELETE FROM list_members WHERE list_id = ? AND user_id = ?').run(l.id, req.user.id); // leave shared list
  notifyUsers(members);
  res.json({ ok: true });
}));

app.post('/api/lists/:id/members', auth, wrap((req, res) => {
  const l = requireMember(req.user.id, req.params.id);
  if (l.is_inbox) throw new HttpError(400, "Inbox can't be shared");
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(str(req.body.username, 40));
  if (!u) throw new HttpError(404, 'No user with that username');
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM list_members WHERE user_id = ?').get(u.id).p;
  db.prepare('INSERT OR IGNORE INTO list_members (list_id, user_id, position) VALUES (?, ?, ?)').run(l.id, u.id, pos);
  notifyList(l.id);
  res.json({ ok: true });
}));

app.delete('/api/lists/:id/members/:userId', auth, wrap((req, res) => {
  const l = requireMember(req.user.id, req.params.id);
  const target = Number(req.params.userId);
  if (l.owner_id !== req.user.id && target !== req.user.id) throw new HttpError(403, 'Only the owner can remove others');
  if (target === l.owner_id) throw new HttpError(400, "Owner can't be removed; delete the list instead");
  const members = listMemberIds(l.id);
  db.prepare('DELETE FROM list_members WHERE list_id = ? AND user_id = ?').run(l.id, target);
  db.prepare('UPDATE tasks SET assigned_to = NULL WHERE list_id = ? AND assigned_to = ?').run(l.id, target);
  notifyUsers(members);
  res.json({ ok: true });
}));

// ---------- tasks ----------
function hydrate(tasks) {
  if (!tasks.length) return tasks;
  const ids = tasks.map((t) => t.id);
  const subs = db.prepare(`SELECT * FROM subtasks WHERE task_id IN (${ids.map(() => '?').join(',')}) ORDER BY position, id`).all(...ids);
  const byTask = {};
  for (const s of subs) (byTask[s.task_id] ||= []).push(s);
  for (const t of tasks) t.subtasks = byTask[t.id] || [];
  return tasks;
}

const TASK_SELECT = `SELECT t.*, l.name AS list_name, u.username AS assigned_name
  FROM tasks t JOIN list_members m ON m.list_id = t.list_id AND m.user_id = ?
  JOIN lists l ON l.id = t.list_id LEFT JOIN users u ON u.id = t.assigned_to`;

app.get('/api/tasks', auth, wrap((req, res) => {
  const uid = req.user.id;
  const { list, smart, q } = req.query;
  let rows;
  if (list) {
    requireMember(uid, list);
    rows = db.prepare(`${TASK_SELECT} WHERE t.list_id = ? AND t.completed = 0 ORDER BY t.position, t.id`).all(uid, list);
    rows = rows.concat(db.prepare(`${TASK_SELECT} WHERE t.list_id = ? AND t.completed = 1 ORDER BY t.completed_at DESC LIMIT 200`).all(uid, list));
  } else if (smart === 'starred') {
    rows = db.prepare(`${TASK_SELECT} WHERE t.starred = 1 AND t.completed = 0 ORDER BY t.due_date IS NULL, t.due_date, t.position`).all(uid);
  } else if (smart === 'today') {
    rows = db.prepare(`${TASK_SELECT} WHERE t.due_date IS NOT NULL AND t.due_date <= ? AND t.completed = 0 ORDER BY t.due_date, t.position`).all(uid, today());
  } else if (smart === 'week') {
    rows = db.prepare(`${TASK_SELECT} WHERE t.due_date IS NOT NULL AND t.due_date <= ? AND t.completed = 0 ORDER BY t.due_date, t.position`).all(uid, addDays(today(), 6));
  } else if (smart === 'assigned') {
    rows = db.prepare(`${TASK_SELECT} WHERE t.assigned_to = ? AND t.completed = 0 ORDER BY t.due_date IS NULL, t.due_date, t.position`).all(uid, uid);
  } else if (smart === 'search') {
    const like = `%${str(q, 100).replace(/[%_]/g, '')}%`;
    rows = db.prepare(`${TASK_SELECT} WHERE (t.title LIKE ? OR t.notes LIKE ?) ORDER BY t.completed, t.updated_at DESC LIMIT 200`).all(uid, like, like);
  } else throw new HttpError(400, 'Specify list or smart');
  res.json({ tasks: hydrate(rows), today: today() });
}));

app.post('/api/tasks', auth, wrap((req, res) => {
  const listId = req.body.list_id;
  requireMember(req.user.id, listId);
  const title = str(req.body.title, 500);
  if (!title) throw new HttpError(400, 'Title required');
  const pos = db.prepare('SELECT COALESCE(MIN(position), 0) - 1 AS p FROM tasks WHERE list_id = ? AND completed = 0').get(listId).p; // new tasks on top
  const id = db.prepare(`INSERT INTO tasks (list_id, title, starred, due_date, position, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(listId, title, bool(req.body.starred), isDate(req.body.due_date) ? req.body.due_date : null, pos, req.user.id).lastInsertRowid;
  notifyList(listId);
  res.json(hydrate(db.prepare(`${TASK_SELECT} WHERE t.id = ?`).all(req.user.id, id))[0]);
}));

app.put('/api/tasks/order', auth, wrap((req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const lists = new Set();
  db.transaction(() => ids.forEach((id, i) => {
    const t = requireTask(req.user.id, id);
    lists.add(t.list_id);
    db.prepare('UPDATE tasks SET position = ? WHERE id = ?').run(i, id);
  }))();
  lists.forEach(notifyList);
  res.json({ ok: true });
}));

app.get('/api/tasks/:id', auth, wrap((req, res) => {
  const t = requireTask(req.user.id, req.params.id);
  res.json(hydrate(db.prepare(`${TASK_SELECT} WHERE t.id = ?`).all(req.user.id, t.id))[0]);
}));

app.put('/api/tasks/:id', auth, wrap((req, res) => {
  const t = requireTask(req.user.id, req.params.id);
  const b = req.body, sets = {};
  if ('title' in b) { const v = str(b.title, 500); if (!v) throw new HttpError(400, 'Title required'); sets.title = v; }
  if ('notes' in b) sets.notes = typeof b.notes === 'string' ? b.notes.slice(0, 20000) : '';
  if ('starred' in b) sets.starred = bool(b.starred);
  if ('due_date' in b) sets.due_date = isDate(b.due_date) ? b.due_date : null;
  if ('remind_at' in b) { sets.remind_at = b.remind_at ? toISO(b.remind_at) : null; sets.reminded = 0; }
  if ('recurrence' in b) { if (!RULES.includes(b.recurrence)) throw new HttpError(400, 'Bad recurrence'); sets.recurrence = b.recurrence; }
  let listId = t.list_id;
  if ('list_id' in b && Number(b.list_id) !== t.list_id) {
    requireMember(req.user.id, b.list_id);
    sets.list_id = listId = Number(b.list_id);
  }
  if ('assigned_to' in b) {
    if (b.assigned_to == null) sets.assigned_to = null;
    else if (!listMemberIds(listId).includes(Number(b.assigned_to))) throw new HttpError(400, 'Assignee must be a list member');
    else sets.assigned_to = Number(b.assigned_to);
  }
  if (sets.list_id && !('assigned_to' in sets) && t.assigned_to && !listMemberIds(listId).includes(t.assigned_to)) sets.assigned_to = null;
  if ('recurrence' in sets && sets.recurrence && !(sets.due_date ?? t.due_date)) sets.due_date = today();
  const keys = Object.keys(sets);
  if (keys.length) {
    db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ ...sets, id: t.id });
  }
  notifyList(t.list_id); if (listId !== t.list_id) notifyList(listId);
  res.json(hydrate(db.prepare(`${TASK_SELECT} WHERE t.id = ?`).all(req.user.id, t.id))[0]);
}));

app.post('/api/tasks/:id/toggle', auth, wrap((req, res) => {
  const t = requireTask(req.user.id, req.params.id);
  let rolled = false;
  if (!t.completed && t.recurrence) {
    // Recurring: log nothing, just roll forward to the next occurrence and reset subtasks.
    const n = nextOccurrence(t);
    db.transaction(() => {
      db.prepare(`UPDATE tasks SET due_date = ?, remind_at = ?, reminded = 0, updated_at = datetime('now') WHERE id = ?`).run(n.due_date, n.remind_at, t.id);
      db.prepare('UPDATE subtasks SET completed = 0 WHERE task_id = ?').run(t.id);
    })();
    rolled = true;
  } else if (!t.completed) {
    db.prepare(`UPDATE tasks SET completed = 1, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(t.id);
  } else {
    const pos = db.prepare('SELECT COALESCE(MIN(position), 0) - 1 AS p FROM tasks WHERE list_id = ? AND completed = 0').get(t.list_id).p;
    db.prepare(`UPDATE tasks SET completed = 0, completed_at = NULL, position = ?, updated_at = datetime('now') WHERE id = ?`).run(pos, t.id);
  }
  notifyList(t.list_id);
  res.json({ rolled, task: hydrate(db.prepare(`${TASK_SELECT} WHERE t.id = ?`).all(req.user.id, t.id))[0] });
}));

app.delete('/api/tasks/:id', auth, wrap((req, res) => {
  const t = requireTask(req.user.id, req.params.id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
  notifyList(t.list_id);
  res.json({ ok: true });
}));

app.delete('/api/lists/:id/completed', auth, wrap((req, res) => {
  const l = requireMember(req.user.id, req.params.id);
  db.prepare('DELETE FROM tasks WHERE list_id = ? AND completed = 1').run(l.id);
  notifyList(l.id);
  res.json({ ok: true });
}));

// ---------- subtasks ----------
app.post('/api/tasks/:id/subtasks', auth, wrap((req, res) => {
  const t = requireTask(req.user.id, req.params.id);
  const title = str(req.body.title, 500);
  if (!title) throw new HttpError(400, 'Title required');
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM subtasks WHERE task_id = ?').get(t.id).p;
  const id = db.prepare('INSERT INTO subtasks (task_id, title, position) VALUES (?, ?, ?)').run(t.id, title, pos).lastInsertRowid;
  notifyList(t.list_id);
  res.json(db.prepare('SELECT * FROM subtasks WHERE id = ?').get(id));
}));

function requireSub(userId, subId) {
  const s = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(subId);
  if (!s) throw new HttpError(404, 'Subtask not found');
  return { sub: s, task: requireTask(userId, s.task_id) };
}
app.put('/api/subtasks/:id', auth, wrap((req, res) => {
  const { sub, task } = requireSub(req.user.id, req.params.id);
  const title = 'title' in req.body ? str(req.body.title, 500) || sub.title : sub.title;
  const completed = 'completed' in req.body ? bool(req.body.completed) : sub.completed;
  db.prepare('UPDATE subtasks SET title = ?, completed = ? WHERE id = ?').run(title, completed, sub.id);
  notifyList(task.list_id);
  res.json(db.prepare('SELECT * FROM subtasks WHERE id = ?').get(sub.id));
}));
app.delete('/api/subtasks/:id', auth, wrap((req, res) => {
  const { sub, task } = requireSub(req.user.id, req.params.id);
  db.prepare('DELETE FROM subtasks WHERE id = ?').run(sub.id);
  notifyList(task.list_id);
  res.json({ ok: true });
}));

// ---------- push ----------
app.get('/api/push/key', auth, (req, res) => res.json({ publicKey: vapid.publicKey }));
app.post('/api/push/subscribe', auth, wrap((req, res) => {
  const s = req.body;
  if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth) throw new HttpError(400, 'Bad subscription');
  db.prepare(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(req.user.id, s.endpoint, s.keys.p256dh, s.keys.auth);
  res.json({ ok: true });
}));
app.post('/api/push/unsubscribe', auth, wrap((req, res) => {
  db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(String(req.body.endpoint || ''), req.user.id);
  res.json({ ok: true });
}));
app.post('/api/push/test', auth, wrap(async (req, res) => {
  const subs = db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').get(req.user.id).n;
  const errors = [];
  const sent = await pushToUser(req.user.id, { title: 'Wunderlost', body: 'Notifications are working.', url: '/' }, errors);
  res.json({ subs, sent, errors });
}));

async function pushToUser(userId, payload, errors = []) {
  const subs = db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(userId);
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600 });
      sent++;
    } catch (e) {
      const msg = `${e.statusCode || ''} ${e.body || e.message}`.trim();
      errors.push(msg);
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id);
      console.error('push failed', msg);
    }
  }));
  return sent;
}

// Reminder loop: every 20s, fire anything due. Assigned tasks only ping the assignee;
// unassigned tasks ping everyone on the list.
async function reminderTick() {
  const due = db.prepare(`SELECT t.*, l.name AS list_name FROM tasks t JOIN lists l ON l.id = t.list_id
    WHERE t.reminded = 0 AND t.completed = 0 AND t.remind_at IS NOT NULL AND t.remind_at <= ?`).all(new Date().toISOString());
  for (const t of due) {
    db.prepare('UPDATE tasks SET reminded = 1 WHERE id = ?').run(t.id);
    const targets = t.assigned_to ? [t.assigned_to] : listMemberIds(t.list_id);
    const payload = { title: t.title, body: t.list_name + (t.notes ? ' — ' + t.notes.slice(0, 120) : ''), url: `/#task/${t.id}`, tag: `task-${t.id}` };
    for (const uid of targets) await pushToUser(uid, payload);
  }
}
setInterval(() => reminderTick().catch((e) => console.error('reminder loop', e)), 20000);
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600000);

// ---------- static + errors ----------
// Service worker with a per-startup cache version, so every redeploy makes clients fetch fresh assets.
const CACHE_VERSION = `${require('./package.json').version}-${Date.now().toString(36)}`;
const swSource = require('fs').readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8').replace(/__CACHE_VERSION__/g, CACHE_VERSION);
app.get('/sw.js', (req, res) => {
  res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.send(swSource);
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, p) => { if (p.endsWith('sw.js') || p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); },
}));
app.get('/healthz', (req, res) => res.send('ok'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => console.log(`Wunderlost listening on :${PORT} (TZ=${process.env.TZ || 'system'})`));
