// Wunderlost — self-hosted to-do lists. Copyright (C) 2026 Matt Hornish.
// Licensed under the GNU AGPL v3 or later; see LICENSE. Provided as-is, without warranty.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { hashPassword, verifyPassword, needsRehash, dummyVerify } = require('./password');
const webpush = require('web-push');
const db = require('./db');
const { RULES, today, addDays, nextOccurrence } = require('./recur');

const PORT = Number(process.env.PORT || 3000);
const ALLOW_REGISTRATION = /^(1|true|yes)$/i.test(process.env.ALLOW_REGISTRATION || '');
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 90);
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const VERSION = require('./package.json').version;
// AGPL-3.0 section 13: users of a network service get a link to its source.
// If you run a modified version, point this at your own fork.
const SOURCE_URL = process.env.SOURCE_URL || 'https://github.com/matthornish/Wunderlost';

// ---------- Web push (VAPID keys generated once, stored in DB) ----------
let vapid = { publicKey: db.getSetting('vapid_public'), privateKey: db.getSetting('vapid_private') };
if (!vapid.publicKey || !vapid.privateKey) {
  vapid = webpush.generateVAPIDKeys();
  db.setSetting('vapid_public', vapid.publicKey);
  db.setSetting('vapid_private', vapid.privateKey);
}
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

const app = express();
// Which proxies may set X-Forwarded-For. Default: loopback and private networks (a reverse
// proxy on the same host or LAN). Set TRUST_PROXY to your proxy's IP for a tighter setting.
// Trusting everything would let clients fake their IP and dodge the sign-in limits.
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');
app.disable('x-powered-by');
const jsonSmall = express.json({ limit: '256kb' });
const jsonPhoto = express.json({ limit: '12mb' }); // background photo upload only
app.use((req, res, next) => (req.path === '/api/me/background/photo' ? next() : jsonSmall(req, res, next))); // photo: parsed after auth

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = (fn) => (req, res, next) => { try { const r = fn(req, res, next); if (r && r.catch) r.catch(next); } catch (e) { next(e); } };
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bool = (v) => (v ? 1 : 0);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const toISO = (v) => { const d = new Date(v); if (isNaN(d)) throw new HttpError(400, 'Bad date'); return d.toISOString(); };

// Only our cookie is read; a malformed cookie from another app on the domain is ignored.
function sessionToken(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === 'wl_session') {
      const v = part.slice(i + 1).trim();
      return /^[A-Za-z0-9_-]{20,100}$/.test(v) ? v : null;
    }
  }
  return null;
}
const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');

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
  const token = sessionToken(req);
  if (token) {
    const row = db.prepare(`SELECT u.id, u.username, u.is_admin, u.background, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(tokenHash(token));
    if (row && row.expires_at > Date.now()) req.user = { id: row.id, username: row.username, is_admin: !!row.is_admin, background: row.background };
  }
  next();
});
const auth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Not logged in' }));
const admin = (req, res, next) => (req.user?.is_admin ? next() : res.status(403).json({ error: 'Admin only' }));

// Generous caps so one account can't fill the disk or make lists unloadable.
const LIMITS = { lists: 500, tasks: 5000, subtasks: 200 };

// ---------- security headers ----------
// Everything is served from this origin; the only inline code is style attributes (list colors,
// backgrounds). No framing (clickjacking), no MIME sniffing, no referrers to other sites.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self'", "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'",
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  if (req.path.startsWith('/api/') && req.path !== '/api/me/background/photo') res.set('Cache-Control', 'no-store');
  next();
});

// ---------- realtime (SSE) ----------
const clients = new Map(); // userId -> Set(res)
function notifyUsers(userIds, payload = { type: 'change' }) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const uid of new Set(userIds)) for (const res of clients.get(uid) || []) res.write(msg);
}
// Active members only; invited users get no data, no live updates and no reminders until they accept.
const listMemberIds = (listId) => db.prepare("SELECT user_id FROM list_members WHERE list_id = ? AND status = 'active'").all(listId).map((r) => r.user_id);
const notifyList = (listId) => notifyUsers(listMemberIds(listId));

app.get('/api/events', auth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  if (!clients.has(req.user.id)) clients.set(req.user.id, new Set());
  const mine = clients.get(req.user.id);
  if (mine.size >= 10) { const oldest = mine.values().next().value; mine.delete(oldest); oldest.end(); } // cap open tabs/devices per user
  mine.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    const set = clients.get(req.user.id);
    set?.delete(res);
    if (set && !set.size) clients.delete(req.user.id);
  });
});

// ---------- access checks ----------
function requireMember(userId, listId) {
  const row = db.prepare("SELECT l.* FROM lists l JOIN list_members m ON m.list_id = l.id AND m.status = 'active' WHERE l.id = ? AND m.user_id = ?").get(listId, userId);
  if (!row) throw new HttpError(404, 'List not found');
  return row;
}
function requireTask(userId, taskId) {
  const t = db.prepare("SELECT t.* FROM tasks t JOIN list_members m ON m.list_id = t.list_id AND m.status = 'active' WHERE t.id = ? AND m.user_id = ?").get(taskId, userId);
  if (!t) throw new HttpError(404, 'Task not found');
  return t;
}

// ---------- auth ----------
// Failure counters per client IP and per username. The username limit stops guessing one
// account from many IPs; existing sign-ins on other devices keep working while it's locked.
function limiter(max, windowMs) {
  const m = new Map();
  return {
    blocked: (k) => { const a = m.get(k); return !!a && a.until > Date.now() && a.count >= max; },
    hit: (k) => { const a = m.get(k); if (!a || a.until < Date.now()) m.set(k, { count: 1, until: Date.now() + windowMs }); else a.count++; },
    clear: (k) => m.delete(k),
    prune: () => { const now = Date.now(); for (const [k, a] of m) if (a.until < now) m.delete(k); },
  };
}
const ipFails = limiter(10, 10 * 60000);
const userFails = limiter(10, 15 * 60000);
const registerHits = limiter(5, 60 * 60000);
setInterval(() => { ipFails.prune(); userFails.prune(); registerHits.prune(); }, 5 * 60000).unref();
const TOO_MANY = 'Too many attempts, try again in a few minutes';

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (password.length > 256) throw new HttpError(400, 'Password must be 256 characters or fewer');
  return password;
}

// First-run protection: until the first account exists, creating it needs a one-time setup
// code printed in the container log, so whoever finds a fresh instance first can't claim it.
let setupCode = null;
function ensureSetupCode() {
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) { setupCode = null; return; }
  if (!setupCode) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    setupCode = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    console.log(`\n  First-run setup code: ${setupCode}\n  Enter it on the sign-up page to create the admin account.\n`);
  }
}
ensureSetupCode();

async function createUser(username, password, isAdmin) {
  username = str(username, 40);
  if (!/^[A-Za-z0-9_.-]{2,40}$/.test(username)) throw new HttpError(400, 'Username: 2-40 letters, numbers, . _ -');
  checkPassword(password);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'Username taken');
  const hash = await hashPassword(password);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'Username taken');
  return db.transaction(() => {
    const uid = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)').run(username, hash, bool(isAdmin)).lastInsertRowid;
    const lid = db.prepare('INSERT INTO lists (name, owner_id, is_inbox) VALUES (?, ?, 1)').run('Inbox', uid).lastInsertRowid;
    db.prepare('INSERT INTO list_members (list_id, user_id, position) VALUES (?, ?, 0)').run(lid, uid);
    return uid;
  })();
}

function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash(token), userId, Date.now() + SESSION_DAYS * 86400000);
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}

app.get('/api/auth/status', (req, res) => {
  const hasUsers = !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
  let user = req.user || null;
  if (user) {
    const last = db.prepare('SELECT value FROM settings WHERE key = ?').get(`last_photo_${user.id}`)?.value;
    user = { ...user, photo: (user.background.startsWith('photo:') ? user.background : last || '').replace(/^photo:/, '') };
  }
  res.json({ user, setupNeeded: !hasUsers, registrationOpen: !hasUsers || ALLOW_REGISTRATION, version: VERSION, source: SOURCE_URL });
});

app.post('/api/auth/register', wrap(async (req, res) => {
  if (registerHits.blocked(req.ip)) throw new HttpError(429, TOO_MANY);
  registerHits.hit(req.ip);
  const first = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
  if (!first && !ALLOW_REGISTRATION) throw new HttpError(403, 'Registration is closed. Ask the admin for an account.');
  if (first) {
    ensureSetupCode();
    const given = String(req.body.setup_code || '').trim().toUpperCase();
    const ok = given.length === setupCode.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(setupCode));
    if (!ok) throw new HttpError(403, 'Wrong setup code. Find it in the container log (docker logs wunderlost).');
  }
  const uid = await createUser(req.body.username, req.body.password, first);
  if (first) setupCode = null;
  startSession(req, res, uid);
  res.json({ ok: true });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const username = str(req.body.username, 40).toLowerCase();
  const password = String(req.body.password || '').slice(0, 256);
  if (ipFails.blocked(req.ip) || userFails.blocked(username)) throw new HttpError(429, TOO_MANY);
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = u ? await verifyPassword(password, u.password_hash) : await dummyVerify(password);
  if (!ok) {
    ipFails.hit(req.ip); userFails.hit(username);
    throw new HttpError(401, 'Wrong username or password');
  }
  ipFails.clear(req.ip); userFails.clear(username);
  if (needsRehash(u.password_hash)) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), u.id);
  startSession(req, res, u.id);
  res.json({ ok: true });
}));

app.post('/api/auth/logout', (req, res) => {
  const token = sessionToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash(token));
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

app.put('/api/auth/password', auth, wrap(async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (userFails.blocked(u.username.toLowerCase())) throw new HttpError(429, TOO_MANY);
  if (!(await verifyPassword(String(req.body.current || '').slice(0, 256), u.password_hash))) {
    userFails.hit(u.username.toLowerCase());
    throw new HttpError(400, 'Current password is wrong');
  }
  checkPassword(req.body.password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(req.body.password), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(u.id, tokenHash(sessionToken(req)));
  res.json({ ok: true });
}));

// ---------- admin: users ----------
app.get('/api/users', auth, admin, (req, res) => {
  res.json(db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY username').all());
});
app.post('/api/users', auth, admin, wrap(async (req, res) => {
  const id = await createUser(req.body.username, req.body.password, !!req.body.is_admin);
  res.json({ id });
}));
app.put('/api/users/:id/password', auth, admin, wrap(async (req, res) => {
  checkPassword(req.body.password);
  const r = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(req.body.password), req.params.id);
  if (!r.changes) throw new HttpError(404, 'No such user');
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
  res.json({ ok: true });
}));
app.delete('/api/users/:id', auth, admin, wrap((req, res) => {
  if (Number(req.params.id) === req.user.id) throw new HttpError(400, "You can't delete yourself");
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id); // cascades to their owned lists
  for (const f of fs.readdirSync(BG_DIR)) if (f.startsWith(`${Number(req.params.id)}-`)) fs.rm(path.join(BG_DIR, f), { force: true }, () => {});
  db.prepare('DELETE FROM settings WHERE key = ?').run(`last_photo_${Number(req.params.id)}`);
  res.json({ ok: true });
}));

// ---------- lists ----------
function listsFor(userId) {
  const lists = db.prepare(`
    SELECT l.id, l.name, l.owner_id, l.is_inbox, l.color, l.emoji, m.position,
      (SELECT COUNT(*) FROM tasks t WHERE t.list_id = l.id AND t.completed = 0) AS open_count
    FROM lists l JOIN list_members m ON m.list_id = l.id AND m.user_id = ? AND m.status = 'active'
    ORDER BY l.is_inbox DESC, m.position, l.id`).all(userId);
  const memStmt = db.prepare("SELECT u.id, u.username FROM list_members m JOIN users u ON u.id = m.user_id WHERE m.list_id = ? AND m.status = 'active' ORDER BY u.username");
  const invStmt = db.prepare("SELECT u.id, u.username FROM list_members m JOIN users u ON u.id = m.user_id WHERE m.list_id = ? AND m.status = 'invited' ORDER BY u.username");
  for (const l of lists) {
    l.members = memStmt.all(l.id);
    if (l.owner_id === userId) l.invited = invStmt.all(l.id); // only the owner sees pending invites
  }
  return lists;
}
const invitesFor = (userId) => db.prepare(`
  SELECT l.id, l.name, l.emoji, l.color, o.username AS owner, (SELECT COUNT(*) FROM tasks t WHERE t.list_id = l.id AND t.completed = 0) AS open_count
  FROM list_members m JOIN lists l ON l.id = m.list_id JOIN users o ON o.id = l.owner_id
  WHERE m.user_id = ? AND m.status = 'invited' ORDER BY l.name`).all(userId);

app.get('/api/lists', auth, (req, res) => {
  const t = today(), week = addDays(t, 6);
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN t.starred = 1 THEN 1 ELSE 0 END) AS starred,
      SUM(CASE WHEN t.due_date IS NOT NULL AND t.due_date <= ? THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN t.due_date IS NOT NULL AND t.due_date <= ? THEN 1 ELSE 0 END) AS week,
      SUM(CASE WHEN t.assigned_to = ? THEN 1 ELSE 0 END) AS assigned
    FROM tasks t JOIN list_members m ON m.list_id = t.list_id AND m.user_id = ? AND m.status = 'active'
    WHERE t.completed = 0`).get(t, week, req.user.id, req.user.id);
  res.json({ lists: listsFor(req.user.id), smart: counts, invites: invitesFor(req.user.id) });
});

app.post('/api/lists', auth, wrap((req, res) => {
  const name = str(req.body.name, 100);
  if (!name) throw new HttpError(400, 'Name required');
  if (db.prepare('SELECT COUNT(*) AS n FROM lists WHERE owner_id = ?').get(req.user.id).n >= LIMITS.lists) throw new HttpError(400, `You can have up to ${LIMITS.lists} lists`);
  const id = db.transaction(() => {
    const style = {};
    listStyle(req.body, style);
    const id = db.prepare('INSERT INTO lists (name, owner_id, color, emoji) VALUES (?, ?, ?, ?)').run(name, req.user.id, style.color || '', style.emoji || '').lastInsertRowid;
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

const LIST_COLORS = ['', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];
// Emoji: keep at most 2 user-perceived characters, nothing that looks like markup.
function cleanEmoji(v) {
  const t = str(v, 32).replace(/[<>&"'`]/g, '');
  const seg = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter().segment(t)].map((x) => x.segment) : [...t];
  const pict = seg.filter((x) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(x));
  return (pict.length ? pict : seg.filter((x) => x.trim())).slice(0, 2).join('');
}
function listStyle(body, sets) {
  if ('color' in body) {
    if (!LIST_COLORS.includes(body.color)) throw new HttpError(400, 'Unknown color');
    sets.color = body.color;
  }
  if ('emoji' in body) sets.emoji = cleanEmoji(body.emoji);
}

app.put('/api/lists/:id', auth, wrap((req, res) => {
  const l = requireMember(req.user.id, req.params.id);
  if (l.is_inbox) throw new HttpError(400, "Inbox can't be edited");
  if (l.owner_id !== req.user.id) throw new HttpError(403, 'Only the list owner can rename or restyle it');
  const sets = {};
  if ('name' in req.body) {
    sets.name = str(req.body.name, 100);
    if (!sets.name) throw new HttpError(400, 'Name required');
  }
  listStyle(req.body, sets);
  const keys = Object.keys(sets);
  if (keys.length) db.prepare(`UPDATE lists SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...sets, id: l.id });
  notifyList(l.id);
  res.json({ ok: true });
}));

app.delete('/api/lists/:id', auth, wrap((req, res) => {
  const l = requireMember(req.user.id, req.params.id);
  if (l.is_inbox) throw new HttpError(400, "Inbox can't be deleted");
  const members = db.prepare('SELECT user_id FROM list_members WHERE list_id = ?').all(l.id).map((r) => r.user_id); // incl. pending invites
  if (l.owner_id === req.user.id) db.prepare('DELETE FROM lists WHERE id = ?').run(l.id);
  else db.prepare('DELETE FROM list_members WHERE list_id = ? AND user_id = ?').run(l.id, req.user.id); // leave shared list
  notifyUsers(members);
  res.json({ ok: true });
}));

// Only the owner invites. The invitee sees the list's name and owner, and must accept before
// they can see its to-dos or get its reminders. The reply is the same whether or not the
// username exists, so this can't be used to discover accounts.
app.post('/api/lists/:id/members', auth, wrap((req, res) => {
  const l = requireMember(req.user.id, req.params.id);
  if (l.is_inbox) throw new HttpError(400, "Inbox can't be shared");
  if (l.owner_id !== req.user.id) throw new HttpError(403, 'Only the list owner can invite people');
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(str(req.body.username, 40));
  if (u && u.id !== req.user.id) {
    const pending = db.prepare("SELECT COUNT(*) AS n FROM list_members WHERE list_id = ? AND status = 'invited'").get(l.id).n;
    if (pending >= 20) throw new HttpError(429, 'Too many pending invites on this list');
    const r = db.prepare("INSERT OR IGNORE INTO list_members (list_id, user_id, position, status, invited_by) VALUES (?, ?, 0, 'invited', ?)").run(l.id, u.id, req.user.id);
    if (r.changes) notifyUsers([u.id]);
  }
  notifyUsers([req.user.id]);
  res.json({ ok: true, message: 'If that username exists, they have been invited.' });
}));

app.post('/api/invites/:listId/accept', auth, wrap((req, res) => {
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM list_members WHERE user_id = ?').get(req.user.id).p;
  const r = db.prepare("UPDATE list_members SET status = 'active', position = ? WHERE list_id = ? AND user_id = ? AND status = 'invited'").run(pos, req.params.listId, req.user.id);
  if (!r.changes) throw new HttpError(404, 'Invite not found');
  notifyList(Number(req.params.listId));
  res.json({ ok: true });
}));

app.post('/api/invites/:listId/decline', auth, wrap((req, res) => {
  const owner = db.prepare('SELECT owner_id FROM lists WHERE id = ?').get(req.params.listId)?.owner_id;
  const r = db.prepare("DELETE FROM list_members WHERE list_id = ? AND user_id = ? AND status = 'invited'").run(req.params.listId, req.user.id);
  if (!r.changes) throw new HttpError(404, 'Invite not found');
  notifyUsers([req.user.id, owner]);
  res.json({ ok: true });
}));

app.delete('/api/lists/:id/members/:userId', auth, wrap((req, res) => {
  const l = requireMember(req.user.id, req.params.id);
  const target = Number(req.params.userId);
  if (l.owner_id !== req.user.id && target !== req.user.id) throw new HttpError(403, 'Only the owner can remove others');
  if (target === l.owner_id) throw new HttpError(400, "Owner can't be removed; delete the list instead");
  const members = [...listMemberIds(l.id), target];
  db.prepare('DELETE FROM list_members WHERE list_id = ? AND user_id = ?').run(l.id, target);
  db.prepare('UPDATE tasks SET assigned_to = NULL WHERE list_id = ? AND assigned_to = ?').run(l.id, target);
  notifyUsers(members);
  res.json({ ok: true });
}));

// ---------- tasks ----------
function hydrate(tasks) {
  if (!tasks.length) return tasks;
  const ids = tasks.map((t) => t.id);
  const subs = [];
  for (let i = 0; i < ids.length; i += 500) { // stay well under SQLite's bound-parameter limit
    const chunk = ids.slice(i, i + 500);
    subs.push(...db.prepare(`SELECT * FROM subtasks WHERE task_id IN (${chunk.map(() => '?').join(',')}) ORDER BY position, id`).all(...chunk));
  }
  const byTask = {};
  for (const s of subs) (byTask[s.task_id] ||= []).push(s);
  for (const t of tasks) t.subtasks = byTask[t.id] || [];
  return tasks;
}

const TASK_SELECT = `SELECT t.*, l.name AS list_name, u.username AS assigned_name
  FROM tasks t JOIN list_members m ON m.list_id = t.list_id AND m.user_id = ? AND m.status = 'active'
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
  if (db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE list_id = ?').get(listId).n >= LIMITS.tasks) throw new HttpError(400, `A list can hold up to ${LIMITS.tasks} to-dos. Delete some completed ones first.`);
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

app.post('/api/tasks/:id/duplicate', auth, wrap((req, res) => {
  const t = requireTask(req.user.id, req.params.id);
  if (db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE list_id = ?').get(t.list_id).n >= LIMITS.tasks) throw new HttpError(400, `A list can hold up to ${LIMITS.tasks} to-dos. Delete some completed ones first.`);
  const newId = db.transaction(() => {
    const pos = db.prepare('SELECT COALESCE(MIN(position), 0) - 1 AS p FROM tasks WHERE list_id = ? AND completed = 0').get(t.list_id).p;
    const id = db.prepare(`INSERT INTO tasks (list_id, title, notes, due_date, recurrence, starred, assigned_to, position, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(t.list_id, t.title, t.notes, t.due_date, t.recurrence, t.starred, t.assigned_to, pos, req.user.id).lastInsertRowid;
    const ins = db.prepare('INSERT INTO subtasks (task_id, title, completed, position) VALUES (?, ?, 0, ?)');
    for (const st of db.prepare('SELECT * FROM subtasks WHERE task_id = ? ORDER BY position, id').all(t.id)) ins.run(id, st.title, st.position);
    return id;
  })();
  notifyList(t.list_id);
  res.json(hydrate(db.prepare(`${TASK_SELECT} WHERE t.id = ?`).all(req.user.id, newId))[0]);
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
  if (db.prepare('SELECT COUNT(*) AS n FROM subtasks WHERE task_id = ?').get(t.id).n >= LIMITS.subtasks) throw new HttpError(400, `A to-do can have up to ${LIMITS.subtasks} subtasks`);
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

// ---------- background (per user, synced across devices) ----------
const BG_DIR = path.join(db.DATA_DIR, 'backgrounds');
fs.mkdirSync(BG_DIR, { recursive: true });
const SCENE_COUNT = 8;
const photoFile = (bg) => (bg?.startsWith('photo:') ? path.join(BG_DIR, path.basename(bg.slice(6))) : null);

app.put('/api/me/background', auth, wrap((req, res) => {
  const v = String(req.body.background || '');
  const m = v.match(/^scene:(\d+)$/);
  let next;
  if (m && Number(m[1]) < SCENE_COUNT) next = v;
  else if (v === 'photo') {
    const cur = db.prepare('SELECT background FROM users WHERE id = ?').get(req.user.id).background;
    const last = db.prepare("SELECT value FROM settings WHERE key = ?").get(`last_photo_${req.user.id}`)?.value;
    next = cur.startsWith('photo:') ? cur : last && fs.existsSync(photoFile(last)) ? last : null;
    if (!next) throw new HttpError(400, 'Upload a photo first');
  } else throw new HttpError(400, 'Unknown background');
  db.prepare('UPDATE users SET background = ? WHERE id = ?').run(next, req.user.id);
  notifyUsers([req.user.id], { type: 'me' });
  res.json({ background: next });
}));

app.post('/api/me/background/photo', auth, jsonPhoto, wrap((req, res) => {
  const m = String(req.body.image || '').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new HttpError(400, 'Send a JPEG, PNG or WebP image');
  const buf = Buffer.from(m[2], 'base64');
  const magic = { jpeg: [0xff, 0xd8, 0xff], png: [0x89, 0x50, 0x4e, 0x47], webp: [0x52, 0x49, 0x46, 0x46] }[m[1]];
  if (buf.length < 100 || !magic.every((b, i) => buf[i] === b)) throw new HttpError(400, "That file isn't a valid image");
  if (buf.length > 8 * 1024 * 1024) throw new HttpError(413, 'Photo is too large (8 MB max)');
  const name = `${req.user.id}-${crypto.randomBytes(6).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(BG_DIR, name), buf);
  const old = photoFile(db.prepare('SELECT background FROM users WHERE id = ?').get(req.user.id).background)
    || photoFile(db.prepare('SELECT value FROM settings WHERE key = ?').get(`last_photo_${req.user.id}`)?.value);
  const bg = `photo:${name}`;
  db.prepare('UPDATE users SET background = ? WHERE id = ?').run(bg, req.user.id);
  db.setSetting(`last_photo_${req.user.id}`, bg);
  if (old && old !== photoFile(bg)) fs.rm(old, { force: true }, () => {});
  notifyUsers([req.user.id], { type: 'me' });
  res.json({ background: bg });
}));

app.delete('/api/me/background/photo', auth, wrap((req, res) => {
  const cur = db.prepare('SELECT background FROM users WHERE id = ?').get(req.user.id).background;
  const last = db.prepare('SELECT value FROM settings WHERE key = ?').get(`last_photo_${req.user.id}`)?.value;
  for (const f of [photoFile(cur), photoFile(last)]) if (f) fs.rm(f, { force: true }, () => {});
  db.prepare("DELETE FROM settings WHERE key = ?").run(`last_photo_${req.user.id}`);
  if (cur.startsWith('photo:')) db.prepare("UPDATE users SET background = 'scene:0' WHERE id = ?").run(req.user.id);
  notifyUsers([req.user.id], { type: 'me' });
  res.json({ ok: true });
}));

app.get('/api/me/background/photo', auth, (req, res) => {
  const cur = req.user.background;
  const last = db.prepare('SELECT value FROM settings WHERE key = ?').get(`last_photo_${req.user.id}`)?.value;
  const f = photoFile(cur) || photoFile(last);
  if (!f || !fs.existsSync(f)) return res.status(404).json({ error: 'No photo' });
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(f);
});

// ---------- push ----------
app.get('/api/push/key', auth, (req, res) => res.json({ publicKey: vapid.publicKey }));
// Push endpoints must belong to a real browser push service. Without this, a signed-in user
// could register an internal URL and make the server send requests into the private network.
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com',
  ...(process.env.PUSH_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)];
const MAX_SUBS_PER_USER = 10;
function validPushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return false;
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || (u.port && u.port !== '443') || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}
const b64url = (v, max) => typeof v === 'string' && v.length >= 16 && v.length <= max && /^[A-Za-z0-9_-]+=*$/.test(v);

app.post('/api/push/subscribe', auth, wrap((req, res) => {
  const s = req.body;
  if (!validPushEndpoint(s?.endpoint)) throw new HttpError(400, "This browser's push service isn't supported");
  if (!b64url(s?.keys?.p256dh, 128) || !b64url(s?.keys?.auth, 64)) throw new HttpError(400, 'Bad subscription');
  db.transaction(() => {
    const existing = db.prepare('SELECT * FROM push_subs WHERE endpoint = ?').get(s.endpoint);
    if (existing && existing.user_id !== req.user.id) {
      // Same browser, different account: allowed only with the same keys (proof it's that browser).
      if (existing.p256dh !== s.keys.p256dh || existing.auth !== s.keys.auth) throw new HttpError(409, 'Subscription belongs to another account');
      db.prepare('UPDATE push_subs SET user_id = ? WHERE id = ?').run(req.user.id, existing.id);
    } else if (existing) {
      db.prepare('UPDATE push_subs SET p256dh = ?, auth = ? WHERE id = ?').run(s.keys.p256dh, s.keys.auth, existing.id);
    } else {
      db.prepare('INSERT INTO push_subs (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)').run(req.user.id, s.endpoint, s.keys.p256dh, s.keys.auth);
    }
    // Keep only the newest few devices per user.
    db.prepare(`DELETE FROM push_subs WHERE user_id = ? AND id NOT IN (SELECT id FROM push_subs WHERE user_id = ? ORDER BY id DESC LIMIT ${MAX_SUBS_PER_USER})`).run(req.user.id, req.user.id);
  })();
  res.json({ ok: true });
}));
app.post('/api/push/unsubscribe', auth, wrap((req, res) => {
  db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(String(req.body.endpoint || ''), req.user.id);
  res.json({ ok: true });
}));
const testHits = new Map(); // userId -> [timestamps]
app.post('/api/push/test', auth, wrap(async (req, res) => {
  const now = Date.now(), recent = (testHits.get(req.user.id) || []).filter((t) => now - t < 60000);
  if (recent.length >= 5) throw new HttpError(429, 'Too many test notifications, wait a minute');
  testHits.set(req.user.id, [...recent, now]);
  const subs = db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').get(req.user.id).n;
  const errors = [];
  const sent = await pushToUser(req.user.id, { title: 'Wunderlost', body: 'Notifications are working.', url: '/' }, errors);
  res.json({ subs, sent, errors });
}));

async function pushToUser(userId, payload, errors = []) {
  const subs = db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(userId);
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    if (!validPushEndpoint(s.endpoint)) { db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id); return; }
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600, timeout: 10000 });
      sent++;
    } catch (e) {
      // Details go to the server log only; the browser just gets the status code.
      errors.push(e.statusCode ? `push service answered ${e.statusCode}` : "couldn't reach the push service");
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id);
      console.error('push failed', new URL(s.endpoint).hostname, e.statusCode || '', e.body || e.message);
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
setInterval(() => { const cut = Date.now() - 60000; for (const [k, v] of testHits) if (!v.some((t) => t > cut)) testHits.delete(k); }, 300000).unref();
setInterval(() => reminderTick().catch((e) => console.error('reminder loop', e)), 20000);
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600000);

// ---------- static + errors ----------
// Service worker with a per-startup cache version, so every redeploy makes clients fetch fresh assets.
const CACHE_VERSION = `${VERSION}-${Date.now().toString(36)}`;
const swSource = fs.readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8').replace(/__CACHE_VERSION__/g, CACHE_VERSION);
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

if (!process.env.VAPID_SUBJECT) console.warn('Warning: VAPID_SUBJECT is not set. Set it to a mailto: address you own, or Apple devices will reject push notifications.');
app.listen(PORT, () => console.log(`Wunderlost listening on :${PORT} (TZ=${process.env.TZ || 'system'})`));
