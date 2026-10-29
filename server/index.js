// Lekhira Writes: web server. Plain Node (http + built-in SQLite), no third-party packages.
//   PORT          port to listen on (default 4310)
//   HOST          interface to bind (default 127.0.0.1: this computer only)
//   PUBLIC_ORIGIN the site's address, e.g. https://writes.lekhira.com (default http://localhost:PORT)
//   NODE_ENV      "production" turns on Secure cookies and HSTS (needs HTTPS in front)
//   DATA_DIR      where the database lives (default ./data)
//   TRUST_PROXY   "1" when behind a reverse proxy that sets X-Forwarded-For
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db_ = require('./db');
const auth = require('./auth');
const routes = require('./routes');
const sec = require('./security');
const { HttpError } = sec;

const PORT = Number(process.env.PORT) || 4310;
const HOST = process.env.HOST || '127.0.0.1';
const PRODUCTION = process.env.NODE_ENV === 'production';
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`).replace(/\/$/, '');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COOKIE = PRODUCTION ? '__Host-lw_session' : 'lw_session';

const ORIGINS = new Set([PUBLIC_ORIGIN]);
if (!PRODUCTION) ORIGINS.add(`http://localhost:${PORT}`).add(`http://127.0.0.1:${PORT}`);
const HOSTS = new Set([...ORIGINS].map((o) => new URL(o).host));

if (PRODUCTION && !PUBLIC_ORIGIN.startsWith('https://')) {
  console.error('In production PUBLIC_ORIGIN must be an https:// address.');
  process.exit(1);
}

function createApp({ db, limiter }) {
  const cookies = {
    set(res, token) { res.appendHeader('Set-Cookie', sec.sessionCookie(COOKIE, token, { production: PRODUCTION, maxAgeSec: auth.SESSION_MS / 1000 })); },
    clear(res) { res.appendHeader('Set-Cookie', sec.sessionCookie(COOKIE, '', { production: PRODUCTION, maxAgeSec: 0 })); },
  };

  // ---------- tiny router ----------
  const table = [];
  const add = (method) => (pattern, opts, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    table.push({ method, re, keys, opts, handler });
  };
  const router = { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') };
  routes.register(router, { db, limiter, cookies });

  function sessionFrom(req) {
    const token = sec.parseCookies(req.headers.cookie)[COOKIE];
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

    // Everything except reads needs to come from our own pages.
    if (req.method !== 'GET') sec.checkSameOrigin(req, ORIGINS);
    sec.limit(limiter, `api:${req.ip}`, 1200, 60_000);

    req.session = sessionFrom(req);
    req.user = req.session?.user;
    if (r.opts.auth !== false && !req.user) {
      cookies.clear(res);
      throw new HttpError(401, 'Please sign in again.');
    }

    const body = req.method === 'GET' ? {} : await sec.readJson(req, r.opts.bodyLimit || 64 * 1024);
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
    '/': 'index.html', '/signin': 'auth.html', '/signup': 'auth.html', '/legal': 'legal.html',
  };

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

  function redirect(res, to) { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); }

  function handlePage(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    const p = url.pathname;
    if (p === '/app' || p.startsWith('/app/')) {
      if (!sessionFrom(req)) return redirect(res, '/signin');
      return sendFile(req, res, 'app.html');
    }
    if (p === '/signin' || p === '/signup') {
      if (sessionFrom(req)) return redirect(res, '/app');
    }
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
    sec.securityHeaders(res, { production: PRODUCTION });
    res.on('finish', () => {
      if (process.env.QUIET !== '1') console.log(`${new Date().toISOString()} ${req.method} ${req.url.split('?')[0].slice(0, 120)} ${res.statusCode} ${Date.now() - started}ms`);
    });
    let url;
    try {
      if (!HOSTS.has(String(req.headers.host || ''))) throw new HttpError(421, 'Unknown host.');
      url = new URL(req.url, PUBLIC_ORIGIN);
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else handlePage(req, res, url);
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

function start({ port = PORT, host = HOST, dbFile = path.join(DATA_DIR, 'lekhira-writes.db') } = {}) {
  const db = db_.open(dbFile);
  const limiter = new sec.RateLimiter();
  const server = http.createServer(createApp({ db, limiter }));
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 60;
  const sweep = setInterval(() => auth.sweepSessions(db), 3600_000);
  sweep.unref();
  server.on('close', () => { clearInterval(sweep); try { db.close(); } catch { /* already closed */ } });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve({ server, db }); });
  });
}

if (require.main === module) {
  start().then(() => {
    console.log(`\n  Lekhira Writes is running at ${PUBLIC_ORIGIN}\n  Data: ${DATA_DIR}\n  Mode: ${PRODUCTION ? 'production' : 'development'}\n  Press Ctrl C to stop.\n`);
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
