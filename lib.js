'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const appRoot = __dirname;
const dataDir = process.env.LV_DATA_DIR || path.join(appRoot, 'data');
require('node:fs').mkdirSync(dataDir, { recursive: true, mode: 0o750 });
const db = new DatabaseSync(path.join(dataDir, 'app.sqlite'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    source_type TEXT NOT NULL CHECK (source_type IN ('upload', 'url')),
    source TEXT NOT NULL,
    mime_type TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const videoColumns = new Set(db.prepare('PRAGMA table_info(videos)').all().map(column => column.name));
const migrations = [
  ['duration_seconds', 'ALTER TABLE videos ADD COLUMN duration_seconds REAL'],
  ['size_bytes', 'ALTER TABLE videos ADD COLUMN size_bytes INTEGER'],
  ['thumbnail', 'ALTER TABLE videos ADD COLUMN thumbnail TEXT'],
  ['hls_manifest', 'ALTER TABLE videos ADD COLUMN hls_manifest TEXT'],
  ['conversion_status', "ALTER TABLE videos ADD COLUMN conversion_status TEXT NOT NULL DEFAULT 'none'"],
  ['conversion_error', 'ALTER TABLE videos ADD COLUMN conversion_error TEXT'],
  ['original_deleted', 'ALTER TABLE videos ADD COLUMN original_deleted INTEGER NOT NULL DEFAULT 0'],
  ['category', "ALTER TABLE videos ADD COLUMN category TEXT NOT NULL DEFAULT 'Umum'"],
  ['thumbnail_version', 'ALTER TABLE videos ADD COLUMN thumbnail_version INTEGER NOT NULL DEFAULT 1'],
  ['ingest_status', "ALTER TABLE videos ADD COLUMN ingest_status TEXT NOT NULL DEFAULT 'ready'"],
  ['ingest_error', 'ALTER TABLE videos ADD COLUMN ingest_error TEXT'],
  ['source_url', 'ALTER TABLE videos ADD COLUMN source_url TEXT'],
  ['media_type', "ALTER TABLE videos ADD COLUMN media_type TEXT NOT NULL DEFAULT 'video'"],
  ['optimization_status', "ALTER TABLE videos ADD COLUMN optimization_status TEXT NOT NULL DEFAULT 'none'"],
  ['optimization_error', 'ALTER TABLE videos ADD COLUMN optimization_error TEXT'],
  ['original_size_bytes', 'ALTER TABLE videos ADD COLUMN original_size_bytes INTEGER'],
  ['width', 'ALTER TABLE videos ADD COLUMN width INTEGER'],
  ['height', 'ALTER TABLE videos ADD COLUMN height INTEGER']
];
for (const [column, sql] of migrations) {
  if (!videoColumns.has(column)) db.exec(sql);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS video_likes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, video_id)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS video_views (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    viewed_at INTEGER NOT NULL DEFAULT 0,
    view_count INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, video_id)
  );
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE IF NOT EXISTS video_categories (
    video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (video_id, category_id)
  );
  INSERT OR IGNORE INTO categories (name)
    SELECT CASE WHEN trim(category)='' THEN 'Umum' ELSE trim(category) END FROM videos;
  INSERT OR IGNORE INTO categories (name) VALUES ('Umum');
  INSERT OR IGNORE INTO video_categories (video_id, category_id)
    SELECT videos.id, categories.id FROM videos
    JOIN categories ON categories.name=(CASE WHEN trim(videos.category)='' THEN 'Umum' ELSE trim(videos.category) END) COLLATE NOCASE;
  INSERT OR IGNORE INTO video_categories (video_id, category_id)
    SELECT videos.id, categories.id FROM videos, categories
    WHERE categories.name='Umum' COLLATE NOCASE
      AND NOT EXISTS (SELECT 1 FROM video_categories WHERE video_categories.video_id=videos.id);
`);

function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function passwordMatches(password, stored) {
  const [kind, saltHex, hashHex] = String(stored).split(':');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { appRoot, dataDir, db, passwordHash, passwordMatches, tokenHash };
