// Wunderlost — Copyright (C) 2026 Matt Hornish. AGPL-3.0-or-later; see LICENSE.
// End-to-end API tests against a real server and a throwaway database.
// Run: npm test
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, client } = require('./helpers');

let srv, admin, bob, carol;

before(async () => {
  srv = await startServer();
  admin = client(srv.base, '203.0.113.1');
  bob = client(srv.base, '203.0.113.2');
  carol = client(srv.base, '203.0.113.3');
});
after(async () => { await srv?.stop(); });

const dbRead = () => new Database(path.join(srv.dataDir, 'wunderlost.db'), { readonly: true });

describe('first run', () => {
  test('status reports setup needed and the version', async () => {
    const r = await admin.get('/api/auth/status');
    assert.equal(r.status, 200);
    assert.equal(r.json.setupNeeded, true);
    assert.match(r.json.version, /^\d+\.\d+\.\d+$/);
    assert.ok(srv.setupCode, 'setup code printed to the log');
  });

  test('first account needs the setup code', async () => {
    const anon = client(srv.base, '198.51.100.1');
    assert.equal((await anon.post('/api/auth/register', { username: 'mallory', password: 'password123' })).status, 403);
    assert.equal((await anon.post('/api/auth/register', { username: 'mallory', password: 'password123', setup_code: 'AAAAA-BBBBB' })).status, 403);
  });

  test('right code (any case) creates the admin, then sign-up closes', async () => {
    const r = await admin.post('/api/auth/register', { username: 'admin', password: 'password123', setup_code: srv.setupCode.toLowerCase() });
    assert.equal(r.status, 200);
    const st = await admin.get('/api/auth/status');
    assert.equal(st.json.user.is_admin, true);
    const again = await client(srv.base, '198.51.100.2').post('/api/auth/register', { username: 'late', password: 'password123' });
    assert.equal(again.status, 403);
  });

  test('admin creates the other accounts', async () => {
    for (const u of ['bob', 'carol']) assert.equal((await admin.post('/api/users', { username: u, password: 'password123' })).status, 200);
    assert.equal((await bob.post('/api/auth/login', { username: 'bob', password: 'password123' })).status, 200);
    assert.equal((await carol.post('/api/auth/login', { username: 'CAROL', password: 'password123' })).status, 200, 'usernames are case-insensitive');
  });

  test('non-admins cannot manage users', async () => {
    assert.equal((await bob.get('/api/users')).status, 403);
    assert.equal((await bob.post('/api/users', { username: 'eve', password: 'password123' })).status, 403);
  });
});

describe('sign-in hardening', () => {
  test('wrong password is 401 and the same for unknown users', async () => {
    const c = client(srv.base, '192.0.2.50');
    assert.equal((await c.post('/api/auth/login', { username: 'admin', password: 'nope-nope' })).status, 401);
    assert.equal((await c.post('/api/auth/login', { username: 'ghost', password: 'nope-nope' })).status, 401);
  });

  test('per-username limit holds even when every attempt comes from a new IP', async () => {
    await admin.post('/api/users', { username: 'target', password: 'password123' });
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await client(srv.base, `192.0.2.${100 + i}`).post('/api/auth/login', { username: 'target', password: 'wrong-guess' })).status);
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(401));
    assert.deepEqual(codes.slice(10), [429, 429]);
  });

  test('spoofed X-Forwarded-For in front of the real client IP does not reset the per-IP limit', async () => {
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await client(srv.base, `10.9.${i}.1, 192.0.2.200`).post('/api/auth/login', { username: `nobody${i}`, password: 'wrong-guess' })).status);
    assert.equal(codes.at(-1), 429);
  });

  test('passwords are scrypt hashes and sessions are stored hashed', () => {
    const db = dbRead();
    for (const r of db.prepare('SELECT password_hash FROM users').all()) assert.match(r.password_hash, /^scrypt\$/);
    const raw = admin.cookie.split('=')[1];
    const rows = db.prepare('SELECT token FROM sessions').all().map((r) => r.token);
    assert.ok(rows.every((t) => /^[0-9a-f]{64}$/.test(t)));
    assert.ok(!rows.includes(raw), 'cookie value is not stored as-is');
    db.close();
  });

  test('a malformed cookie from another app does not break the API', async () => {
    const r = await admin.get('/api/auth/status', { Cookie: `other=%E0%A4%A; ${admin.cookie}` });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.username, 'admin');
  });

  test('passwords must be 8–256 characters', async () => {
    assert.equal((await admin.post('/api/users', { username: 'shorty', password: 'short' })).status, 400);
    assert.equal((await admin.post('/api/users', { username: 'longy', password: 'x'.repeat(257) })).status, 400);
  });
});

describe('CSRF guard and headers', () => {
  test('mutating calls must be JSON', async () => {
    const r = await admin.req('POST', '/api/lists', 'name=x', { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.equal(r.status, 415);
  });

  test('security headers are set', async () => {
    const page = await admin.get('/');
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal((await admin.get('/api/lists')).headers.get('cache-control'), 'no-store');
  });

  test('index.html has no inline scripts (CSP would block them)', async () => {
    const html = (await admin.get('/')).text;
    assert.doesNotMatch(html, /<script>(?!\s*<\/script>)/);
  });

  test('service worker gets an injected cache version', async () => {
    const sw = (await admin.get('/sw.js')).text;
    assert.doesNotMatch(sw, /__CACHE_VERSION__/);
  });
});

describe('lists, to-dos and subtasks', () => {
  let listId, taskId;

  test('create a list with emoji and color', async () => {
    const r = await admin.post('/api/lists', { name: 'Groceries', emoji: '🛒', color: 'green' });
    assert.equal(r.status, 200);
    listId = r.json.id;
    const lists = (await admin.get('/api/lists')).json.lists;
    const l = lists.find((x) => x.id === listId);
    assert.equal(l.emoji, '🛒');
    assert.equal(l.color, 'green');
    assert.ok(lists.some((x) => x.is_inbox), 'every user has an Inbox');
  });

  test('unknown colors are rejected and emoji is cleaned', async () => {
    assert.equal((await admin.put(`/api/lists/${listId}`, { color: 'chartreuse' })).status, 400);
    await admin.put(`/api/lists/${listId}`, { emoji: '<b>🛒🥕🍞</b>' });
    const l = (await admin.get('/api/lists')).json.lists.find((x) => x.id === listId);
    assert.equal(l.emoji, '🛒🥕');
  });

  test('add a to-do, a subtask, then complete it', async () => {
    const t = await admin.post('/api/tasks', { list_id: listId, title: 'Milk', starred: true });
    assert.equal(t.status, 200);
    taskId = t.json.id;
    const s = await admin.post(`/api/tasks/${taskId}/subtasks`, { title: 'Oat' });
    assert.equal(s.status, 200);
    const done = await admin.post(`/api/tasks/${taskId}/toggle`);
    assert.equal(done.json.task.completed, 1);
    assert.equal(done.json.rolled, false);
  });

  test('a repeating to-do rolls forward instead of completing', async () => {
    const t = (await admin.post('/api/tasks', { list_id: listId, title: 'Water plants' })).json;
    await admin.put(`/api/tasks/${t.id}`, { recurrence: 'weekly', due_date: '2026-01-05' });
    const r = await admin.post(`/api/tasks/${t.id}/toggle`);
    assert.equal(r.json.rolled, true);
    assert.equal(r.json.task.completed, 0);
    assert.ok(r.json.task.due_date > '2026-01-05');
  });

  test('duplicate copies subtasks unchecked', async () => {
    const r = await admin.post(`/api/tasks/${taskId}/duplicate`);
    assert.equal(r.status, 200);
    assert.notEqual(r.json.id, taskId);
    assert.equal(r.json.subtasks.length, 1);
    assert.equal(r.json.subtasks[0].completed, 0);
  });

  test('smart lists and search', async () => {
    const starred = (await admin.get('/api/tasks?smart=starred')).json.tasks;
    assert.ok(starred.every((t) => t.starred));
    const found = (await admin.get('/api/tasks?smart=search&q=milk')).json.tasks;
    assert.ok(found.some((t) => t.title === 'Milk'));
  });

  test('delete a to-do', async () => {
    assert.equal((await admin.del(`/api/tasks/${taskId}`)).status, 200);
    assert.equal((await admin.get(`/api/tasks/${taskId}`)).status, 404);
  });
});

describe('users cannot reach each other’s data', () => {
  let privateList, privateTask;

  before(async () => {
    privateList = (await admin.post('/api/lists', { name: 'Private' })).json.id;
    privateTask = (await admin.post('/api/tasks', { list_id: privateList, title: 'Secret' })).json.id;
  });

  test('another user gets 404 for the list and the to-do', async () => {
    assert.equal((await bob.get(`/api/tasks?list=${privateList}`)).status, 404);
    assert.equal((await bob.get(`/api/tasks/${privateTask}`)).status, 404);
    assert.equal((await bob.put(`/api/tasks/${privateTask}`, { title: 'pwned' })).status, 404);
    assert.equal((await bob.del(`/api/tasks/${privateTask}`)).status, 404);
    assert.equal((await bob.del(`/api/lists/${privateList}`)).status, 404);
  });

  test('cannot move your to-do into someone else’s list', async () => {
    const mine = (await bob.get('/api/lists')).json.lists.find((l) => l.is_inbox).id;
    const t = (await bob.post('/api/tasks', { list_id: mine, title: 'Mine' })).json.id;
    assert.equal((await bob.put(`/api/tasks/${t}`, { list_id: privateList })).status, 404);
  });

  test('search never returns other people’s to-dos', async () => {
    const found = (await bob.get('/api/tasks?smart=search&q=Secret')).json.tasks;
    assert.equal(found.length, 0);
  });
});

describe('sharing needs an invite and consent', () => {
  let shared, task;

  before(async () => {
    shared = (await admin.post('/api/lists', { name: 'House' })).json.id;
    task = (await admin.post('/api/tasks', { list_id: shared, title: 'Fix door' })).json.id;
  });

  test('invite reply is the same for real and unknown usernames', async () => {
    const a = await admin.post(`/api/lists/${shared}/members`, { username: 'bob' });
    const b = await admin.post(`/api/lists/${shared}/members`, { username: 'no_such_user' });
    assert.equal(a.status, 200);
    assert.deepEqual(a.json, b.json);
  });

  test('invitee sees the invite but not the list until they join', async () => {
    const d = (await bob.get('/api/lists')).json;
    assert.ok(d.invites.some((i) => i.id === shared && i.owner === 'admin'));
    assert.ok(!d.lists.some((l) => l.id === shared));
    assert.equal((await bob.get(`/api/tasks?list=${shared}`)).status, 404);
    assert.equal((await bob.get(`/api/tasks/${task}`)).status, 404);
  });

  test('pending invitees cannot be assigned to-dos', async () => {
    const bobId = (await bob.get('/api/auth/status')).json.user.id;
    assert.equal((await admin.put(`/api/tasks/${task}`, { assigned_to: bobId })).status, 400);
  });

  test('after joining, the member can work on to-dos', async () => {
    assert.equal((await bob.post(`/api/invites/${shared}/accept`)).status, 200);
    assert.equal((await bob.get(`/api/tasks?list=${shared}`)).status, 200);
    assert.equal((await bob.put(`/api/tasks/${task}`, { notes: 'hinges' })).status, 200);
  });

  test('members cannot invite, rename or restyle — only the owner can', async () => {
    assert.equal((await bob.post(`/api/lists/${shared}/members`, { username: 'carol' })).status, 403);
    assert.equal((await bob.put(`/api/lists/${shared}`, { name: 'pwned' })).status, 403);
    assert.equal((await bob.put(`/api/lists/${shared}`, { color: 'red' })).status, 403);
  });

  test('members can leave; only the owner can remove others', async () => {
    await admin.post(`/api/lists/${shared}/members`, { username: 'carol' });
    await carol.post(`/api/invites/${shared}/accept`);
    const carolId = (await carol.get('/api/auth/status')).json.user.id;
    assert.equal((await bob.del(`/api/lists/${shared}/members/${carolId}`)).status, 403);
    assert.equal((await carol.del(`/api/lists/${shared}`)).status, 200, 'non-owner delete = leave');
    assert.equal((await carol.get(`/api/tasks?list=${shared}`)).status, 404);
  });

  test('declining removes the invite', async () => {
    const other = (await admin.post('/api/lists', { name: 'Other' })).json.id;
    await admin.post(`/api/lists/${other}/members`, { username: 'carol' });
    assert.equal((await carol.post(`/api/invites/${other}/decline`)).status, 200);
    assert.ok(!(await carol.get('/api/lists')).json.invites.some((i) => i.id === other));
  });
});

describe('push subscriptions', () => {
  const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };

  test('internal or look-alike endpoints are refused', async () => {
    for (const endpoint of [
      'https://127.0.0.1:9443/internal/admin',
      'http://fcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com:8443/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://192.168.1.10/x',
    ]) assert.equal((await admin.post('/api/push/subscribe', { endpoint, keys })).status, 400, endpoint);
  });

  test('real push services are accepted', async () => {
    for (const endpoint of ['https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/QXYZ', 'https://updates.push.services.mozilla.com/wpush/v2/x']) {
      assert.equal((await admin.post('/api/push/subscribe', { endpoint, keys })).status, 200, endpoint);
    }
  });

  test('at most 10 devices per user are kept', async () => {
    for (let i = 0; i < 12; i++) await admin.post('/api/push/subscribe', { endpoint: `https://fcm.googleapis.com/fcm/send/dev${i}`, keys });
    const db = dbRead();
    const id = (await admin.get('/api/auth/status')).json.user.id;
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').get(id).n, 10);
    db.close();
  });

  test('another account cannot take over an endpoint without its keys', async () => {
    const other = { p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22) };
    assert.equal((await bob.post('/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/dev11', keys: other })).status, 409);
  });
});

describe('background photo', () => {
  // PNG signature + filler: the server checks the magic bytes and size, not full validity.
  const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]).toString('base64');

  test('non-images are refused', async () => {
    assert.equal((await bob.post('/api/me/background/photo', { image: 'data:image/png;base64,SGVsbG8gd29ybGQgdGhpcyBpcyBub3QgYW4gaW1hZ2UgYXQgYWxsIGF0IGFsbCBhdCBhbGwgYXQgYWxsIGF0IGFsbCBhdCBhbGwgYXQgYWxs' })).status, 400);
    assert.equal((await bob.post('/api/me/background/photo', { image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })).status, 400);
  });

  test('upload, use, and it is only served to its owner', async () => {
    const r = await bob.post('/api/me/background/photo', { image: png });
    assert.equal(r.status, 200);
    assert.match(r.json.background, /^photo:\d+-[0-9a-f]+\.png$/);
    assert.equal((await bob.get('/api/me/background/photo')).status, 200);
    assert.equal((await carol.get('/api/me/background/photo')).status, 404);
    assert.equal((await client(srv.base, '198.51.100.9').get('/api/me/background/photo')).status, 401);
  });

  test('unknown backgrounds are refused', async () => {
    assert.equal((await bob.put('/api/me/background', { background: 'scene:99' })).status, 400);
    assert.equal((await bob.put('/api/me/background', { background: 'photo:../../etc/passwd' })).status, 400);
  });
});

describe('sign-out', () => {
  test('the session stops working after sign-out', async () => {
    const c = client(srv.base, '203.0.113.77');
    await admin.post('/api/users', { username: 'temp', password: 'password123' });
    await c.post('/api/auth/login', { username: 'temp', password: 'password123' });
    const saved = c.cookie;
    await c.post('/api/auth/logout');
    c.cookie = saved;
    assert.equal((await c.get('/api/lists')).status, 401);
  });
});
