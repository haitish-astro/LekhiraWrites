// Lekhira Writes: storage. SQLite through Node's built-in driver, so the server has no
// third-party dependencies. Every query that touches writing is scoped by user_id.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 4000;
    PRAGMA secure_delete = ON;
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      pw_hash TEXT NOT NULL,
      prefs TEXT NOT NULL DEFAULT '{}',
      daily_goal INTEGER NOT NULL DEFAULT 500,
      created_at INTEGER NOT NULL,
      pw_changed_at INTEGER NOT NULL
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
  `);
  // Columns added after the first release.
  const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!cols.has('email_verified_at')) db.exec('ALTER TABLE users ADD COLUMN email_verified_at INTEGER');
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema', String(SCHEMA_VERSION));
  return db;
}

// Runs fn inside one transaction; rolls back if it throws.
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { open, tx, SCHEMA_VERSION };
