// Lekhira Writes: web server. Plain Node (http + built-in SQLite); the only package is `pg`,
// loaded just when DATABASE_URL points at Postgres.
//   PORT          port to listen on (default 4310)
//   HOST          interface to bind (default 127.0.0.1: this computer only)
//   PUBLIC_ORIGIN the Writes site, e.g. https://writes.lekhira.com (default http://writes.localhost:PORT)
//   API_ORIGIN    the account + sync API, e.g. https://api.lekhira.com (default http://api.localhost:PORT)
//                 For now one server answers both; they can be split later.
//   EMAIL_PROVIDER outbox (default while developing) | resend (needs RESEND_API_KEY, EMAIL_FROM)
//   NODE_ENV      "production" turns on Secure cookies and HSTS (needs HTTPS in front)
//   DATA_DIR      where the SQLite database and the dev outbox live (default ./data)
//   DATABASE_URL  a Postgres address (Supabase in production) instead of the SQLite file
//   TRUST_PROXY   how many proxies set X-Forwarded-For in front of us (Render: 1; Cloudflare +
//                 Render: 2). Unset means none: the connection's own address is used.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db_ = require('./db');
const auth = require('./auth');
const routes = require('./routes');
const accounts = require('./accounts');
const { createMailer } = require('./mail');
const sec = require('./security');
const { HttpError } = sec;

const PORT = Number(process.env.PORT) || 4310;
const HOST = process.env.HOST || '127.0.0.1';
const PRODUCTION = process.env.NODE_ENV === 'production';
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || `http://writes.localhost:${PORT}`).replace(/\/$/, '');
const API_ORIGIN = (process.env.API_ORIGIN || `http://api.localhost:${PORT}`).replace(/\/$/, '');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const TRUST_PROXY = Math.max(0, Math.min(5, Number(process.env.TRUST_PROXY) || 0));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COOKIE = PRODUCTION ? '__Host-lw_session' : 'lw_session';
const DEVICE_COOKIE = PRODUCTION ? '__Host-lw_device' : 'lw_device';
const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || (PRODUCTION ? 'resend' : 'outbox');

const ORIGINS = new Set([PUBLIC_ORIGIN, API_ORIGIN]);
if (!PRODUCTION) ORIGINS.add(`http://localhost:${PORT}`).add(`http://127.0.0.1:${PORT}`).add(`http://writes.localhost:${PORT}`).add(`http://api.localhost:${PORT}`);
const HOSTS = new Set([...ORIGINS].map((o) => new URL(o).host));

if (PRODUCTION && (!PUBLIC_ORIGIN.startsWith('https://') || !API_ORIGIN.startsWith('https://'))) {
  console.error('In production PUBLIC_ORIGIN and API_ORIGIN must be https:// addresses.');
  process.exit(1);
}
if (PRODUCTION && EMAIL_PROVIDER === 'resend' && !process.env.RESEND_API_KEY) {
  console.error('In production set RESEND_API_KEY (and EMAIL_FROM), or choose another EMAIL_PROVIDER.');
  process.exit(1);
}

function createApp({ db, limiter, mailer }) {
  const cookies = {
    set(res, token) { res.appendHeader('Set-Cookie', sec.sessionCookie(COOKIE, token, { production: PRODUCTION, maxAgeSec: auth.SESSION_MS / 1000 })); },
    clear(res) { res.appendHeader('Set-Cookie', sec.sessionCookie(COOKIE, '', { production: PRODUCTION, maxAgeSec: 0 })); },
    // Remembers this browser, so a sign-in from a new one can be reported by email.
    setDevice(res, id) { res.appendHeader('Set-Cookie', sec.sessionCookie(DEVICE_COOKIE, id, { production: PRODUCTION, maxAgeSec: 400 * 86400 })); },
  };
  const origins = { writes: PUBLIC_ORIGIN, api: API_ORIGIN };

  // ---------- tiny router ----------
  const table = [];
  const add = (method) => (pattern, opts, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    table.push({ method, re, keys, opts, handler });
  };
  const router = { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') };
  const acct = accounts.register(router, { db, limiter, cookies, mailer, origins });
  routes.register(router, { db, limiter, cookies, accounts: acct });

  async function sessionFrom(req) {
    const token = req.cookies[COOKIE];
    return token ? auth.lookupSession(db, token) : null;
  }

  async function handleApi(req, res, url) {
    res.setHeader('Cache-Control', 'no-store');
    const match = table.map((r) => ({ r, m: r.method === req.method && url.pathname.match(r.re) })).find((x) => x.m);
    if (!match) {
      const exists = table.some((r) => url.pathname.match(r.re));
      throw new HttpError(exists ? 405 : 404, exists ? 'Method not allowed.' : 'Not found.');
    }
    const { r, m } = match;
    req.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    req.query = url.searchParams;

    // Everything except reads needs to come from our own pages. (Desktop-app endpoints don't
    // use cookies at all, so request forgery doesn't apply to them.)
    if (req.method !== 'GET' && r.opts.csrf !== false && !r.opts.bearer) sec.checkSameOrigin(req, ORIGINS);
    sec.limit(limiter, `api:${req.ip}`, 1200, 60_000);

    if (r.opts.bearer) {
      // The desktop API: an app access token only, never the browser's cookie.
      const found = await accounts.lookupAppToken(db, req.headers.authorization);
      if (!found) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="lekhira", error="invalid_token"');
        throw new HttpError(401, 'Please sign in again.', { error_code: 'invalid_token' });
      }
      req.user = found.user;
      req.grantId = found.grantId;
    } else {
      req.session = await sessionFrom(req);
      req.user = req.session?.user;
      if (r.opts.auth !== false && !req.user) {
        cookies.clear(res);
        throw new HttpError(401, 'Please sign in again.');
      }
    }

    const body = req.method === 'GET' ? {} : await sec.readJson(req, r.opts.bodyLimit || 64 * 1024, { form: !!r.opts.form });
    const out = await r.handler(req, res, body);
    if (out && typeof out.raw === 'string') {
      res.writeHead(200, { 'Content-Type': out.type, 'Content-Disposition': out.disposition });
      return res.end(out.raw);
    }
    const status = out && out.status && out.body ? out.status : 200;
    const payload = out && out.status && out.body ? out.body : out;
    sendJson(res, status, payload);
  }

  // ---------- pages & files ----------
  const TYPES = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
    '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  };
  const PAGES = {
    '/': 'index.html', '/signin': 'auth.html', '/signup': 'auth.html', '/forgot': 'auth.html', '/reset': 'auth.html',
    '/verify': 'auth.html', '/legal': 'legal.html',
  };
  // After signing in, go back to a desktop sign-in request if that's what sent the writer here.
  const safeNext = (v) => (typeof v === 'string' && v.startsWith('/oauth/authorize?') && v.length < 2000 ? v : null);

  function sendFile(req, res, rel, status = 200) {
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Not found.');
    let st;
    try { st = fs.statSync(file); } catch { st = null; }
    if (!st || !st.isFile()) {
      if (rel === '404.html') { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found.'); }
      return notFound(req, res);
    }
    const ext = path.extname(file).toLowerCase();
    const type = TYPES[ext];
    if (!type) return notFound(req, res);
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', ext === '.html' ? 'no-store' : 'no-cache');
    res.setHeader('ETag', etag);
    if (status === 200 && req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
    res.writeHead(status, { 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  function notFound(req, res) { sendFile(req, res, '404.html', 404); }

  // Development only: the emails the server "sent", with their links clickable.
  function sendOutbox(res) {
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const ours = (u) => { try { return ORIGINS.has(new URL(u.replace(/&amp;/g, '&')).origin); } catch { return false; } };
    const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => (ours(u) ? `<a href="${u}">${u}</a>` : u));
    const mails = mailer.outbox();
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Outbox — Lekhira Writes (development)</title>
<link rel="stylesheet" href="/css/site.css"></head><body><main class="prose"><span class="eyebrow">Development only</span><h1>Outbox</h1>
<p>Emails the server would have sent, newest first. They're saved in data/outbox/. Set EMAIL_PROVIDER=resend to send real ones.</p>
${mails.length ? mails.map((m) => `<h2>${esc((m.text.split('\n')[1] || '').replace('Subject: ', ''))}</h2><pre class="note">${linkify(m.text)}</pre>`).join('') : '<p class="note">No emails yet.</p>'}
</main></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  }

  function redirect(res, to) { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); }

  async function handlePage(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    const p = url.pathname;
    if (p === '/app' || p.startsWith('/app/')) {
      if (!(await sessionFrom(req))) return redirect(res, '/signin');
      return sendFile(req, res, 'app.html');
    }
    if (p === '/signin' || p === '/signup') {
      if (await sessionFrom(req)) return redirect(res, safeNext(url.searchParams.get('next')) || '/app');
    }
    if (p === '/oauth/authorize') {
      accounts.authorizeParams(url.searchParams);   // a bad request stops here, before any sign-in
      if (!(await sessionFrom(req))) return redirect(res, `/signin?next=${encodeURIComponent(url.pathname + url.search)}`);
      return sendFile(req, res, 'authorize.html');
    }
    if (p === '/dev/outbox' && !PRODUCTION && mailer.provider === 'outbox') return sendOutbox(res);
    if (PAGES[p]) return sendFile(req, res, PAGES[p]);
    // Static assets: only known folders and file types, no dotfiles, no traversal.
    if (/^\/(css|js|img)\/[A-Za-z0-9._-]+$/.test(p) && !p.includes('..')) return sendFile(req, res, p.slice(1));
    if (p === '/favicon.ico' || p === '/favicon.svg') return sendFile(req, res, 'img/logo.svg');
    if (p === '/robots.txt') return sendFile(req, res, 'robots.txt');
    return notFound(req, res);
  }

  return async function onRequest(req, res) {
    const started = Date.now();
    req.ip = sec.clientIp(req, TRUST_PROXY);
    const jar = sec.parseCookies(req.headers.cookie);
    req.cookies = Object.assign(jar, { device: jar[DEVICE_COOKIE] });
    sec.securityHeaders(res, { production: PRODUCTION });
    res.on('finish', () => {
      if (process.env.QUIET !== '1') console.log(`${new Date().toISOString()} ${req.method} ${req.url.split('?')[0].slice(0, 120)} ${res.statusCode} ${Date.now() - started}ms`);
    });
    let url;
    try {
      // The host's health check (Render). It may use an internal address, so it comes before
      // the Host check; it says only whether the database answers.
      if (req.url === '/healthz' && req.method === 'GET') {
        await db.get('SELECT 1 AS ok');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end('ok');
      }
      if (!HOSTS.has(String(req.headers.host || ''))) throw new HttpError(421, 'Unknown host.');
      url = new URL(req.url, PUBLIC_ORIGIN);
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await handlePage(req, res, url);
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(`[${crypto.randomUUID()}]`, err);
      if (err.extra?.retryAfter) res.setHeader('Retry-After', String(err.extra.retryAfter));
      const message = status === 500 ? 'Something went wrong on our side. Your writing is safe; please try again.' : err.message;
      const extra = { ...(err.extra || {}) };
      delete extra.retryAfter;
      if (url && url.pathname.startsWith('/api/')) sendJson(res, status, { error: message, ...extra });
      else { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(message); }
    }
  };
}

function sendJson(res, status, payload) {
  const json = JSON.stringify(payload ?? {});
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

async function start({ port = PORT, host = HOST, dbFile = path.join(DATA_DIR, 'lekhira-writes.db'), databaseUrl = process.env.DATABASE_URL, mailer } = {}) {
  const db = await db_.open({ url: databaseUrl, file: dbFile });
  const limiter = new sec.RateLimiter();
  mailer = mailer || createMailer({
    provider: EMAIL_PROVIDER, from: process.env.EMAIL_FROM, apiKey: process.env.RESEND_API_KEY, outboxDir: path.join(DATA_DIR, 'outbox'),
  });
  const handler = createApp({ db, limiter, mailer });
  const server = http.createServer(handler);
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 60;
  const sweep = setInterval(() => auth.sweepSessions(db).catch((err) => console.error('Session sweep failed:', err.message)), 3600_000);
  sweep.unref();
  // Names like writes.localhost can resolve to IPv6 (::1) as well as 127.0.0.1, so on this
  // computer the server listens on both loopback addresses. Neither is reachable from outside.
  const v6 = host === '127.0.0.1' ? http.createServer(handler) : null;
  server.on('close', () => { clearInterval(sweep); if (v6) v6.close(); db.close().catch(() => { /* already closed */ }); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      if (!v6) return resolve({ server, db, mailer });
      v6.once('error', () => resolve({ server, db, mailer }));   // no IPv6 here: IPv4 is enough
      v6.listen(port, '::1', () => resolve({ server, db, mailer }));
    });
  });
}

if (require.main === module) {
  start().then(() => {
    console.log(`\n  Lekhira Writes is running at ${PUBLIC_ORIGIN}\n  Account API:  ${API_ORIGIN}\n  Email:        ${EMAIL_PROVIDER === 'outbox' ? `outbox (read them at ${PUBLIC_ORIGIN}/dev/outbox)` : EMAIL_PROVIDER}\n  Data: ${process.env.DATABASE_URL ? 'Postgres (DATABASE_URL)' : DATA_DIR}\n  Mode: ${PRODUCTION ? 'production' : 'development'}\n  Press Ctrl C to stop.\n`);
    // Set by "Start Lekhira Writes.cmd", so the browser opens once the server is ready.
    if (process.env.OPEN_BROWSER === '1' && process.platform === 'win32') {
      require('node:child_process').spawn('cmd', ['/c', 'start', '', PUBLIC_ORIGIN], { detached: true, stdio: 'ignore' }).unref();
    }
  }).catch((err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${PORT} is already in use.\n  Lekhira Writes may already be running: open ${PUBLIC_ORIGIN} in your browser.\n  To run a second copy, pick another port, e.g. in PowerShell:  $env:PORT=4320; npm run dev\n`);
    } else {
      console.error('\n  Lekhira Writes could not start:', err.message, '\n');
    }
    process.exit(1);
  });
  const stop = () => process.exit(0);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { start, COOKIE };
