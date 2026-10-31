// Lekhira Writes: storage. One small async interface over two databases:
//   SQLite   Node's built-in driver: the default, for this computer and the tests.
//   Postgres when DATABASE_URL is set (Supabase in production), through the `pg` package.
// Queries are written once with ? placeholders and run unchanged on both. Every query that
// touches writing is scoped by user_id.
//   await db.get(sql, ...params)   first row or undefined
//   await db.all(sql, ...params)   every row
//   await db.run(sql, ...params)   { changes }
//   await db.tx(async (t) => …)    one transaction; use t (not db) inside it
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;

// Timestamps are milliseconds, so Postgres needs BIGINT where SQLite's INTEGER is enough.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    pw_hash TEXT NOT NULL,
    prefs TEXT NOT NULL DEFAULT '{}',
    daily_goal INTEGER NOT NULL DEFAULT 500,
    created_at INTEGER NOT NULL,
    pw_changed_at INTEGER NOT NULL,
    email_verified_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    agent TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    subtitle TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    word_goal INTEGER NOT NULL DEFAULT 0,
    cover TEXT NOT NULL DEFAULT 'gold',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS books_user ON books(user_id, deleted_at);

  CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    doc TEXT NOT NULL,
    words INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chapters_book ON chapters(book_id, position);

  CREATE TABLE IF NOT EXISTS revisions (
    id TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    doc TEXT NOT NULL,
    words INTEGER NOT NULL,
    saved_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS revisions_chapter ON revisions(chapter_id, saved_at);

  CREATE TABLE IF NOT EXISTS writing_log (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    words INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );

  -- One-time links sent by email (verify an address, reset a password). Only hashes are kept.
  CREATE TABLE IF NOT EXISTS email_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id, purpose);

  -- Browsers a writer has signed in from, so a new one can be reported by email.
  CREATE TABLE IF NOT EXISTS devices (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_hash TEXT NOT NULL,
    agent TEXT NOT NULL DEFAULT '',
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_hash)
  );

  -- Desktop sign-in (OAuth 2.0 authorization code + PKCE): short-lived codes, then grants
  -- holding a rotating access/refresh token pair. Tokens are stored as hashes only.
  CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    challenge TEXT NOT NULL,
    device_name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    grant_id TEXT
  );
  CREATE TABLE IF NOT EXISTS app_grants (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    device_name TEXT NOT NULL DEFAULT '',
    access_hash TEXT NOT NULL UNIQUE,
    access_expires INTEGER NOT NULL,
    refresh_hash TEXT NOT NULL UNIQUE,
    prev_refresh_hash TEXT,
    refresh_expires INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_used INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS app_grants_user ON app_grants(user_id);
`;

// Opens Postgres when a URL is given, SQLite otherwise.
async function open({ url, file } = {}) {
  const db = url ? await openPostgres(url) : openSqlite(file);
  await db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT DO NOTHING', 'schema', String(SCHEMA_VERSION));
  return db;
}

// ---------- SQLite ----------
function openSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 4000;
    PRAGMA secure_delete = ON;
  `);
  raw.exec(SCHEMA);
  // Columns added after the first release.
  const cols = new Set(raw.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!cols.has('email_verified_at')) raw.exec('ALTER TABLE users ADD COLUMN email_verified_at INTEGER');

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
    return s;
  };
  const q = {
    get: async (sql, ...p) => stmt(sql).get(...p),
    all: async (sql, ...p) => stmt(sql).all(...p),
    run: async (sql, ...p) => ({ changes: Number(stmt(sql).run(...p).changes) }),
  };
  // SQLite has one connection, so a transaction holds it until it ends: queries from other
  // requests wait here instead of landing inside someone else's transaction.
  let lock = Promise.resolve();
  const waitTurn = () => {
    let release;
    const prev = lock;
    lock = new Promise((r) => { release = r; });
    return prev.then(() => release);
  };
  const outside = (fn) => async (sql, ...p) => {
    // A transaction that starts while we wait replaces the lock, so wait for that one too.
    for (let l = lock; ; l = lock) { await l; if (l === lock) break; }
    return fn(sql, ...p);
  };
  return {
    dialect: 'sqlite',
    get: outside(q.get),
    all: outside(q.all),
    run: outside(q.run),
    async tx(fn) {
      const release = await waitTurn();
      try {
        raw.exec('BEGIN IMMEDIATE');
        try {
          const out = await fn(q);
          raw.exec('COMMIT');
          return out;
        } catch (err) {
          raw.exec('ROLLBACK');
          throw err;
        }
      } finally {
        release();
      }
    },
    isUnique: (err) => /UNIQUE/.test(String(err && err.message)),
    async close() { raw.close(); },
  };
}

// ---------- Postgres ----------
// ? becomes $1, $2, … (our queries never put ? inside a string literal).
function numbered(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

async function openPostgres(url) {
  const pg = require('pg');
  // BIGINT columns, COUNT() and SUM() come back as strings by default; our numbers (ms
  // timestamps, word counts) all fit safely in a JavaScript number.
  const types = { 20: Number, 1700: Number };
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL) || 10,
    // Hosted databases need TLS, with the certificate checked; a local one usually has none.
    // Supabase signs with its own authority: DATABASE_CA holds that certificate (PEM text).
    ssl: /sslmode=disable/.test(url) || /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : {
      rejectUnauthorized: true,
      ...(process.env.DATABASE_CA ? { ca: process.env.DATABASE_CA.replace(/\\n/g, '\n') } : {}),
    },
    types: { getTypeParser: (oid, format) => types[oid] || pg.types.getTypeParser(oid, format) },
  });
  pool.on('error', (err) => console.error('Database connection error:', err.message));
  const via = (c) => ({
    get: async (sql, ...p) => (await c.query(numbered(sql), p)).rows[0],
    all: async (sql, ...p) => (await c.query(numbered(sql), p)).rows,
    run: async (sql, ...p) => ({ changes: (await c.query(numbered(sql), p)).rowCount }),
  });
  await pool.query(SCHEMA.replace(/\bINTEGER\b/g, 'BIGINT'));
  // Supabase also offers every table through its public Data API. Row-level security with no
  // policies shuts that door: only the tables' owner (this server's login) can read them.
  const tables = [...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  await pool.query(tables.map((t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`).join('\n'));
  return {
    dialect: 'postgres',
    ...via(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        try {
          const out = await fn(via(client));
          await client.query('COMMIT');
          return out;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      } finally {
        client.release();
      }
    },
    isUnique: (err) => !!err && err.code === '23505',
    close: () => pool.end(),
  };
}

module.exports = { open, SCHEMA_VERSION };
