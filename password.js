// Wunderlost — Copyright (C) 2026 Matt Hornish. AGPL-3.0-or-later; see LICENSE.
// Password hashing with scrypt on libuv's threadpool, so sign-ins don't block the event loop.
// Older bcrypt hashes still verify and are upgraded to scrypt on the next successful sign-in.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const N = 2 ** 15, R = 8, P = 1, KEYLEN = 64, MAXMEM = 64 * 1024 * 1024;

function scrypt(password, salt, n = N, r = R, p = P) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))));
}

// Only a couple of hashes run at once; extra requests wait in a short queue, then get "busy".
const MAX_ACTIVE = 2, MAX_QUEUED = 20;
let active = 0;
const queue = [];
class BusyError extends Error { constructor() { super('Server is busy, try again in a moment'); this.status = 503; } }
async function slot(fn) {
  if (active >= MAX_ACTIVE) {
    if (queue.length >= MAX_QUEUED) throw new BusyError();
    await new Promise((resolve) => queue.push(resolve));
  }
  active++;
  try { return await fn(); } finally { active--; queue.shift()?.(); }
}

async function hashPassword(password) {
  return slot(async () => {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt);
    return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
  });
}

async function verifyPassword(password, stored) {
  return slot(async () => {
    if (stored.startsWith('scrypt$')) {
      const [, n, r, p, salt, hash] = stored.split('$');
      const want = Buffer.from(hash, 'base64');
      const got = await scrypt(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
      return got.length === want.length && crypto.timingSafeEqual(got, want);
    }
    return bcrypt.compare(password, stored); // legacy hashes from before scrypt
  });
}

const needsRehash = (stored) => !stored.startsWith(`scrypt$${N}$${R}$${P}$`);

// Burns the same time as a real check when the username doesn't exist (no timing leak).
let dummy = null;
async function dummyVerify(password) {
  dummy ||= await hashPassword('not-a-real-password');
  await verifyPassword(password, dummy).catch(() => {});
  return false;
}

module.exports = { hashPassword, verifyPassword, needsRehash, dummyVerify, BusyError };
