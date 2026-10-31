// Lekhira Writes: the shared Lekhira account — email checks, password resets, sign-in
// alerts, and signing in desktop apps (Lekhira Writing Studio) through the browser.
//
// Desktop sign-in is OAuth 2.0 authorization code + PKCE for native apps (RFC 8252):
//   1. Studio opens  /oauth/authorize?client_id=lekhira-studio&redirect_uri=http://127.0.0.1:<port>/callback
//      &response_type=code&code_challenge=<S256>&code_challenge_method=S256&state=<random>
//   2. The writer signs in here (if needed) and clicks Allow; the browser goes back to Studio's
//      loopback address with a one-time code.
//   3. Studio swaps the code (and its PKCE verifier) at POST /api/oauth/token for an access
//      token (1 hour) and a refresh token (60 days, replaced on every use).
//   4. Studio calls /api/v1/* with "Authorization: Bearer <access token>".
// Studio never sees the password; any app can be signed out from the Account panel.
'use strict';
const crypto = require('node:crypto');
const auth = require('./auth');
const { HttpError, limit, sha256, newId, isId } = require('./security');
const { templates } = require('./mail');

const VERIFY_TTL = 48 * 3600 * 1000;
const RESET_TTL = 30 * 60 * 1000;
const CODE_TTL = 5 * 60 * 1000;
const ACCESS_TTL = 3600 * 1000;
const REFRESH_TTL = 60 * 24 * 3600 * 1000;

// Apps allowed to sign in through the browser. Native apps can't keep a secret, so they're
// public clients: PKCE and loopback-only redirects are what protect the code.
const CLIENTS = {
  'lekhira-studio': { name: 'Lekhira Writing Studio' },
};
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|\[::1\]):(\d{2,5})\/callback$/;
const PKCE = /^[A-Za-z0-9_-]{43}$/;                       // base64url SHA-256
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

const secret = (prefix) => prefix + crypto.randomBytes(32).toString('base64url');
const s256 = (v) => crypto.createHash('sha256').update(v).digest('base64url');

function describeAgent(a) {
  const s = String(a || '');
  if (/LekhiraStudio/i.test(s)) return 'Lekhira Writing Studio';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'A browser';
  const os = /Windows/.test(s) ? 'Windows' : /Mac OS X/.test(s) ? 'macOS' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Linux/.test(s) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
const stamp = (ms = Date.now()) => `${new Date(ms).toUTCString().replace('GMT', 'UTC')}`;

// Checks the parameters of an authorize request. Throws 400 (never redirects) when the client
// or redirect address is wrong, so a bad link can't bounce a code to someone else.
function authorizeParams(q) {
  const get = (k) => (typeof q.get === 'function' ? q.get(k) : q[k]);
  const clientId = get('client_id');
  const client = CLIENTS[clientId];
  if (!client) throw new HttpError(400, 'This app isn’t recognised.');
  const redirectUri = String(get('redirect_uri') || '');
  if (!LOOPBACK.test(redirectUri)) throw new HttpError(400, 'This app asked to return to an address that isn’t allowed.');
  if (get('response_type') !== 'code') throw new HttpError(400, 'Unsupported sign-in request.');
  const challenge = String(get('code_challenge') || '');
  if (get('code_challenge_method') !== 'S256' || !PKCE.test(challenge)) throw new HttpError(400, 'This sign-in request is missing its security check (PKCE).');
  const state = String(get('state') || '');
  if (!state || state.length > 200) throw new HttpError(400, 'This sign-in request is missing its state.');
  const deviceName = String(get('device_name') || '').replace(/[^\p{L}\p{N} ._'’()-]/gu, '').slice(0, 60);
  return { clientId, client, redirectUri, challenge, state, deviceName };
}

function register(r, ctx) {
  const { db, limiter, cookies, mailer, origins } = ctx;
  const link = (p) => `${origins.writes}${p}`;
  const forgotLink = link('/forgot');

  // ---------- email links ----------
  async function issueEmailToken(user, purpose, ttl) {
    const raw = secret('');
    const now = Date.now();
    await db.run('INSERT INTO email_tokens (token_hash, user_id, purpose, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', sha256(raw), user.id, purpose, user.email, now, now + ttl);
    return raw;
  }
  async function consumeEmailToken(raw, purpose) {
    if (typeof raw !== 'string' || raw.length < 20 || raw.length > 100) throw new HttpError(400, 'This link isn’t valid. Please ask for a new one.');
    const row = await db.get('SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = ?', sha256(raw), purpose);
    if (!row || row.used_at) throw new HttpError(400, 'This link has already been used or isn’t valid. Please ask for a new one.');
    if (row.expires_at < Date.now()) throw new HttpError(400, 'This link has expired. Please ask for a new one.');
    const user = await db.get('SELECT * FROM users WHERE id = ?', row.user_id);
    // A link sent to an old address doesn't prove the current one.
    if (!user || user.email !== row.email) throw new HttpError(400, 'This link isn’t valid any more. Please ask for a new one.');
    // Only one request can use a link, even if two arrive at once.
    const used = await db.run('UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL', Date.now(), user.id, purpose);
    if (!used.changes) throw new HttpError(400, 'This link has already been used or isn’t valid. Please ask for a new one.');
    return user;
  }
  async function sendVerification(user) {
    const raw = await issueEmailToken(user, 'verify', VERIFY_TTL);
    // The token travels in the #fragment, so it never reaches server logs or other sites.
    mailer.send({ kind: 'verify', to: user.email, ...templates.verify({ name: user.name, link: link(`/verify#token=${raw}`) }) });
  }

  // ---------- sign-in alerts ----------
  // Each browser gets a random device id (a cookie). Signing in from one we haven't seen for
  // this account sends an email, except for the very first sign-in.
  async function noteSignIn(req, res, user, { quiet = false } = {}) {
    let device = req.cookies.device;
    if (!device || !/^[A-Za-z0-9_-]{20,64}$/.test(device)) {
      device = newId(24);
      cookies.setDevice(res, device);
    }
    const hash = sha256(device);
    const now = Date.now();
    const known = await db.get('SELECT 1 FROM devices WHERE user_id = ? AND device_hash = ?', user.id, hash);
    const any = await db.get('SELECT 1 FROM devices WHERE user_id = ? LIMIT 1', user.id);
    await db.run(`INSERT INTO devices (user_id, device_hash, agent, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, device_hash) DO UPDATE SET last_seen = excluded.last_seen, agent = excluded.agent`, user.id, hash, String(req.headers['user-agent'] || '').slice(0, 200), now, now);
    if (!known && any && !quiet) {
      mailer.send({ kind: 'new-sign-in', to: user.email, ...templates.newSignIn({
        name: user.name, what: describeAgent(req.headers['user-agent']), when: stamp(now), where: `Network address ${req.ip}`, forgotLink,
      }) });
    }
  }

  async function revokeAllApps(userId, q = db) {
    await q.run('UPDATE app_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', Date.now(), userId);
  }

  // ---------- verify email ----------
  r.post('/api/auth/verify', { auth: false }, async (req, res, body) => {
    limit(limiter, `verify:${req.ip}`, 20, 15 * 60_000);
    const user = await consumeEmailToken(body.token, 'verify');
    await db.run('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', Date.now(), user.id);
    return { ok: true, email: user.email };
  });

  r.post('/api/me/verify/resend', {}, async (req) => {
    const user = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
    if (user.email_verified_at) return { ok: true, already: true };
    limit(limiter, `verify-send:${user.id}`, 3, 3600_000, 'We’ve sent a few links already. Please check your inbox (and spam), or try again in an hour.');
    await sendVerification(user);
    return { ok: true };
  });

  // ---------- forgot / reset password ----------
  // Always the same answer, so this can't be used to find out who has an account.
  r.post('/api/auth/forgot', { auth: false }, async (req, res, body) => {
    limit(limiter, `forgot-ip:${req.ip}`, 6, 15 * 60_000);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : '';
    if (!email) throw new HttpError(400, 'Please enter your email address.', { field: 'email' });
    const user = await db.get('SELECT * FROM users WHERE email = ?', email);
    if (user && limiter.take(`forgot-email:${email}`, 3, 3600_000) === 0) {
      const raw = await issueEmailToken(user, 'reset', RESET_TTL);
      mailer.send({ kind: 'reset', to: user.email, ...templates.reset({ name: user.name, link: link(`/reset#token=${raw}`) }) });
    }
    return { ok: true, message: 'If that email has a Lekhira account, a reset link is on its way. It works for 30 minutes.' };
  });

  r.post('/api/auth/reset', { auth: false }, async (req, res, body) => {
    limit(limiter, `reset:${req.ip}`, 10, 15 * 60_000);
    // Check the new password before using up the link, so a typo doesn't waste it.
    const peek = typeof body.token === 'string' ? await db.get('SELECT u.email, u.name FROM email_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?', sha256(body.token)) : null;
    const password = auth.checkNewPassword(body.password, peek || {});
    const hash = await auth.hashPassword(password);
    const user = await consumeEmailToken(body.token, 'reset');
    const now = Date.now();
    await db.tx(async (t) => {
      // Opening the emailed link also proves the address.
      await t.run('UPDATE users SET pw_hash = ?, pw_changed_at = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', hash, now, now, user.id);
      await t.run('DELETE FROM sessions WHERE user_id = ?', user.id);
      await revokeAllApps(user.id, t);
    });
    mailer.send({ kind: 'password-changed', to: user.email, ...templates.passwordChanged({ name: user.name, forgotLink }) });
    cookies.set(res, await auth.createSession(db, user.id, req.headers['user-agent']));
    await noteSignIn(req, res, user, { quiet: true });
    return { ok: true };
  });

  // ---------- desktop sign-in ----------
  r.post('/api/oauth/approve', {}, async (req, res, body) => {
    limit(limiter, `approve:${req.user.id}`, 20, 15 * 60_000);
    const p = authorizeParams(body);
    const user = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!user.email_verified_at) throw new HttpError(403, 'Please confirm your email address before signing in to Lekhira Studio. We can send the link again.', { needsVerification: true });
    const code = secret('');
    const now = Date.now();
    await db.run('INSERT INTO oauth_codes (code_hash, user_id, client_id, redirect_uri, challenge, device_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', sha256(code), user.id, p.clientId, p.redirectUri, p.challenge, p.deviceName, now, now + CODE_TTL);
    const to = new URL(p.redirectUri);
    to.searchParams.set('code', code);
    to.searchParams.set('state', p.state);
    return { redirect: to.toString() };
  });

  r.post('/api/oauth/deny', {}, (req, res, body) => {
    const p = authorizeParams(body);
    const to = new URL(p.redirectUri);
    to.searchParams.set('error', 'access_denied');
    to.searchParams.set('state', p.state);
    return { redirect: to.toString() };
  });

  async function issueGrant(q, user, clientId, deviceName) {
    const access = secret('lka_');
    const refresh = secret('lkr_');
    const now = Date.now();
    const id = newId();
    await q.run(`INSERT INTO app_grants (id, user_id, client_id, device_name, access_hash, access_expires, refresh_hash, refresh_expires, created_at, last_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, user.id, clientId, deviceName, sha256(access), now + ACCESS_TTL, sha256(refresh), now + REFRESH_TTL, now, now);
    return { id, body: tokenBody(access, refresh) };
  }
  const tokenBody = (access, refresh) => ({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: 'account sync' });
  const oauthError = (status, error, description) => new HttpError(status, description, { error_code: error });

  // Called by the desktop app, not a browser page: no cookies are used, so no forgery check.
  r.post('/api/oauth/token', { auth: false, csrf: false, form: true }, async (req, res, body) => {
    limit(limiter, `token:${req.ip}`, 60, 15 * 60_000);
    res.setHeader('Pragma', 'no-cache');
    const client = CLIENTS[body.client_id];
    if (!client) throw oauthError(400, 'invalid_client', 'Unknown app.');

    if (body.grant_type === 'authorization_code') {
      if (typeof body.code !== 'string' || !VERIFIER.test(String(body.code_verifier || ''))) throw oauthError(400, 'invalid_request', 'Missing code or verifier.');
      const row = await db.get('SELECT * FROM oauth_codes WHERE code_hash = ?', sha256(body.code));
      if (!row || row.client_id !== body.client_id || row.redirect_uri !== body.redirect_uri) throw oauthError(400, 'invalid_grant', 'This sign-in code isn’t valid.');
      if (row.used_at) {
        // A code used twice means it leaked: sign out whatever it was swapped for.
        if (row.grant_id) await db.run('UPDATE app_grants SET revoked_at = ? WHERE id = ?', Date.now(), row.grant_id);
        throw oauthError(400, 'invalid_grant', 'This sign-in code was already used.');
      }
      if (row.expires_at < Date.now()) throw oauthError(400, 'invalid_grant', 'This sign-in code has expired. Please sign in again.');
      if (!crypto.timingSafeEqual(Buffer.from(s256(body.code_verifier)), Buffer.from(row.challenge))) throw oauthError(400, 'invalid_grant', 'The security check (PKCE) failed.');
      const user = await db.get('SELECT * FROM users WHERE id = ?', row.user_id);
      const grant = await db.tx(async (t) => {
        const g = await issueGrant(t, user, row.client_id, row.device_name);
        // Only one swap can win, even if two arrive at once.
        const used = await t.run('UPDATE oauth_codes SET used_at = ?, grant_id = ? WHERE code_hash = ? AND used_at IS NULL', Date.now(), g.id, row.code_hash);
        if (!used.changes) throw oauthError(400, 'invalid_grant', 'This sign-in code was already used.');
        return g;
      });
      mailer.send({ kind: 'new-sign-in', to: user.email, ...templates.newSignIn({
        name: user.name, what: `${client.name}${row.device_name ? ` on “${row.device_name}”` : ''}`, when: stamp(), where: `Network address ${req.ip}`, forgotLink,
      }) });
      return grant.body;
    }

    if (body.grant_type === 'refresh_token') {
      const h = sha256(String(body.refresh_token || ''));
      const g = await db.get('SELECT * FROM app_grants WHERE refresh_hash = ? AND client_id = ?', h, body.client_id);
      if (!g) {
        // An old refresh token coming back means someone copied it: end that sign-in.
        const stolen = await db.get('SELECT id FROM app_grants WHERE prev_refresh_hash = ?', h);
        if (stolen) await db.run('UPDATE app_grants SET revoked_at = ? WHERE id = ?', Date.now(), stolen.id);
        throw oauthError(400, 'invalid_grant', 'Please sign in again.');
      }
      if (g.revoked_at || g.refresh_expires < Date.now()) throw oauthError(400, 'invalid_grant', 'Please sign in again.');
      const access = secret('lka_');
      const refresh = secret('lkr_');
      const now = Date.now();
      const turned = await db.run('UPDATE app_grants SET access_hash = ?, access_expires = ?, refresh_hash = ?, prev_refresh_hash = ?, refresh_expires = ?, last_used = ? WHERE id = ? AND refresh_hash = ?', sha256(access), now + ACCESS_TTL, sha256(refresh), h, now + REFRESH_TTL, now, g.id, h);
      if (!turned.changes) throw oauthError(400, 'invalid_grant', 'Please sign in again.');
      return tokenBody(access, refresh);
    }
    throw oauthError(400, 'unsupported_grant_type', 'Unsupported request.');
  });

  // Signing out from the app. Always answers OK (RFC 7009).
  r.post('/api/oauth/revoke', { auth: false, csrf: false, form: true }, async (req, res, body) => {
    limit(limiter, `revoke:${req.ip}`, 60, 15 * 60_000);
    const h = sha256(String(body.token || ''));
    await db.run('UPDATE app_grants SET revoked_at = ? WHERE (access_hash = ? OR refresh_hash = ?) AND revoked_at IS NULL', Date.now(), h, h);
    return { ok: true };
  });

  // ---------- the API desktop apps use (Bearer tokens only) ----------
  r.get('/api/v1/me', { bearer: true }, async (req) => {
    const u = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
    return {
      user: { id: u.id, email: u.email, name: u.name, emailVerified: !!u.email_verified_at },
      // Plans arrive in Phase 3; until then every account has the free plan.
      plan: 'free',
      entitlements: { writes: true, studio: false, sync: false },
    };
  });

  // ---------- apps signed in, in the Account panel ----------
  r.get('/api/me/apps', {}, async (req) => ({
    apps: (await db.all('SELECT id, client_id, device_name, created_at, last_used FROM app_grants WHERE user_id = ? AND revoked_at IS NULL AND refresh_expires > ? ORDER BY last_used DESC', req.user.id, Date.now()))
      .map((g) => ({ id: g.id, app: (CLIENTS[g.client_id] || {}).name || g.client_id, device: g.device_name, createdAt: g.created_at, lastUsed: g.last_used })),
  }));

  r.post('/api/me/apps/:id/revoke', {}, async (req) => {
    if (!isId(req.params.id)) throw new HttpError(404, 'That app was not found.');
    await db.run('UPDATE app_grants SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', Date.now(), req.params.id, req.user.id);
    return { ok: true };
  });

  function notifyPasswordChanged(user) {
    mailer.send({ kind: 'password-changed', to: user.email, ...templates.passwordChanged({ name: user.name, forgotLink }) });
  }

  return { sendVerification, noteSignIn, revokeAllApps, notifyPasswordChanged };
}

// Finds the account behind "Authorization: Bearer lka_…".
async function lookupAppToken(db, header) {
  const m = /^Bearer (lka_[A-Za-z0-9_-]{43})$/.exec(String(header || ''));
  if (!m) return null;
  const g = await db.get(`SELECT g.id, g.access_expires, g.revoked_at, u.id AS user_id, u.email, u.name FROM app_grants g
    JOIN users u ON u.id = g.user_id WHERE g.access_hash = ?`, sha256(m[1]));
  if (!g || g.revoked_at || g.access_expires < Date.now()) return null;
  return { grantId: g.id, user: { id: g.user_id, email: g.email, name: g.name } };
}

module.exports = { register, authorizeParams, lookupAppToken, CLIENTS };
