// Wunderlost — Copyright (C) 2026 Matt Hornish. AGPL-3.0-or-later; see LICENSE.
// Test helpers: start a real server on a free port with a throwaway data folder,
// and talk to it like a browser (JSON + session cookie).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

// Starts server.js; resolves once it's listening. Captures the first-run setup code.
async function startServer(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wunderlost-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), TZ: 'America/New_York', VAPID_SUBJECT: 'mailto:test@example.com', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server didn't start:\n${out}`)), 15000);
    const check = setInterval(() => {
      if (out.includes('listening on')) { clearInterval(check); clearTimeout(t); resolve(); }
      if (child.exitCode !== null) { clearInterval(check); clearTimeout(t); reject(new Error(`server exited:\n${out}`)); }
    }, 25);
  });
  const setupCode = (out.match(/setup code: ([A-F0-9-]+)/) || [])[1];
  return {
    base: `http://127.0.0.1:${port}`,
    dataDir,
    setupCode,
    log: () => out,
    async stop() {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// A browser-like client with its own cookie jar. `ip` sets X-Forwarded-For (the server
// trusts loopback proxies), so tests can act as different clients for the rate limits.
function client(base, ip = '203.0.113.10') {
  let cookie = '';
  async function req(method, url, body, headers = {}) {
    const h = { 'X-Forwarded-For': ip, ...headers };
    if (cookie) h.Cookie = cookie;
    if (body !== undefined) { h['Content-Type'] ??= 'application/json'; }
    const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  }
  return {
    req,
    get: (u, h) => req('GET', u, undefined, h),
    post: (u, b = {}, h) => req('POST', u, b, h),
    put: (u, b = {}, h) => req('PUT', u, b, h),
    del: (u, h) => req('DELETE', u, {}, h),
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
  };
}

module.exports = { startServer, client };
