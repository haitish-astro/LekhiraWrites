// Lekhira Writes: end-to-end checks of the API and its security rules.
// Starts a server on a spare port with a throwaway database. Run with `npm test`.
'use strict';
process.env.QUIET = '1';
process.env.PORT = process.env.TEST_PORT || '4391';
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { start, COOKIE } = require('../server/index.js');
const { createMailer } = require('../server/mail.js');
const desktop = require('../tools/desktop-signin.js');
const mailer = createMailer({ provider: 'memory' });
// The link in the newest email of a kind, sent to an address.
const mailTo = (to, kind) => [...mailer.sent].reverse().find((m) => m.to === to && m.kind === kind);
const tokenIn = (m) => (/#token=([A-Za-z0-9_-]+)/.exec(m.text) || [])[1];

let base;
let passed = 0;
const failures = [];

async function call(method, path, { body, cookie, headers = {}, raw } = {}) {
  const h = { 'X-Lekhira': '1', Origin: base, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
  const res = await fetch(base + path, { method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
const cookieFrom = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failures.push(name); console.log(`  ✗ ${name}\n    ${e.message.split('\n').join('\n    ')}`); }
}

function rawRequest(path, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = http.request({ host: u.hostname, port: u.port, path, headers }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const { server, db } = await start({ port: Number(process.env.PORT), dbFile: ':memory:', mailer });
  const port = server.address().port;
  base = `http://localhost:${port}`;
  console.log(`\nLekhira Writes tests on ${base} (${db.dialect})\n`);

  let alice, bob, aliceBook, chapter;

  await test('security headers on pages', async () => {
    const r = await call('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  });

  await test('weak password is refused', async () => {
    const r = await call('POST', '/api/auth/signup', { body: { name: 'Alice', email: 'alice@example.com', password: 'password1', agree: true } });
    assert.equal(r.status, 400);
    assert.equal(r.json.field, 'password');
  });

  await test('sign up sets an HttpOnly, SameSite=Strict session cookie', async () => {
    const r = await call('POST', '/api/auth/signup', { body: { name: 'Alice Writer', email: 'Alice@Example.com', password: 'a lantern by the sea', agree: true } });
    assert.equal(r.status, 201, r.text);
    const sc = r.headers.get('set-cookie');
    assert.match(sc, new RegExp(`^${COOKIE}=`));
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Strict/);
    alice = cookieFrom(r);
    assert.equal(r.json.user.email, 'alice@example.com');
    assert.equal(r.json.user.pw_hash, undefined);
  });

  await test('duplicate email is refused', async () => {
    const r = await call('POST', '/api/auth/signup', { body: { name: 'A', email: 'alice@example.com', password: 'another long phrase', agree: true } });
    assert.equal(r.status, 409);
  });

  await test('new account gets a first book', async () => {
    const r = await call('GET', '/api/books', { cookie: alice });
    assert.equal(r.status, 200);
    assert.equal(r.json.books.length, 1);
    aliceBook = r.json.books[0];
    const b = await call('GET', `/api/books/${aliceBook.id}`, { cookie: alice });
    chapter = b.json.chapters[0];
    assert.ok(chapter.id);
  });

  await test('requests without the app header are blocked', async () => {
    const r = await call('POST', '/api/books', { cookie: alice, body: { title: 'X' }, headers: { 'X-Lekhira': null } });
    assert.equal(r.status, 403);
  });

  await test('requests from another site are blocked', async () => {
    const r = await call('POST', '/api/books', { cookie: alice, body: { title: 'X' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
  });

  await test('non-JSON bodies are refused', async () => {
    const r = await call('POST', '/api/books', { cookie: alice, raw: 'title=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(r.status, 415);
  });

  await test('signed-out requests get 401', async () => {
    const r = await call('GET', '/api/books');
    assert.equal(r.status, 401);
    const bad = await call('GET', '/api/books', { cookie: `${COOKIE}=${'x'.repeat(43)}` });
    assert.equal(bad.status, 401);
  });

  await test('/app redirects to sign in when signed out', async () => {
    const r = await call('GET', '/app');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/signin');
  });

  await test('wrong password gives one generic message', async () => {
    const a = await call('POST', '/api/auth/signin', { body: { email: 'alice@example.com', password: 'wrong wrong wrong' } });
    const b = await call('POST', '/api/auth/signin', { body: { email: 'nobody@example.com', password: 'wrong wrong wrong' } });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.json.error, b.json.error);
  });

  await test('chapter text is stored as plain text, never markup', async () => {
    const doc = { v: 1, blocks: [
      { id: 'blk1', t: 'p', r: [{ x: '<img src=x onerror=alert(1)>', m: 1 }, { x: ' and ', m: 0 }, { x: '<script>bad()</script>', m: 99 }] },
      { id: 'blk2', t: 'iframe', r: [{ x: 'unknown type\u0000‮' }] },
      { id: 'blk1', t: 'h1', r: [{ x: 'Duplicate id' }] },
      { t: 'break', r: [{ x: 'ignored' }] },
    ] };
    const r = await call('PUT', `/api/chapters/${chapter.id}`, { cookie: alice, body: { doc, baseVersion: chapter.version } });
    assert.equal(r.status, 200, r.text);
    const g = await call('GET', `/api/chapters/${chapter.id}`, { cookie: alice });
    const blocks = g.json.chapter.doc.blocks;
    assert.equal(blocks[0].r[0].x, '<img src=x onerror=alert(1)>');
    assert.equal(blocks[0].r[2].m, 99 & 7);
    assert.equal(blocks[1].t, 'p');
    assert.equal(blocks[1].r[0].x, 'unknown type');
    assert.notEqual(blocks[2].id, 'blk1');
    assert.deepEqual(blocks[3].r, []);
    chapter = g.json.chapter;
  });

  await test('saving over a newer version is refused (409)', async () => {
    const r = await call('PUT', `/api/chapters/${chapter.id}`, { cookie: alice, body: { doc: chapter.doc, baseVersion: chapter.version - 1 } });
    assert.equal(r.status, 409);
    assert.equal(r.json.conflict.version, chapter.version);
  });

  await test('two saves of the same version at once: one wins, the other is refused (409)', async () => {
    const edit = (word) => ({ doc: { v: 1, blocks: [...chapter.doc.blocks, { id: 'race1', t: 'p', r: [{ x: word }] }] }, baseVersion: chapter.version });
    const both = await Promise.all(['left', 'right'].map((w) => call('PUT', `/api/chapters/${chapter.id}`, { cookie: alice, body: edit(w) })));
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], both.map((r) => r.text).join(' | '));
    chapter = (await call('GET', `/api/chapters/${chapter.id}`, { cookie: alice })).json.chapter;
    assert.equal(chapter.version, both.find((r) => r.status === 200).json.version);
  });

  await test('words written today are counted', async () => {
    const more = { v: 1, blocks: [...chapter.doc.blocks, { id: 'more1', t: 'p', r: [{ x: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight twenty-nine thirty thirty-one thirty-two thirty-three thirty-four thirty-five thirty-six thirty-seven thirty-eight thirty-nine forty forty-one forty-two forty-three forty-four forty-five' }] }] };
    const before = (await call('GET', '/api/stats', { cookie: alice })).json.today;
    const r = await call('PUT', `/api/chapters/${chapter.id}`, { cookie: alice, body: { doc: more, baseVersion: chapter.version } });
    assert.equal(r.status, 200, r.text);
    chapter = (await call('GET', `/api/chapters/${chapter.id}`, { cookie: alice })).json.chapter;
    const s = await call('GET', '/api/stats', { cookie: alice });
    assert.equal(s.json.today - before, 45);
    assert.equal(s.json.streak, 1);
  });

  await test('another writer cannot see or change Alice’s book', async () => {
    const r = await call('POST', '/api/auth/signup', { body: { name: 'Bob', email: 'bob@example.com', password: 'a different long phrase', agree: true } });
    bob = cookieFrom(r);
    assert.equal((await call('GET', `/api/books/${aliceBook.id}`, { cookie: bob })).status, 404);
    assert.equal((await call('GET', `/api/chapters/${chapter.id}`, { cookie: bob })).status, 404);
    assert.equal((await call('PUT', `/api/chapters/${chapter.id}`, { cookie: bob, body: { doc: chapter.doc, force: true } })).status, 404);
    assert.equal((await call('DELETE', `/api/books/${aliceBook.id}`, { cookie: bob })).status, 404);
    assert.equal((await call('GET', `/api/books/${aliceBook.id}/export?format=md`, { cookie: bob })).status, 404);
  });

  await test('Markdown export works and is an attachment', async () => {
    const r = await call('GET', `/api/books/${aliceBook.id}/export?format=md`, { cookie: alice });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /^attachment;/);
    assert.match(r.text, /# Chapter One/);
  });

  await test('version history keeps and restores earlier text', async () => {
    const v = await call('GET', `/api/chapters/${chapter.id}/revisions`, { cookie: alice });
    assert.ok(v.json.revisions.length >= 1);
    const r = await call('POST', `/api/chapters/${chapter.id}/restore`, { cookie: alice, body: { revisionId: v.json.revisions[0].id } });
    assert.equal(r.status, 200);
    assert.match(r.json.chapter.doc.blocks[0].r[0].x, /first chapter/);
  });

  await test('static files cannot escape the public folder', async () => {
    for (const p of ['/css/../server/index.js', '/js/..%2fserver%2findex.js', '/js/%2e%2e/%2e%2e/package.json', '/.env', '/server/index.js']) {
      const r = await call('GET', p);
      assert.ok(r.status === 404 || r.status === 400, `${p} gave ${r.status}`);
      assert.doesNotMatch(r.text, /require\(/);
    }
  });

  await test('the health check answers for any host and shows nothing else', async () => {
    assert.equal(await rawRequest('/healthz', { Host: 'internal.example' }), 200);
    assert.equal(await rawRequest('/healthz?x', { Host: 'internal.example' }), 421);
  });

  await test('behind proxies, the visitor’s address is counted from the right, so it can’t be faked', () => {
    const { clientIp } = require('../server/security.js');
    const req = (xff) => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '10.0.0.9' } });
    assert.equal(clientIp(req('6.6.6.6, 203.0.113.7'), 1), '203.0.113.7');
    assert.equal(clientIp(req('6.6.6.6, 203.0.113.7, 172.68.1.1'), 2), '203.0.113.7');
    assert.equal(clientIp(req('6.6.6.6'), 0), '10.0.0.9');
  });

  if (db.dialect === 'postgres') {
    await test('Postgres tables are closed to Supabase’s public Data API (row-level security)', async () => {
      const open = await db.all("SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace AND NOT relrowsecurity");
      assert.deepEqual(open.map((r) => r.relname), []);
    });
  }

  await test('unknown Host headers are refused (DNS rebinding)', async () => {
    assert.equal(await rawRequest('/api/me', { Host: 'evil.example' }), 421);
  });

  await test('oversized requests are refused', async () => {
    const r = await call('POST', '/api/books', { cookie: alice, raw: JSON.stringify({ title: 'x'.repeat(70 * 1024) }), headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 413);
  });

  await test('password change signs out other sessions', async () => {
    const other = cookieFrom(await call('POST', '/api/auth/signin', { body: { email: 'alice@example.com', password: 'a lantern by the sea' } }));
    assert.equal((await call('GET', '/api/me', { cookie: other })).status, 200);
    const r = await call('POST', '/api/me/password', { cookie: alice, body: { current: 'a lantern by the sea', next: 'the harbour lights at dusk' } });
    assert.equal(r.status, 200, r.text);
    alice = cookieFrom(r);
    assert.equal((await call('GET', '/api/me', { cookie: other })).status, 401);
    assert.equal((await call('GET', '/api/me', { cookie: alice })).status, 200);
  });

  await test('repeated wrong passwords are rate limited', async () => {
    let last;
    for (let i = 0; i < 10; i++) last = await call('POST', '/api/auth/signin', { body: { email: 'bob@example.com', password: `nope ${i} nope nope` } });
    assert.equal(last.status, 429);
    assert.ok(last.headers.get('retry-after'));
  });

  await test('trash, restore and permanent delete', async () => {
    const nb = await call('POST', '/api/books', { cookie: alice, body: { title: 'Scratch' } });
    const id = nb.json.book.id;
    assert.equal((await call('DELETE', `/api/books/${id}`, { cookie: alice })).status, 200);
    assert.equal((await call('GET', '/api/trash', { cookie: alice })).json.books.length, 1);
    assert.equal((await call('POST', `/api/books/${id}/destroy`, { cookie: alice, body: { confirm: 'wrong' } })).status, 400);
    assert.equal((await call('POST', `/api/books/${id}/destroy`, { cookie: alice, body: { confirm: 'Scratch' } })).status, 200);
    assert.equal((await call('GET', '/api/trash', { cookie: alice })).json.books.length, 0);
  });

  await test('account deletion needs the password and removes everything', async () => {
    assert.equal((await call('POST', '/api/me/delete', { cookie: bob, body: { password: 'wrong', confirm: 'DELETE' } })).status, 400);
    assert.equal((await call('POST', '/api/me/delete', { cookie: bob, body: { password: 'a different long phrase', confirm: 'DELETE' } })).status, 200);
    assert.equal((await call('GET', '/api/me', { cookie: bob })).status, 401);
  });

  // ---------- Phase 1: the shared Lekhira account ----------
  let carol;
  const carolEmail = 'carol@example.com';
  let carolPassword = 'a quiet room with a view';
  const count = (kind) => mailer.sent.filter((m) => m.to === carolEmail && m.kind === kind).length;

  await test('sign-up sends a confirmation email; its link confirms the address once', async () => {
    const r = await call('POST', '/api/auth/signup', { body: { name: 'Carol Poet', email: carolEmail, password: carolPassword, agree: true } });
    assert.equal(r.status, 201, r.text);
    carol = cookieFrom(r);
    assert.equal(r.json.user.emailVerified, false);
    const mail = mailTo(carolEmail, 'verify');
    assert.ok(mail, 'no confirmation email was sent');
    assert.match(mail.text, /\/verify#token=/);
    const t = tokenIn(mail);
    assert.equal((await call('POST', '/api/auth/verify', { body: { token: t } })).status, 200);
    assert.equal((await call('GET', '/api/me', { cookie: carol })).json.user.emailVerified, true);
    assert.equal((await call('POST', '/api/auth/verify', { body: { token: t } })).status, 400);
  });

  await test('a sign-in from a new browser sends an alert; a known browser does not', async () => {
    const before = count('new-sign-in');
    const a = await call('POST', '/api/auth/signin', { body: { email: carolEmail, password: carolPassword } });
    assert.equal(a.status, 200, a.text);
    assert.equal(count('new-sign-in'), before + 1);
    const device = a.headers.getSetCookie().find((c) => c.startsWith('lw_device=')).split(';')[0];
    await call('POST', '/api/auth/signin', { cookie: device, body: { email: carolEmail, password: carolPassword } });
    assert.equal(count('new-sign-in'), before + 1);
  });

  await test('forgot password: one answer for any email; a one-time link; everyone signed out', async () => {
    const n = mailer.sent.length;
    const x = await call('POST', '/api/auth/forgot', { body: { email: 'nobody@example.com' } });
    const y = await call('POST', '/api/auth/forgot', { body: { email: carolEmail } });
    assert.equal(x.status, 200);
    assert.equal(x.json.message, y.json.message);
    assert.equal(mailer.sent.length, n + 1, 'only the real account gets an email');
    const t = tokenIn(mailTo(carolEmail, 'reset'));
    // A weak new password is refused without using up the link.
    assert.equal((await call('POST', '/api/auth/reset', { body: { token: t, password: 'short' } })).status, 400);
    carolPassword = 'a brand new lantern phrase';
    const r = await call('POST', '/api/auth/reset', { body: { token: t, password: carolPassword } });
    assert.equal(r.status, 200, r.text);
    assert.equal((await call('GET', '/api/me', { cookie: carol })).status, 401, 'the old session should end');
    carol = cookieFrom(r);
    assert.equal((await call('GET', '/api/me', { cookie: carol })).status, 200);
    assert.equal((await call('POST', '/api/auth/reset', { body: { token: t, password: 'another new phrase here' } })).status, 400);
    assert.ok(mailTo(carolEmail, 'password-changed'));
  });

  // Desktop sign-in, done the way Lekhira Writing Studio will do it.
  const REDIRECT = 'http://127.0.0.1:53111/callback';
  const pkce = () => {
    const verifier = crypto.randomBytes(48).toString('base64url');
    return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
  };
  const authParams = (p, extra = {}) => ({
    client_id: 'lekhira-studio', redirect_uri: REDIRECT, response_type: 'code',
    code_challenge: p.challenge, code_challenge_method: 'S256', state: 'st-123', device_name: 'Test laptop', ...extra,
  });
  const tokenPost = (params) => fetch(`${base}/api/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));
  async function signInApp(cookie) {
    const p = pkce();
    const ap = await call('POST', '/api/oauth/approve', { cookie, body: authParams(p) });
    assert.equal(ap.status, 200, ap.text);
    const code = new URL(ap.json.redirect).searchParams.get('code');
    const t = await tokenPost({ grant_type: 'authorization_code', code, code_verifier: p.verifier, redirect_uri: REDIRECT, client_id: 'lekhira-studio' });
    assert.equal(t.status, 200, JSON.stringify(t.json));
    return t.json;
  }

  await test('desktop sign-in: bad requests are refused before anyone signs in', async () => {
    const p = pkce();
    const q = (o) => `/oauth/authorize?${new URLSearchParams(authParams(p, o))}`;
    assert.equal((await call('GET', q({ redirect_uri: 'https://evil.example/callback' }))).status, 400);
    assert.equal((await call('GET', q({ client_id: 'someone-else' }))).status, 400);
    assert.equal((await call('GET', q({ code_challenge_method: 'plain' }))).status, 400);
    const r = await call('GET', q({}));
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /^\/signin\?next=%2Foauth%2Fauthorize%3F/);
    assert.equal((await call('GET', q({}), { cookie: carol })).status, 200);
  });

  await test('desktop sign-in needs a confirmed email address', async () => {
    const r = await call('POST', '/api/oauth/approve', { cookie: alice, body: authParams(pkce()) });
    assert.equal(r.status, 403);
    assert.equal(r.json.needsVerification, true);
  });

  await test('desktop sign-in: the code works once, only with its PKCE verifier', async () => {
    const p = pkce();
    const ap = await call('POST', '/api/oauth/approve', { cookie: carol, body: authParams(p) });
    const back = new URL(ap.json.redirect);
    assert.equal(back.origin, 'http://127.0.0.1:53111');
    assert.equal(back.searchParams.get('state'), 'st-123');
    const req = { grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: REDIRECT, client_id: 'lekhira-studio' };
    assert.equal((await tokenPost({ ...req, code_verifier: pkce().verifier })).status, 400, 'a wrong verifier must fail');
    const t = await tokenPost({ ...req, code_verifier: p.verifier });
    assert.equal(t.status, 200);
    assert.match(t.json.access_token, /^lka_/);
    assert.match(t.json.refresh_token, /^lkr_/);
    assert.equal((await desktop.me(base, t.json.access_token)).user.email, carolEmail);
    // Using the code a second time fails, and ends the sign-in it was swapped for.
    assert.equal((await tokenPost({ ...req, code_verifier: p.verifier })).status, 400);
    await assert.rejects(desktop.me(base, t.json.access_token));
    assert.match(mailTo(carolEmail, 'new-sign-in').text, /Lekhira Writing Studio on “Test laptop”/);
  });

  await test('the desktop API takes Bearer tokens only, never the browser cookie', async () => {
    assert.equal((await call('GET', '/api/v1/me', { cookie: carol })).status, 401);
    assert.equal((await call('GET', '/api/v1/me', { headers: { Authorization: 'Bearer lka_not-a-real-token' } })).status, 401);
    const t = await signInApp(carol);
    const me = await desktop.me(base, t.access_token);
    assert.deepEqual(me.entitlements, { writes: true, studio: false, sync: false });
    await desktop.signOut(base, t.refresh_token);
    await assert.rejects(desktop.me(base, t.access_token));
  });

  await test('desktop tokens refresh; a reused refresh token ends that sign-in', async () => {
    const t = await signInApp(carol);
    const n = await desktop.refresh(base, t.refresh_token);
    await desktop.me(base, n.access_token);
    await assert.rejects(desktop.me(base, t.access_token), 'the old access token is replaced');
    await assert.rejects(desktop.refresh(base, t.refresh_token));
    await assert.rejects(desktop.me(base, n.access_token), 'reuse should end the sign-in');
  });

  await test('apps show in the Account panel and can be signed out there, or by a password change', async () => {
    const t = await signInApp(carol);
    const apps = (await call('GET', '/api/me/apps', { cookie: carol })).json.apps;
    assert.equal(apps.length, 1);
    assert.equal(apps[0].app, 'Lekhira Writing Studio');
    assert.equal(apps[0].device, 'Test laptop');
    assert.equal((await call('POST', `/api/me/apps/${apps[0].id}/revoke`, { cookie: carol })).status, 200);
    await assert.rejects(desktop.me(base, t.access_token));
    const t2 = await signInApp(carol);
    const r = await call('POST', '/api/me/password', { cookie: carol, body: { current: carolPassword, next: 'one more fresh phrase' } });
    assert.equal(r.status, 200, r.text);
    await assert.rejects(desktop.me(base, t2.access_token));
  });

  server.close();
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
