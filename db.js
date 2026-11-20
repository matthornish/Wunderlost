// Wunderlost — Copyright (C) 2026 Matt Hornish. AGPL-3.0-or-later; see LICENSE.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'wunderlost.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_inbox INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS list_members (
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (list_id, user_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  remind_at TEXT,
  reminded INTEGER NOT NULL DEFAULT 0,
  recurrence TEXT NOT NULL DEFAULT '',
  starred INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  position REAL NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_list ON tasks(list_id, completed);
CREATE INDEX IF NOT EXISTS idx_tasks_remind ON tasks(reminded, completed, remind_at);
CREATE TABLE IF NOT EXISTS subtasks (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Additive migrations: safe to run on every start against an existing database.
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('lists', 'color', "TEXT NOT NULL DEFAULT ''");
addColumn('lists', 'emoji', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'background', "TEXT NOT NULL DEFAULT 'scene:0'");
// Sharing needs consent: an invited user isn't a member until they accept.
addColumn('list_members', 'status', "TEXT NOT NULL DEFAULT 'active'");
addColumn('list_members', 'invited_by', 'INTEGER');
addColumn('tasks', 'repeat_day', 'INTEGER'); // day of month a monthly/yearly repeat returns to

// Sessions are stored as SHA-256 of the cookie token, so a leaked DB backup holds no live sessions.
// One-time migration: hash any plaintext tokens left from before.
if (!db.prepare("SELECT value FROM settings WHERE key = 'sessions_hashed'").get()) {
  const crypto = require('crypto');
  db.transaction(() => {
    for (const r of db.prepare('SELECT token FROM sessions').all()) {
      if (/^[0-9a-f]{64}$/.test(r.token)) continue;
      db.prepare('UPDATE sessions SET token = ? WHERE token = ?').run(crypto.createHash('sha256').update(r.token).digest('hex'), r.token);
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sessions_hashed', '1')").run();
  })();
}

db.DATA_DIR = DATA_DIR;
db.getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
db.setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

module.exports = db;
