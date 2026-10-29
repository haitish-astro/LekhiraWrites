// Lekhira Writes: end-to-end checks of the API and its security rules.
// Starts a server on a spare port with a throwaway database. Run with `npm test`.
'use strict';
process.env.QUIET = '1';
process.env.PORT = process.env.TEST_PORT || '4391';
const assert = require('node:assert/strict');
const http = require('node:http');
const { start, COOKIE } = require('../server/index.js');

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
  const { server } = await start({ port: Number(process.env.PORT), dbFile: ':memory:' });
  const port = server.address().port;
  base = `http://localhost:${port}`;
  console.log(`\nLekhira Writes tests on ${base}\n`);

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

  server.close();
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
