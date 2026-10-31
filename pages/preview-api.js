'use strict';
// Lekhira Writes — GitHub Pages preview backend.
// GitHub Pages can only serve files, so the preview swaps the server for this stand-in, which
// answers the same API calls from data kept in this browser's localStorage. It follows
// server/routes.js and server/doc.js closely. It is for trying the app, not for real accounts:
// nothing leaves the browser, and anyone using this browser profile can read it.
(() => {
  const real = window.LekhiraApi;
  const { ApiError } = real;
  const DB_KEY = 'lekhira-preview:db';
  const SESSION_KEY = 'lekhira-preview:session';

  const LIMITS = { books: 200, chapters: 500, revisionsPerChapter: 30, revisionEveryMs: 10 * 60 * 1000 };
  const STATUSES = new Set(['idea', 'draft', 'revise', 'done']);
  const COVERS = new Set(['gold', 'ink', 'sage', 'rose', 'dusk', 'paper']);
  const THEMES = new Set(['charcoal', 'ink', 'sepia', 'paper', 'warm']);
  const SIZES = new Set([10, 10.5, 11, 11.5, 12, 13, 14, 16, 18, 20]);
  const LINES = new Set([1.3, 1.5, 1.7, 2]);
  const BLOCK_TYPES = new Set(['p', 'h1', 'h2', 'h3', 'quote', 'break']);
  const STRIP = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩﻿]/g;
  const WORD = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

  const fail = (status, error, extra) => { throw new ApiError(status, { error, ...(extra || {}) }); };
  const newId = (bytes = 12) => {
    const a = crypto.getRandomValues(new Uint8Array(bytes));
    return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  // ---------- storage ----------
  function load() {
    try { return JSON.parse(localStorage.getItem(DB_KEY)) || null; } catch { return null; }
  }
  let db = load() || { users: [], books: [], chapters: [], revisions: [], log: {} };
  function commit() {
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); }
    catch { fail(507, 'This browser is out of space for the preview. Export your book, then delete some books.'); }
  }
  // Another tab may have saved; always work from the latest copy.
  const refresh = () => { db = load() || db; };

  // ---------- documents (as server/doc.js) ----------
  function blockId() { return newId(6); }
  function emptyDoc() { return { v: 1, blocks: [{ id: blockId(), t: 'p', r: [] }] }; }
  const blockText = (b) => b.r.map((r) => r.x).join('');
  const countWords = (doc) => doc.blocks.reduce((n, b) => n + (blockText(b).match(WORD) || []).length, 0);
  function cleanDoc(input) {
    if (!input || typeof input !== 'object' || !Array.isArray(input.blocks)) fail(400, 'The chapter could not be read.');
    if (input.blocks.length > 20000) fail(413, 'This chapter is very long. Please split it into two chapters.');
    const seen = new Set();
    const blocks = [];
    for (const b of input.blocks) {
      if (!b || typeof b !== 'object') fail(400, 'The chapter could not be read.');
      const t = BLOCK_TYPES.has(b.t) ? b.t : 'p';
      let id = typeof b.id === 'string' && /^[A-Za-z0-9_-]{4,24}$/.test(b.id) && !seen.has(b.id) ? b.id : blockId();
      while (seen.has(id)) id = blockId();
      seen.add(id);
      const runs = [];
      if (t !== 'break') {
        for (const run of Array.isArray(b.r) ? b.r : []) {
          if (!run || typeof run.x !== 'string') continue;
          const x = run.x.replace(/\r\n?|\n/g, ' ').replace(STRIP, '');
          if (!x) continue;
          const m = Number.isInteger(run.m) ? run.m & 7 : 0;
          const prev = runs[runs.length - 1];
          if (prev && (prev.m || 0) === m) prev.x += x;
          else runs.push(m ? { x, m } : { x });
        }
      }
      blocks.push({ id, t, r: runs });
    }
    if (!blocks.length) blocks.push({ id: blockId(), t: 'p', r: [] });
    const doc = { v: 1, blocks };
    return { doc, words: countWords(doc) };
  }
  function runToMarkdown(r) {
    const esc = r.x.replace(/([\\`*_[\]#<>])/g, '\\$1');
    const m = r.m || 0;
    if (!m || !esc.trim()) return esc;
    const lead = esc.match(/^\s*/)[0], trail = esc.match(/\s*$/)[0];
    let core = esc.trim();
    if (m & 2) core = `*${core}*`;
    if (m & 1) core = `**${core}**`;
    if (m & 4) core = `<u>${core}</u>`;
    return lead + core + trail;
  }
  function chapterToMarkdown(title, doc) {
    const out = [`# ${title}`, ''];
    for (const b of doc.blocks) {
      const text = b.r.map(runToMarkdown).join('');
      if (b.t === 'break') out.push('* * *');
      else if (b.t === 'h1') out.push(`## ${text}`);
      else if (b.t === 'h2') out.push(`### ${text}`);
      else if (b.t === 'h3') out.push(text.trim() ? `*${runToMarkdown({ x: blockText(b) })}*` : '');
      else if (b.t === 'quote') out.push(`> ${text}`);
      else out.push(text);
      out.push('');
    }
    return out.join('\n');
  }
  function chapterToText(title, doc) {
    const out = [title.toUpperCase(), ''];
    for (const b of doc.blocks) { out.push(b.t === 'break' ? '                *' : blockText(b)); out.push(''); }
    return out.join('\n');
  }

  // ---------- checks (as server/routes.js) ----------
  function text(v, field, max, { required = false, fallback = '' } = {}) {
    if (v === undefined || v === null) { if (required) fail(400, `Please add a ${field}.`, { field }); return fallback; }
    if (typeof v !== 'string') fail(400, `The ${field} could not be read.`, { field });
    const s = v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
    if (required && !s) fail(400, `Please add a ${field}.`, { field });
    if (s.length > max) fail(400, `Please keep the ${field} under ${max} characters.`, { field });
    return s;
  }
  function int(v, field, min, max) {
    if (!Number.isInteger(v) || v < min || v > max) fail(400, `The ${field} must be a whole number from ${min} to ${max}.`, { field });
    return v;
  }
  function cleanEmail(v) {
    const email = String(v ?? '').trim().toLowerCase();
    if (email.length < 3 || email.length > 254 || !/^[^\s@<>()"']+@[^\s@<>()"']+\.[a-z]{2,}$/i.test(email)) fail(400, 'Please enter a valid email address.', { field: 'email' });
    return email;
  }
  function cleanName(v) {
    const name = String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
    if (!name) fail(400, 'Please tell us what to call you.', { field: 'name' });
    if (name.length > 80) fail(400, 'Please use a shorter name (80 characters at most).', { field: 'name' });
    return name;
  }
  function checkNewPassword(v) {
    const pw = typeof v === 'string' ? v : '';
    if (pw.length < 10) fail(400, 'Use at least 10 characters for your password.', { field: 'password' });
    if (pw.length > 200) fail(400, 'Please use a password of 200 characters or fewer.', { field: 'password' });
    return pw;
  }
  function cleanPrefs(input, current) {
    const p = { ...current };
    if (!input || typeof input !== 'object') return p;
    if (THEMES.has(input.theme)) p.theme = input.theme;
    if (typeof input.font === 'string' && /^[A-Za-z ]{1,40}$/.test(input.font)) p.font = input.font;
    if (SIZES.has(input.size)) p.size = input.size;
    if (LINES.has(input.lineHeight)) p.lineHeight = input.lineHeight;
    if (input.paragraph === 'indent' || input.paragraph === 'spaced') p.paragraph = input.paragraph;
    if (input.align === 'left' || input.align === 'justify') p.align = input.align;
    if (typeof input.smartPunct === 'boolean') p.smartPunct = input.smartPunct;
    if (typeof input.typewriter === 'boolean') p.typewriter = input.typewriter;
    return p;
  }

  // Passwords are hashed even here (PBKDF2), so they never sit in storage as typed.
  async function hashPassword(pw, saltB64) {
    const salt = saltB64 ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' }, key, 256);
    const b64 = (u) => btoa(String.fromCharCode(...new Uint8Array(u)));
    return `pbkdf2$${b64(salt)}$${b64(bits)}`;
  }
  async function verifyPassword(pw, stored) {
    const [, salt] = String(stored).split('$');
    return (await hashPassword(pw, salt)) === stored;
  }

  // ---------- helpers ----------
  const sessionUser = () => {
    let id = null;
    try { id = localStorage.getItem(SESSION_KEY); } catch { /* ignore */ }
    return db.users.find((u) => u.id === id) || null;
  };
  // Emails can't be sent from a browser, so preview accounts count as confirmed.
  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, emailVerified: true, dailyGoal: u.dailyGoal, prefs: cleanPrefs(u.prefs, {}) });
  const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
  function writerDay(v) {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Math.abs(Date.parse(v + 'T12:00:00Z') - Date.now()) < 40 * 3600 * 1000) return v;
    return utcDay();
  }
  const bookChapters = (bookId) => db.chapters.filter((c) => c.bookId === bookId).sort((a, b) => a.position - b.position);
  const chapterMeta = (c) => ({ id: c.id, title: c.title, status: c.status, words: c.words, version: c.version, position: c.position, updatedAt: c.updatedAt });
  function bookRow(b, withCounts) {
    const out = { id: b.id, title: b.title, subtitle: b.subtitle, author: b.author, wordGoal: b.wordGoal, cover: b.cover, createdAt: b.createdAt, updatedAt: b.updatedAt, deletedAt: b.deletedAt ?? null };
    if (withCounts) { const ch = bookChapters(b.id); out.chapters = ch.length; out.words = ch.reduce((n, c) => n + c.words, 0); }
    return out;
  }
  function ownBook(u, id, { includeDeleted = false } = {}) {
    const b = db.books.find((x) => x.id === id && x.userId === u.id);
    if (!b || (!includeDeleted && b.deletedAt)) fail(404, 'That book was not found.');
    return b;
  }
  function ownChapter(u, id) {
    const c = db.chapters.find((x) => x.id === id && x.userId === u.id);
    if (!c || db.books.find((b) => b.id === c.bookId).deletedAt) fail(404, 'That chapter was not found.');
    return c;
  }
  const touch = (bookId) => { const b = db.books.find((x) => x.id === bookId); if (b) b.updatedAt = Date.now(); };
  function insertChapter(u, bookId, title, position, doc) {
    const { doc: clean, words } = cleanDoc(doc || emptyDoc());
    const now = Date.now();
    const c = { id: newId(), bookId, userId: u.id, title, position, status: 'draft', doc: clean, words, version: 1, createdAt: now, updatedAt: now };
    db.chapters.push(c);
    return c;
  }
  function createBook(u, { title, author = '', cover = 'gold' }, chapters) {
    if (db.books.filter((b) => b.userId === u.id && !b.deletedAt).length >= LIMITS.books) fail(403, `You can keep up to ${LIMITS.books} books. Move some to the trash first.`);
    const now = Date.now();
    const b = { id: newId(), userId: u.id, title, subtitle: '', author, wordGoal: 0, cover, createdAt: now, updatedAt: now, deletedAt: null };
    db.books.push(b);
    chapters.forEach((c, i) => insertChapter(u, b.id, c.title, i, c.doc));
    return b;
  }
  function sampleDoc() {
    return { v: 1, blocks: [
      'This is your first chapter. Click anywhere on this page and start writing. In this preview, your writing is saved in this browser about a second after you stop typing.',
      'Use the style menu to turn a line into a heading, or press Ctrl B, Ctrl I and Ctrl U for bold, italic and underline. Ctrl Enter adds a scene break.',
      'When you are ready, delete these lines and write the first sentence of your book.',
    ].map((x) => ({ id: blockId(), t: 'p', r: [{ x }] })) };
  }
  function stats(u, today) {
    const log = db.log[u.id] || {};
    let streak = 0;
    const cursor = new Date(today + 'T12:00:00Z');
    if (!log[today]) cursor.setUTCDate(cursor.getUTCDate() - 1);
    while (log[utcDay(cursor)] > 0) { streak++; cursor.setUTCDate(cursor.getUTCDate() - 1); }
    const days = [];
    for (let i = 27; i >= 0; i--) { const d = utcDay(new Date(Date.parse(today + 'T12:00:00Z') - i * 86400000)); days.push({ day: d, words: log[d] || 0 }); }
    const live = new Set(db.books.filter((b) => b.userId === u.id && !b.deletedAt).map((b) => b.id));
    const totalWords = db.chapters.filter((c) => live.has(c.bookId)).reduce((n, c) => n + c.words, 0);
    return { today: log[today] || 0, streak, days, totalWords, dailyGoal: u.dailyGoal };
  }
  function addRevision(c, savedAt) {
    db.revisions.push({ id: newId(), chapterId: c.id, userId: c.userId, version: c.version, doc: c.doc, words: c.words, savedAt });
    const mine = db.revisions.filter((r) => r.chapterId === c.id).sort((a, b) => b.savedAt - a.savedAt);
    const drop = new Set(mine.slice(LIMITS.revisionsPerChapter).map((r) => r.id));
    if (drop.size) db.revisions = db.revisions.filter((r) => !drop.has(r.id));
  }
  const file = (raw, type, name) => ({ __file: true, raw, type, name });

  // ---------- routes ----------
  const routes = [];
  const on = (method, pattern, handler, { auth = true } = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth });
  };

  on('POST', '/api/auth/signup', async (q, body) => {
    const name = cleanName(body.name);
    const email = cleanEmail(body.email);
    const password = checkNewPassword(body.password);
    if (body.agree !== true) fail(400, 'Please agree to the terms to create an account.', { field: 'agree' });
    if (db.users.some((u) => u.email === email)) fail(409, 'An account with this email already exists in this browser. Try signing in.', { field: 'email' });
    const u = { id: newId(), email, name, pwHash: await hashPassword(password), dailyGoal: 500, createdAt: Date.now(),
      prefs: { theme: 'charcoal', font: 'Georgia', size: 12, lineHeight: 1.7, paragraph: 'indent', align: 'left', smartPunct: true } };
    db.users.push(u);
    createBook(u, { title: 'My First Book', author: name }, [{ title: 'Chapter One', doc: sampleDoc() }]);
    localStorage.setItem(SESSION_KEY, u.id);
    return { user: publicUser(u) };
  }, { auth: false });

  on('POST', '/api/auth/signin', async (q, body) => {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const u = db.users.find((x) => x.email === email);
    if (!u || !(await verifyPassword(String(body.password || ''), u.pwHash))) fail(401, 'That email and password don’t match an account in this browser.');
    localStorage.setItem(SESSION_KEY, u.id);
    return { user: publicUser(u) };
  }, { auth: false });

  on('POST', '/api/auth/signout', () => { localStorage.removeItem(SESSION_KEY); return { ok: true }; }, { auth: false });
  on('GET', '/api/me', (q, b, u) => ({ user: publicUser(u) }));
  on('PATCH', '/api/me', (q, body, u) => {
    if (body.name !== undefined) u.name = cleanName(body.name);
    if (body.dailyGoal !== undefined) u.dailyGoal = int(body.dailyGoal, 'daily goal', 0, 20000);
    u.prefs = cleanPrefs(body.prefs, cleanPrefs(u.prefs, {}));
    return { user: publicUser(u) };
  });
  on('POST', '/api/me/password', async (q, body, u) => {
    if (typeof body.current !== 'string' || !(await verifyPassword(body.current, u.pwHash))) fail(400, 'Your current password isn’t right.', { field: 'current' });
    u.pwHash = await hashPassword(checkNewPassword(body.next));
    return { ok: true };
  });
  on('POST', '/api/me/signout-others', () => ({ ok: true }));
  on('POST', '/api/me/verify/resend', () => ({ ok: true, already: true }));
  on('GET', '/api/me/apps', () => ({ apps: [] }));
  const needsServer = () => fail(501, 'This needs the real Lekhira server, which sends emails. The preview keeps accounts only in this browser.');
  on('POST', '/api/auth/forgot', needsServer, { auth: false });
  on('POST', '/api/auth/reset', needsServer, { auth: false });
  on('POST', '/api/auth/verify', needsServer, { auth: false });
  on('GET', '/api/me/sessions', () => ({ sessions: [{ current: true, createdAt: Date.now(), lastSeen: Date.now(), agent: navigator.userAgent }] }));
  on('POST', '/api/me/delete', async (q, body, u) => {
    if (typeof body.password !== 'string' || !(await verifyPassword(body.password, u.pwHash))) fail(400, 'Your password isn’t right.', { field: 'password' });
    if (body.confirm !== 'DELETE') fail(400, 'Please type DELETE to confirm.', { field: 'confirm' });
    db.users = db.users.filter((x) => x.id !== u.id);
    db.books = db.books.filter((x) => x.userId !== u.id);
    db.chapters = db.chapters.filter((x) => x.userId !== u.id);
    db.revisions = db.revisions.filter((x) => x.userId !== u.id);
    delete db.log[u.id];
    localStorage.removeItem(SESSION_KEY);
    return { ok: true };
  });
  on('GET', '/api/me/export', (q, b, u) => file(JSON.stringify({
    format: 'lekhira-writes-export', version: 1, exportedAt: new Date().toISOString(),
    account: { email: u.email, name: u.name, dailyGoal: u.dailyGoal, createdAt: u.createdAt },
    writingLog: Object.entries(db.log[u.id] || {}).map(([day, words]) => ({ day, words })),
    books: db.books.filter((x) => x.userId === u.id).map((x) => ({ ...bookRow(x), chapters: bookChapters(x.id).map((c) => ({ id: c.id, title: c.title, status: c.status, words: c.words, updatedAt: c.updatedAt, doc: c.doc })) })),
  }, null, 2), 'application/json', 'Lekhira Writes export.json'));
  on('GET', '/api/stats', (q, b, u) => stats(u, writerDay(q.get('day'))));

  on('GET', '/api/books', (q, b, u) => ({ books: db.books.filter((x) => x.userId === u.id && !x.deletedAt).sort((a, c) => c.updatedAt - a.updatedAt).map((x) => bookRow(x, true)) }));
  on('GET', '/api/trash', (q, b, u) => ({ books: db.books.filter((x) => x.userId === u.id && x.deletedAt).sort((a, c) => c.deletedAt - a.deletedAt).map((x) => bookRow(x, true)) }));
  on('POST', '/api/books', (q, body, u) => ({ book: bookRow(createBook(u, { title: text(body.title, 'title', 200, { required: true }), author: u.name, cover: COVERS.has(body.cover) ? body.cover : 'gold' }, [{ title: 'Chapter One' }])) }));
  on('GET', '/api/books/:id', (q, b, u, p) => { const bk = ownBook(u, p.id); return { book: bookRow(bk), chapters: bookChapters(bk.id).map(chapterMeta) }; });
  on('PATCH', '/api/books/:id', (q, body, u, p) => {
    const bk = ownBook(u, p.id);
    if (body.title !== undefined) bk.title = text(body.title, 'title', 200, { required: true });
    if (body.subtitle !== undefined) bk.subtitle = text(body.subtitle, 'subtitle', 300);
    if (body.author !== undefined) bk.author = text(body.author, 'author name', 120);
    if (body.wordGoal !== undefined) bk.wordGoal = int(body.wordGoal, 'word goal', 0, 2000000);
    if (COVERS.has(body.cover)) bk.cover = body.cover;
    bk.updatedAt = Date.now();
    return { book: bookRow(bk) };
  });
  on('DELETE', '/api/books/:id', (q, b, u, p) => { ownBook(u, p.id).deletedAt = Date.now(); return { ok: true }; });
  on('POST', '/api/books/:id/restore', (q, b, u, p) => { const bk = ownBook(u, p.id, { includeDeleted: true }); bk.deletedAt = null; bk.updatedAt = Date.now(); return { ok: true }; });
  on('POST', '/api/books/:id/destroy', (q, body, u, p) => {
    const bk = ownBook(u, p.id, { includeDeleted: true });
    if (!bk.deletedAt) fail(400, 'Move the book to the trash first.');
    if (body.confirm !== bk.title) fail(400, 'Type the book’s title to delete it forever.', { field: 'confirm' });
    const ids = new Set(bookChapters(bk.id).map((c) => c.id));
    db.books = db.books.filter((x) => x.id !== bk.id);
    db.chapters = db.chapters.filter((c) => !ids.has(c.id));
    db.revisions = db.revisions.filter((r) => !ids.has(r.chapterId));
    return { ok: true };
  });
  on('GET', '/api/books/:id/export', (q, b, u, p) => {
    const bk = ownBook(u, p.id);
    const ch = bookChapters(bk.id);
    const format = q.get('format');
    if (format === 'md') return file(ch.map((c) => chapterToMarkdown(c.title, c.doc)).join('\n'), 'text/markdown', `${bk.title}.md`);
    if (format === 'txt') return file([bk.title.toUpperCase(), bk.subtitle, bk.author ? `by ${bk.author}` : '', '', ''].join('\n') + ch.map((c) => chapterToText(c.title, c.doc)).join('\n\n'), 'text/plain', `${bk.title}.txt`);
    if (format === 'json') return { book: bookRow(bk), chapters: ch.map((c) => ({ id: c.id, title: c.title, status: c.status, doc: c.doc })) };
    return fail(400, 'Choose Markdown or plain text.');
  });

  on('POST', '/api/books/:id/chapters', (q, body, u, p) => {
    const bk = ownBook(u, p.id);
    const list = bookChapters(bk.id);
    if (list.length >= LIMITS.chapters) fail(403, `A book can have up to ${LIMITS.chapters} chapters.`);
    const title = text(body.title, 'chapter title', 200, { fallback: `Chapter ${list.length + 1}` }) || `Chapter ${list.length + 1}`;
    let pos = list.length;
    const after = list.find((c) => c.id === body.after);
    if (after) { pos = after.position + 1; list.forEach((c) => { if (c.position >= pos) c.position++; }); }
    const c = insertChapter(u, bk.id, title, pos, null);
    touch(bk.id);
    return { chapter: chapterMeta(c), chapters: bookChapters(bk.id).map(chapterMeta) };
  });
  on('PUT', '/api/books/:id/order', (q, body, u, p) => {
    const bk = ownBook(u, p.id);
    const list = bookChapters(bk.id);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (ids.length !== list.length || new Set(ids).size !== ids.length || !ids.every((i) => list.some((c) => c.id === i))) fail(409, 'The chapter list changed somewhere else. Reload to see the latest.');
    ids.forEach((id, i) => { list.find((c) => c.id === id).position = i; });
    touch(bk.id);
    return { chapters: bookChapters(bk.id).map(chapterMeta) };
  });
  on('GET', '/api/chapters/:id', (q, b, u, p) => { const c = ownChapter(u, p.id); return { chapter: { ...chapterMeta(c), bookId: c.bookId, doc: c.doc } }; });
  on('PUT', '/api/chapters/:id', (q, body, u, p) => {
    const c = ownChapter(u, p.id);
    if (body.force !== true && body.baseVersion !== c.version) fail(409, 'This chapter was changed in another tab or device.', { conflict: { version: c.version, updatedAt: c.updatedAt, words: c.words } });
    const { doc, words } = cleanDoc(body.doc);
    const now = Date.now();
    if (JSON.stringify(doc) !== JSON.stringify(c.doc)) {
      const last = db.revisions.filter((r) => r.chapterId === c.id).reduce((m, r) => Math.max(m, r.savedAt), 0);
      if (!last || now - last > LIMITS.revisionEveryMs || body.force === true) addRevision(c, c.updatedAt);
    }
    const delta = words - c.words;
    Object.assign(c, { doc, words, version: c.version + 1, updatedAt: now });
    touch(c.bookId);
    if (delta > 0) {
      const day = writerDay(body.day);
      const log = (db.log[u.id] = db.log[u.id] || {});
      log[day] = (log[day] || 0) + Math.min(delta, 50000);
    }
    return { version: c.version, words, updatedAt: now };
  });
  on('PATCH', '/api/chapters/:id', (q, body, u, p) => {
    const c = ownChapter(u, p.id);
    if (body.title !== undefined) c.title = text(body.title, 'chapter title', 200, { required: true });
    if (body.status !== undefined && STATUSES.has(body.status)) c.status = body.status;
    touch(c.bookId);
    return { chapter: chapterMeta(c) };
  });
  on('DELETE', '/api/chapters/:id', (q, b, u, p) => {
    const c = ownChapter(u, p.id);
    const list = bookChapters(c.bookId);
    if (list.length <= 1) fail(400, 'A book needs at least one chapter.');
    db.chapters = db.chapters.filter((x) => x.id !== c.id);
    db.revisions = db.revisions.filter((r) => r.chapterId !== c.id);
    bookChapters(c.bookId).forEach((x, i) => { x.position = i; });
    touch(c.bookId);
    return { chapters: bookChapters(c.bookId).map(chapterMeta) };
  });
  on('GET', '/api/chapters/:id/revisions', (q, b, u, p) => {
    const c = ownChapter(u, p.id);
    return { revisions: db.revisions.filter((r) => r.chapterId === c.id).sort((a, d) => d.savedAt - a.savedAt).map((r) => ({ id: r.id, version: r.version, words: r.words, savedAt: r.savedAt })) };
  });
  on('GET', '/api/chapters/:id/revisions/:rid', (q, b, u, p) => {
    const c = ownChapter(u, p.id);
    const r = db.revisions.find((x) => x.id === p.rid && x.chapterId === c.id);
    if (!r) fail(404, 'That version was not found.');
    return { revision: { id: r.id, words: r.words, savedAt: r.savedAt, doc: r.doc } };
  });
  on('POST', '/api/chapters/:id/restore', (q, body, u, p) => {
    const c = ownChapter(u, p.id);
    const r = db.revisions.find((x) => x.id === body.revisionId && x.chapterId === c.id);
    if (!r) fail(404, 'That version was not found.');
    const now = Date.now();
    addRevision(c, now);
    Object.assign(c, { doc: r.doc, words: r.words, version: c.version + 1, updatedAt: now });
    touch(c.bookId);
    return { chapter: { ...chapterMeta(c), doc: c.doc } };
  });

  // ---------- the same interface as api.js ----------
  async function request(method, path, body) {
    refresh();
    const url = new URL(path, location.origin);
    const route = routes.find((r) => r.method === method && r.re.test(url.pathname));
    if (!route) fail(404, 'Not found.');
    const m = url.pathname.match(route.re);
    const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const user = sessionUser();
    if (route.auth && !user) {
      if (real.pagePath().startsWith('/app')) window.dispatchEvent(new CustomEvent('lekhira:signed-out'));
      fail(401, 'Please sign in again.');
    }
    const out = await route.handler(url.searchParams, body ? JSON.parse(JSON.stringify(body)) : {}, user, params);
    commit();
    return JSON.parse(JSON.stringify(out));
  }

  async function download(path) {
    const out = await request('GET', path);
    if (!out.__file) return;
    const blobUrl = URL.createObjectURL(new Blob([out.raw], { type: `${out.type};charset=utf-8` }));
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = out.name.replace(/[\\/:*?"<>|]+/g, '');
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
  }

  window.LekhiraApi = {
    ApiError, base: real.base, page: real.page, pagePath: real.pagePath, preview: true,
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b || {}),
    put: (p, b) => request('PUT', p, b || {}),
    patch: (p, b) => request('PATCH', p, b || {}),
    del: (p) => request('DELETE', p),
    download,
  };
})();
