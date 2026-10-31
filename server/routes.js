// Lekhira Writes: the JSON API. Every handler that reads or writes a book checks that it
// belongs to the signed-in writer; ids that aren't theirs get the same 404 as ids that
// don't exist.
'use strict';
const { tx } = require('./db');
const auth = require('./auth');
const { HttpError, limit, newId, isId } = require('./security');
const docs = require('./doc');

const LIMITS = { books: 200, chapters: 500, revisionsPerChapter: 30, revisionEveryMs: 10 * 60 * 1000 };
const STATUSES = new Set(['idea', 'draft', 'revise', 'done']);
const COVERS = new Set(['gold', 'ink', 'sage', 'rose', 'dusk', 'paper']);
// Writing room choices, the same as Lekhira Studio's.
const THEMES = new Set(['charcoal', 'ink', 'sepia', 'paper', 'warm']);
const FONTS = new Set([
  'Georgia', 'Times New Roman', 'Sitka Text', 'Palatino Linotype', 'Book Antiqua', 'Garamond', 'Baskerville Old Face',
  'Cambria', 'Constantia', 'Bookman Old Style', 'Century Schoolbook', 'Lucida Bright', 'Segoe UI', 'Calibri', 'Candara',
  'Verdana', 'Trebuchet MS', 'Gill Sans MT', 'Comic Sans MS', 'Segoe Print', 'Segoe Script', 'Ink Free', 'Courier New',
  'Consolas', 'Cascadia Mono', 'Literata', 'Cormorant Garamond',
]);
const SIZES = new Set([10, 10.5, 11, 11.5, 12, 13, 14, 16, 18, 20]);
const LINES = new Set([1.3, 1.5, 1.7, 2]);

function text(v, field, max, { required = false, fallback = '' } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, `Please add a ${field}.`, { field });
    return fallback;
  }
  if (typeof v !== 'string') throw new HttpError(400, `The ${field} could not be read.`, { field });
  const s = v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  if (required && !s) throw new HttpError(400, `Please add a ${field}.`, { field });
  if (s.length > max) throw new HttpError(400, `Please keep the ${field} under ${max} characters.`, { field });
  return s;
}

function int(v, field, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw new HttpError(400, `The ${field} must be a whole number from ${min} to ${max}.`, { field });
  return v;
}

function utcDay(d = new Date()) { return d.toISOString().slice(0, 10); }
// The writer's own calendar day (sent by the browser) if it is within a day of ours.
function writerDay(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const diff = Math.abs(Date.parse(v + 'T12:00:00Z') - Date.now());
    if (diff < 40 * 3600 * 1000) return v;
  }
  return utcDay();
}

function cleanPrefs(input, current) {
  const p = { ...current };
  if (!input || typeof input !== 'object') return p;
  if (THEMES.has(input.theme)) p.theme = input.theme;
  if (FONTS.has(input.font)) p.font = input.font;
  if (SIZES.has(input.size)) p.size = input.size;
  if (LINES.has(input.lineHeight)) p.lineHeight = input.lineHeight;
  if (input.paragraph === 'indent' || input.paragraph === 'spaced') p.paragraph = input.paragraph;
  if (input.align === 'left' || input.align === 'justify') p.align = input.align;
  if (typeof input.smartPunct === 'boolean') p.smartPunct = input.smartPunct;
  if (typeof input.typewriter === 'boolean') p.typewriter = input.typewriter;
  if (typeof input.toured === 'boolean') p.toured = input.toured;
  return p;
}
function readPrefs(json) { try { return cleanPrefs(JSON.parse(json), {}); } catch { return {}; } }

function publicUser(u) {
  const verified = u.emailVerifiedAt !== undefined ? u.emailVerifiedAt : u.email_verified_at;
  return { id: u.id, email: u.email, name: u.name, emailVerified: !!verified, dailyGoal: u.dailyGoal ?? u.daily_goal, prefs: readPrefs(u.prefs) };
}

function bookRow(r) {
  return {
    id: r.id, title: r.title, subtitle: r.subtitle, author: r.author, wordGoal: r.word_goal, cover: r.cover,
    createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at ?? null,
    chapters: r.chapters ?? undefined, words: r.words ?? undefined,
  };
}
function chapterMeta(r) {
  return { id: r.id, title: r.title, status: r.status, words: r.words, version: r.version, position: r.position, updatedAt: r.updated_at };
}

function ownBook(db, userId, bookId, { includeDeleted = false } = {}) {
  if (!isId(bookId)) throw new HttpError(404, 'That book was not found.');
  const row = db.prepare('SELECT * FROM books WHERE id = ? AND user_id = ?').get(bookId, userId);
  if (!row || (!includeDeleted && row.deleted_at)) throw new HttpError(404, 'That book was not found.');
  return row;
}
function ownChapter(db, userId, chapterId) {
  if (!isId(chapterId)) throw new HttpError(404, 'That chapter was not found.');
  const row = db.prepare(`SELECT c.* FROM chapters c JOIN books b ON b.id = c.book_id
    WHERE c.id = ? AND c.user_id = ? AND b.deleted_at IS NULL`).get(chapterId, userId);
  if (!row) throw new HttpError(404, 'That chapter was not found.');
  return row;
}
function touchBook(db, bookId) { db.prepare('UPDATE books SET updated_at = ? WHERE id = ?').run(Date.now(), bookId); }

function chapterList(db, bookId) {
  return db.prepare('SELECT id, title, status, words, version, position, updated_at FROM chapters WHERE book_id = ? ORDER BY position').all(bookId).map(chapterMeta);
}

function insertChapter(db, userId, bookId, title, position, doc) {
  const id = newId();
  const now = Date.now();
  const { doc: clean, words } = docs.cleanDoc(doc || docs.emptyDoc());
  db.prepare(`INSERT INTO chapters (id, book_id, user_id, title, position, status, doc, words, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, 1, ?, ?)`).run(id, bookId, userId, title, position, JSON.stringify(clean), words, now, now);
  return id;
}

function createBook(db, userId, { title, subtitle = '', author = '', cover = 'gold' }, chapters) {
  const count = db.prepare('SELECT COUNT(*) n FROM books WHERE user_id = ? AND deleted_at IS NULL').get(userId).n;
  if (count >= LIMITS.books) throw new HttpError(403, `You can keep up to ${LIMITS.books} books. Move some to the trash first.`);
  const id = newId();
  const now = Date.now();
  db.prepare('INSERT INTO books (id, user_id, title, subtitle, author, cover, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, title, subtitle, author, cover, now, now);
  chapters.forEach((c, i) => insertChapter(db, userId, id, c.title, i, c.doc));
  return id;
}

function sampleDoc() {
  return docs.docFromParagraphs([
    'This is your first chapter. Click anywhere on this page and start writing. Lekhira saves to your account about a second after you stop typing.',
    'Use the style menu to turn a line into a heading, or press Ctrl B, Ctrl I and Ctrl U for bold, italic and underline. Ctrl Enter adds a scene break.',
    'When you are ready, delete these lines and write the first sentence of your book.',
  ]);
}

function filename(title, ext) {
  const base = title.replace(/[^\p{L}\p{N} ._-]+/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Book';
  const ascii = base.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(base)}.${ext}`;
}

function stats(db, userId, today) {
  const rows = db.prepare('SELECT day, words FROM writing_log WHERE user_id = ? AND day >= ? ORDER BY day DESC')
    .all(userId, utcDay(new Date(Date.parse(today + 'T12:00:00Z') - 400 * 86400000)));
  const byDay = new Map(rows.map((r) => [r.day, r.words]));
  let streak = 0;
  const cursor = new Date(today + 'T12:00:00Z');
  if (!byDay.get(today)) cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (byDay.get(utcDay(cursor)) > 0) { streak++; cursor.setUTCDate(cursor.getUTCDate() - 1); }
  const days = [];
  for (let i = 27; i >= 0; i--) {
    const d = new Date(Date.parse(today + 'T12:00:00Z') - i * 86400000);
    days.push({ day: utcDay(d), words: byDay.get(utcDay(d)) || 0 });
  }
  const total = db.prepare('SELECT COALESCE(SUM(c.words),0) n FROM chapters c JOIN books b ON b.id = c.book_id WHERE c.user_id = ? AND b.deleted_at IS NULL').get(userId).n;
  return { today: byDay.get(today) || 0, streak, days, totalWords: total };
}

// ---------- routes ----------
function register(r, ctx) {
  const { db, limiter, cookies, accounts } = ctx;

  // --- account ---
  r.post('/api/auth/signup', { auth: false }, async (req, res, body) => {
    limit(limiter, `signup:${req.ip}`, 5, 3600_000, 'Too many new accounts from this network. Please try again later.');
    const name = auth.cleanName(body.name);
    const email = auth.cleanEmail(body.email);
    const password = auth.checkNewPassword(body.password, { email, name });
    if (body.agree !== true) throw new HttpError(400, 'Please agree to the terms to create an account.', { field: 'agree' });
    const hash = await auth.hashPassword(password);
    const id = auth.newUserId();
    const now = Date.now();
    try {
      tx(db, () => {
        db.prepare('INSERT INTO users (id, email, name, pw_hash, prefs, created_at, pw_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, email, name, hash, JSON.stringify({ theme: 'charcoal', font: 'Georgia', size: 12, lineHeight: 1.7, paragraph: 'indent', align: 'left', smartPunct: true }), now, now);
        createBook(db, id, { title: 'My First Book', author: name }, [{ title: 'Chapter One', doc: sampleDoc() }]);
      });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'An account with this email already exists. Try signing in.', { field: 'email' });
      throw err;
    }
    const token = auth.createSession(db, id, req.headers['user-agent']);
    cookies.set(res, token);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    accounts.sendVerification(user);
    accounts.noteSignIn(req, res, user, { quiet: true });
    return { status: 201, body: { user: publicUser(user) } };
  });

  r.post('/api/auth/signin', { auth: false }, async (req, res, body) => {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : '';
    const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    limit(limiter, `signin-ip:${req.ip}`, 20, 15 * 60_000);
    limit(limiter, `signin-email:${email}`, 8, 15 * 60_000, 'Too many attempts for this account. Please wait 15 minutes and try again.');
    const user = email ? db.prepare('SELECT * FROM users WHERE email = ?').get(email) : null;
    if (!user || !password) {
      await auth.burnTime(password || 'x');
      throw new HttpError(401, 'That email and password don’t match an account.');
    }
    if (!(await auth.verifyPassword(password, user.pw_hash))) throw new HttpError(401, 'That email and password don’t match an account.');
    limiter.reset(`signin-email:${email}`);
    const token = auth.createSession(db, user.id, req.headers['user-agent']);
    cookies.set(res, token);
    accounts.noteSignIn(req, res, user);
    return { user: publicUser(user) };
  });

  r.post('/api/auth/signout', { auth: false }, (req, res) => {
    if (req.session) auth.endSession(db, req.session.tokenHash);
    cookies.clear(res);
    return { ok: true };
  });

  r.get('/api/me', {}, (req) => ({ user: publicUser(req.user) }));

  r.patch('/api/me', {}, (req, res, body) => {
    const u = req.user;
    const name = body.name !== undefined ? auth.cleanName(body.name) : u.name;
    const goal = body.dailyGoal !== undefined ? int(body.dailyGoal, 'daily goal', 0, 20000) : u.dailyGoal;
    const prefs = cleanPrefs(body.prefs, readPrefs(u.prefs));
    db.prepare('UPDATE users SET name = ?, daily_goal = ?, prefs = ? WHERE id = ?').run(name, goal, JSON.stringify(prefs), u.id);
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) };
  });

  r.post('/api/me/password', {}, async (req, res, body) => {
    limit(limiter, `pw:${req.user.id}`, 6, 15 * 60_000);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (typeof body.current !== 'string' || !(await auth.verifyPassword(body.current.slice(0, 200), row.pw_hash))) {
      throw new HttpError(400, 'Your current password isn’t right.', { field: 'current' });
    }
    const next = auth.checkNewPassword(body.next, { email: row.email, name: row.name });
    const hash = await auth.hashPassword(next);
    const now = Date.now();
    db.prepare('UPDATE users SET pw_hash = ?, pw_changed_at = ? WHERE id = ?').run(hash, now, row.id);
    // Signs out every other device and app; this browser gets a fresh session.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    accounts.revokeAllApps(row.id);
    cookies.set(res, auth.createSession(db, row.id, req.headers['user-agent']));
    accounts.notifyPasswordChanged(row);
    return { ok: true };
  });

  r.post('/api/me/signout-others', {}, (req) => {
    auth.endAllSessions(db, req.user.id, req.session.tokenHash);
    return { ok: true };
  });

  r.get('/api/me/sessions', {}, (req) => ({
    sessions: db.prepare('SELECT token_hash, created_at, last_seen, agent FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').all(req.user.id)
      .map((s) => ({ current: s.token_hash === req.session.tokenHash, createdAt: s.created_at, lastSeen: s.last_seen, agent: s.agent })),
  }));

  r.post('/api/me/delete', {}, async (req, res, body) => {
    limit(limiter, `pw:${req.user.id}`, 6, 15 * 60_000);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (typeof body.password !== 'string' || !(await auth.verifyPassword(body.password.slice(0, 200), row.pw_hash))) {
      throw new HttpError(400, 'Your password isn’t right.', { field: 'password' });
    }
    if (body.confirm !== 'DELETE') throw new HttpError(400, 'Please type DELETE to confirm.', { field: 'confirm' });
    db.prepare('DELETE FROM users WHERE id = ?').run(row.id);
    cookies.clear(res);
    return { ok: true };
  });

  r.get('/api/me/export', {}, (req, res) => {
    limit(limiter, `export:${req.user.id}`, 20, 3600_000);
    const u = db.prepare('SELECT id, email, name, daily_goal, prefs, created_at FROM users WHERE id = ?').get(req.user.id);
    const books = db.prepare('SELECT * FROM books WHERE user_id = ? ORDER BY created_at').all(u.id).map((b) => ({
      ...bookRow(b),
      chapters: db.prepare('SELECT id, title, status, position, doc, words, updated_at FROM chapters WHERE book_id = ? ORDER BY position').all(b.id)
        .map((c) => ({ id: c.id, title: c.title, status: c.status, words: c.words, updatedAt: c.updated_at, doc: JSON.parse(c.doc) })),
    }));
    const payload = {
      format: 'lekhira-writes-export', version: 1, exportedAt: new Date().toISOString(),
      account: { email: u.email, name: u.name, dailyGoal: u.daily_goal, createdAt: u.created_at },
      writingLog: db.prepare('SELECT day, words FROM writing_log WHERE user_id = ? ORDER BY day').all(u.id),
      books,
    };
    return { raw: JSON.stringify(payload, null, 2), type: 'application/json; charset=utf-8', disposition: filename('Lekhira Writes export', 'json') };
  });

  r.get('/api/stats', {}, (req) => {
    const today = writerDay(req.query.get('day'));
    return { ...stats(db, req.user.id, today), dailyGoal: req.user.dailyGoal };
  });

  // --- books ---
  r.get('/api/books', {}, (req) => ({
    books: db.prepare(`SELECT b.*, COUNT(c.id) chapters, COALESCE(SUM(c.words),0) words FROM books b
      LEFT JOIN chapters c ON c.book_id = b.id WHERE b.user_id = ? AND b.deleted_at IS NULL GROUP BY b.id ORDER BY b.updated_at DESC`)
      .all(req.user.id).map(bookRow),
  }));

  r.get('/api/trash', {}, (req) => ({
    books: db.prepare(`SELECT b.*, COUNT(c.id) chapters, COALESCE(SUM(c.words),0) words FROM books b
      LEFT JOIN chapters c ON c.book_id = b.id WHERE b.user_id = ? AND b.deleted_at IS NOT NULL GROUP BY b.id ORDER BY b.deleted_at DESC`)
      .all(req.user.id).map(bookRow),
  }));

  r.post('/api/books', {}, (req, res, body) => {
    limit(limiter, `create:${req.user.id}`, 60, 3600_000);
    const title = text(body.title, 'title', 200, { required: true });
    const cover = COVERS.has(body.cover) ? body.cover : 'gold';
    const id = tx(db, () => createBook(db, req.user.id, { title, author: req.user.name, cover }, [{ title: 'Chapter One' }]));
    return { status: 201, body: { book: bookRow(db.prepare('SELECT * FROM books WHERE id = ?').get(id)) } };
  });

  r.get('/api/books/:id', {}, (req) => {
    const b = ownBook(db, req.user.id, req.params.id);
    return { book: bookRow(b), chapters: chapterList(db, b.id) };
  });

  r.patch('/api/books/:id', {}, (req, res, body) => {
    const b = ownBook(db, req.user.id, req.params.id);
    const title = body.title !== undefined ? text(body.title, 'title', 200, { required: true }) : b.title;
    const subtitle = body.subtitle !== undefined ? text(body.subtitle, 'subtitle', 300) : b.subtitle;
    const author = body.author !== undefined ? text(body.author, 'author name', 120) : b.author;
    const goal = body.wordGoal !== undefined ? int(body.wordGoal, 'word goal', 0, 2_000_000) : b.word_goal;
    const cover = body.cover !== undefined && COVERS.has(body.cover) ? body.cover : b.cover;
    db.prepare('UPDATE books SET title = ?, subtitle = ?, author = ?, word_goal = ?, cover = ?, updated_at = ? WHERE id = ?')
      .run(title, subtitle, author, goal, cover, Date.now(), b.id);
    return { book: bookRow(db.prepare('SELECT * FROM books WHERE id = ?').get(b.id)) };
  });

  // Moves a book to the trash. It can be restored until the writer empties it.
  r.delete('/api/books/:id', {}, (req) => {
    const b = ownBook(db, req.user.id, req.params.id);
    db.prepare('UPDATE books SET deleted_at = ? WHERE id = ?').run(Date.now(), b.id);
    return { ok: true };
  });

  r.post('/api/books/:id/restore', {}, (req) => {
    const b = ownBook(db, req.user.id, req.params.id, { includeDeleted: true });
    db.prepare('UPDATE books SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(Date.now(), b.id);
    return { ok: true };
  });

  r.post('/api/books/:id/destroy', {}, (req, res, body) => {
    const b = ownBook(db, req.user.id, req.params.id, { includeDeleted: true });
    if (!b.deleted_at) throw new HttpError(400, 'Move the book to the trash first.');
    if (body.confirm !== b.title) throw new HttpError(400, 'Type the book’s title to delete it forever.', { field: 'confirm' });
    db.prepare('DELETE FROM books WHERE id = ?').run(b.id);
    return { ok: true };
  });

  r.get('/api/books/:id/export', {}, (req) => {
    const b = ownBook(db, req.user.id, req.params.id);
    limit(limiter, `export:${req.user.id}`, 60, 3600_000);
    const format = req.query.get('format');
    const chapters = db.prepare('SELECT title, doc FROM chapters WHERE book_id = ? ORDER BY position').all(b.id);
    if (format === 'md') {
      // One "# Title" per chapter and nothing before it, so Lekhira Studio imports it cleanly.
      const body = chapters.map((c) => docs.chapterToMarkdown(c.title, JSON.parse(c.doc))).join('\n');
      return { raw: body, type: 'text/markdown; charset=utf-8', disposition: filename(b.title, 'md') };
    }
    if (format === 'txt') {
      const head = [b.title.toUpperCase(), b.subtitle, b.author ? `by ${b.author}` : '', '', ''].filter((x, i) => x || i > 2).join('\n');
      const body = chapters.map((c) => docs.chapterToText(c.title, JSON.parse(c.doc))).join('\n\n');
      return { raw: head + body, type: 'text/plain; charset=utf-8', disposition: filename(b.title, 'txt') };
    }
    if (format === 'json') {
      // Whole book with its structure, for printing or moving to Lekhira Studio.
      return {
        book: bookRow(b),
        chapters: db.prepare('SELECT id, title, status, doc FROM chapters WHERE book_id = ? ORDER BY position').all(b.id)
          .map((c) => ({ id: c.id, title: c.title, status: c.status, doc: JSON.parse(c.doc) })),
      };
    }
    throw new HttpError(400, 'Choose Markdown or plain text.');
  });

  // --- chapters ---
  r.post('/api/books/:id/chapters', {}, (req, res, body) => {
    const b = ownBook(db, req.user.id, req.params.id);
    const count = db.prepare('SELECT COUNT(*) n FROM chapters WHERE book_id = ?').get(b.id).n;
    if (count >= LIMITS.chapters) throw new HttpError(403, `A book can have up to ${LIMITS.chapters} chapters.`);
    const title = text(body.title, 'chapter title', 200, { fallback: `Chapter ${count + 1}` }) || `Chapter ${count + 1}`;
    const id = tx(db, () => {
      let pos = count;
      if (isId(body.after)) {
        const after = db.prepare('SELECT position FROM chapters WHERE id = ? AND book_id = ?').get(body.after, b.id);
        if (after) {
          pos = after.position + 1;
          db.prepare('UPDATE chapters SET position = position + 1 WHERE book_id = ? AND position >= ?').run(b.id, pos);
        }
      }
      const cid = insertChapter(db, req.user.id, b.id, title, pos, null);
      touchBook(db, b.id);
      return cid;
    });
    return { status: 201, body: { chapter: chapterMeta(db.prepare('SELECT * FROM chapters WHERE id = ?').get(id)), chapters: chapterList(db, b.id) } };
  });

  r.put('/api/books/:id/order', {}, (req, res, body) => {
    const b = ownBook(db, req.user.id, req.params.id);
    const current = db.prepare('SELECT id FROM chapters WHERE book_id = ?').all(b.id).map((c) => c.id);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every((i) => current.includes(i))) {
      throw new HttpError(409, 'The chapter list changed somewhere else. Reload to see the latest.');
    }
    tx(db, () => {
      const up = db.prepare('UPDATE chapters SET position = ? WHERE id = ? AND book_id = ?');
      ids.forEach((id, i) => up.run(i, id, b.id));
      touchBook(db, b.id);
    });
    return { chapters: chapterList(db, b.id) };
  });

  r.get('/api/chapters/:id', {}, (req) => {
    const c = ownChapter(db, req.user.id, req.params.id);
    return { chapter: { ...chapterMeta(c), bookId: c.book_id, doc: JSON.parse(c.doc) } };
  });

  // Saves the chapter text. baseVersion must match the stored version, so two tabs or
  // devices can't silently overwrite each other; force:true is the writer's explicit choice.
  r.put('/api/chapters/:id', { bodyLimit: 6 * 1024 * 1024 }, (req, res, body) => {
    limit(limiter, `save:${req.user.id}`, 600, 60_000);
    const c = ownChapter(db, req.user.id, req.params.id);
    if (body.force !== true && body.baseVersion !== c.version) {
      throw new HttpError(409, 'This chapter was changed in another tab or device.', { conflict: { version: c.version, updatedAt: c.updated_at, words: c.words } });
    }
    const { doc, words } = docs.cleanDoc(body.doc);
    const json = JSON.stringify(doc);
    const now = Date.now();
    const out = tx(db, () => {
      if (json !== c.doc) {
        const last = db.prepare('SELECT saved_at FROM revisions WHERE chapter_id = ? ORDER BY saved_at DESC LIMIT 1').get(c.id);
        if (!last || now - last.saved_at > LIMITS.revisionEveryMs || body.force === true) {
          db.prepare('INSERT INTO revisions (id, chapter_id, user_id, version, doc, words, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(newId(), c.id, c.user_id, c.version, c.doc, c.words, c.updated_at);
          db.prepare(`DELETE FROM revisions WHERE chapter_id = ? AND id NOT IN
            (SELECT id FROM revisions WHERE chapter_id = ? ORDER BY saved_at DESC LIMIT ?)`).run(c.id, c.id, LIMITS.revisionsPerChapter);
        }
      }
      const version = c.version + 1;
      db.prepare('UPDATE chapters SET doc = ?, words = ?, version = ?, updated_at = ? WHERE id = ?').run(json, words, version, now, c.id);
      touchBook(db, c.book_id);
      const delta = words - c.words;
      if (delta > 0) {
        db.prepare(`INSERT INTO writing_log (user_id, day, words) VALUES (?, ?, ?)
          ON CONFLICT(user_id, day) DO UPDATE SET words = words + excluded.words`).run(c.user_id, writerDay(body.day), Math.min(delta, 50000));
      }
      return { version, words, updatedAt: now };
    });
    return out;
  });

  r.patch('/api/chapters/:id', {}, (req, res, body) => {
    const c = ownChapter(db, req.user.id, req.params.id);
    const title = body.title !== undefined ? text(body.title, 'chapter title', 200, { required: true }) : c.title;
    const status = body.status !== undefined ? (STATUSES.has(body.status) ? body.status : c.status) : c.status;
    db.prepare('UPDATE chapters SET title = ?, status = ? WHERE id = ?').run(title, status, c.id);
    touchBook(db, c.book_id);
    return { chapter: chapterMeta(db.prepare('SELECT * FROM chapters WHERE id = ?').get(c.id)) };
  });

  r.delete('/api/chapters/:id', {}, (req) => {
    const c = ownChapter(db, req.user.id, req.params.id);
    const count = db.prepare('SELECT COUNT(*) n FROM chapters WHERE book_id = ?').get(c.book_id).n;
    if (count <= 1) throw new HttpError(400, 'A book needs at least one chapter.');
    tx(db, () => {
      db.prepare('DELETE FROM chapters WHERE id = ?').run(c.id);
      db.prepare('UPDATE chapters SET position = position - 1 WHERE book_id = ? AND position > ?').run(c.book_id, c.position);
      touchBook(db, c.book_id);
    });
    return { chapters: chapterList(db, c.book_id) };
  });

  r.get('/api/chapters/:id/revisions', {}, (req) => {
    const c = ownChapter(db, req.user.id, req.params.id);
    return {
      revisions: db.prepare('SELECT id, version, words, saved_at FROM revisions WHERE chapter_id = ? ORDER BY saved_at DESC').all(c.id)
        .map((v) => ({ id: v.id, version: v.version, words: v.words, savedAt: v.saved_at })),
    };
  });

  r.get('/api/chapters/:id/revisions/:rid', {}, (req) => {
    const c = ownChapter(db, req.user.id, req.params.id);
    if (!isId(req.params.rid)) throw new HttpError(404, 'That version was not found.');
    const v = db.prepare('SELECT * FROM revisions WHERE id = ? AND chapter_id = ?').get(req.params.rid, c.id);
    if (!v) throw new HttpError(404, 'That version was not found.');
    return { revision: { id: v.id, words: v.words, savedAt: v.saved_at, doc: JSON.parse(v.doc) } };
  });

  // Restoring keeps the current text as a version first, so a restore can be undone.
  r.post('/api/chapters/:id/restore', {}, (req, res, body) => {
    const c = ownChapter(db, req.user.id, req.params.id);
    if (!isId(body.revisionId)) throw new HttpError(404, 'That version was not found.');
    const v = db.prepare('SELECT * FROM revisions WHERE id = ? AND chapter_id = ?').get(body.revisionId, c.id);
    if (!v) throw new HttpError(404, 'That version was not found.');
    const now = Date.now();
    tx(db, () => {
      db.prepare('INSERT INTO revisions (id, chapter_id, user_id, version, doc, words, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(newId(), c.id, c.user_id, c.version, c.doc, c.words, now);
      db.prepare('UPDATE chapters SET doc = ?, words = ?, version = ?, updated_at = ? WHERE id = ?').run(v.doc, v.words, c.version + 1, now, c.id);
      touchBook(db, c.book_id);
    });
    return { chapter: { ...chapterMeta(db.prepare('SELECT * FROM chapters WHERE id = ?').get(c.id)), doc: JSON.parse(v.doc) } };
  });
}

module.exports = { register };
