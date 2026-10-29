// Lekhira Writes: passwords and sessions.
// Passwords are hashed with scrypt (memory-hard) and a per-user salt. Session tokens are
// 256-bit random values; only their SHA-256 is stored, so a leaked database can't be used
// to sign in.
'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { HttpError, sha256, newId } = require('./security');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const KEY_LEN = 64;

const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 3600 * 1000;
const TOUCH_MS = 10 * 60 * 1000;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const key = await scrypt(password.normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(key, expected);
}

// Used when the email isn't registered, so a failed sign-in takes the same time either way.
let dummyHash = null;
async function burnTime(password) {
  if (!dummyHash) dummyHash = await hashPassword('lekhira-placeholder-password');
  await verifyPassword(password, dummyHash);
}

// ---------- validation ----------
const COMMON = new Set([
  'password', 'password1', 'password123', '1234567890', '12345678910', 'qwertyuiop', 'iloveyou12',
  'letmein123', 'welcome123', 'admin12345', 'passw0rd123', 'qwerty1234', '1q2w3e4r5t', 'abcdefghij',
  'lekhira123', 'lekhirawrites', 'football123', 'baseball123', 'sunshine123', 'princess123',
]);

function cleanEmail(v) {
  const email = String(v ?? '').trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^\s@<>()"']+@[^\s@<>()"']+\.[a-z]{2,}$/i.test(email)) {
    throw new HttpError(400, 'Please enter a valid email address.', { field: 'email' });
  }
  return email;
}

function cleanName(v) {
  const name = String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (!name) throw new HttpError(400, 'Please tell us what to call you.', { field: 'name' });
  if (name.length > 80) throw new HttpError(400, 'Please use a shorter name (80 characters at most).', { field: 'name' });
  return name;
}

function checkNewPassword(v, { email, name } = {}) {
  const pw = typeof v === 'string' ? v : '';
  if (pw.length < 10) throw new HttpError(400, 'Use at least 10 characters for your password.', { field: 'password' });
  if (pw.length > 200) throw new HttpError(400, 'Please use a password of 200 characters or fewer.', { field: 'password' });
  const lower = pw.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(pw)) throw new HttpError(400, 'That password is too easy to guess. Try a short phrase you will remember.', { field: 'password' });
  if (email && lower.includes(email.split('@')[0]) && email.split('@')[0].length >= 4) {
    throw new HttpError(400, 'Your password should not contain your email address.', { field: 'password' });
  }
  if (name && name.length >= 4 && lower === name.toLowerCase()) throw new HttpError(400, 'Your password should not be your name.', { field: 'password' });
  return pw;
}

// ---------- sessions ----------
function createSession(db, userId, agent) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, agent) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha256(token), userId, now, now + SESSION_MS, now, String(agent || '').slice(0, 200));
  // Keep at most 20 sessions per person; the oldest go first.
  db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash NOT IN
    (SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY last_seen DESC LIMIT 20)`).run(userId, userId);
  return token;
}

function lookupSession(db, token) {
  if (!token || typeof token !== 'string' || token.length !== 43) return null;
  const hash = sha256(token);
  const row = db.prepare(`SELECT s.token_hash, s.expires_at, s.last_seen, s.created_at, u.id, u.email, u.name, u.prefs, u.daily_goal, u.pw_changed_at
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hash);
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now || row.created_at < row.pw_changed_at) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  // Sliding expiry, written at most every 10 minutes.
  if (now - row.last_seen > TOUCH_MS) {
    db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?').run(now, now + SESSION_MS, hash);
  }
  return { tokenHash: hash, user: { id: row.id, email: row.email, name: row.name, prefs: row.prefs, dailyGoal: row.daily_goal } };
}

function endSession(db, tokenHash) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash); }
function endAllSessions(db, userId, exceptHash) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, exceptHash || '');
}
function sweepSessions(db) { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); }

module.exports = {
  hashPassword, verifyPassword, burnTime, cleanEmail, cleanName, checkNewPassword,
  createSession, lookupSession, endSession, endAllSessions, sweepSessions, SESSION_MS, newUserId: () => newId(12),
};
