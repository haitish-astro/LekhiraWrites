// Lekhira Writes: request hardening. Security headers, request-forgery checks, body
// limits, rate limits and cookie handling live here so every route gets them.
'use strict';
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ---------- headers ----------
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

function securityHeaders(res, { production }) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  if (production) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
}

// ---------- request forgery ----------
// State-changing API calls must come from our own pages: the Origin must be ours (or the
// browser must say same-origin), and the call must carry our custom header, which a
// cross-site form or image can't add. Session cookies are also SameSite=Strict.
function checkSameOrigin(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (origin) {
    if (!allowedOrigins.has(origin)) throw new HttpError(403, 'This request came from another site and was blocked.');
  } else if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') {
    throw new HttpError(403, 'This request came from another site and was blocked.');
  }
  if (req.headers['x-lekhira'] !== '1') throw new HttpError(403, 'Missing request header.');
}

// ---------- bodies ----------
function readJson(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const empty = !req.headers['transfer-encoding'] && !Number(req.headers['content-length'] || 0);
    if (empty) { req.resume(); return resolve({}); }
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return reject(new HttpError(415, 'Requests must be JSON.'));
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limitBytes) return reject(new HttpError(413, 'That is too large to save in one go.'));
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limitBytes) {
        done = true;
        reject(new HttpError(413, 'That is too large to save in one go.'));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (!size) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
        resolve(value);
      } catch {
        reject(new HttpError(400, 'The request could not be read.'));
      }
    });
    req.on('error', () => { if (!done) { done = true; reject(new HttpError(400, 'The request was interrupted.')); } });
  });
}

// ---------- rate limits ----------
// Sliding-window counters in memory. Enough for one server; a shared store (Redis) is
// needed once there is more than one.
class RateLimiter {
  constructor() {
    this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }
  // Returns seconds to wait (0 = allowed) and records the hit when allowed.
  take(key, limit, windowMs) {
    const now = Date.now();
    const list = (this.hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= limit) {
      this.hits.set(key, list);
      return Math.ceil((windowMs - (now - list[0])) / 1000);
    }
    list.push(now);
    this.hits.set(key, list);
    return 0;
  }
  reset(key) { this.hits.delete(key); }
  sweep() {
    const now = Date.now();
    for (const [k, list] of this.hits) if (!list.length || now - list[list.length - 1] > 3_600_000) this.hits.delete(k);
  }
}

function limit(limiter, key, max, windowMs, message) {
  const wait = limiter.take(key, max, windowMs);
  if (wait) throw new HttpError(429, message || 'Too many attempts. Please wait a moment and try again.', { retryAfter: wait });
}

// ---------- cookies ----------
function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) {
      try { out[k] = decodeURIComponent(v); } catch { /* ignore malformed */ }
    }
  }
  return out;
}

function sessionCookie(name, value, { production, maxAgeSec }) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (production) parts.push('Secure');
  return parts.join('; ');
}

// ---------- ids & hashing ----------
function newId(bytes = 12) { return crypto.randomBytes(bytes).toString('base64url'); }
function sha256(s) { return crypto.createHash('sha256').update(s).digest('base64url'); }
const ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
function isId(s) { return typeof s === 'string' && ID_RE.test(s); }

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

module.exports = {
  HttpError, securityHeaders, checkSameOrigin, readJson, RateLimiter, limit,
  parseCookies, sessionCookie, newId, sha256, isId, clientIp, CSP,
};
