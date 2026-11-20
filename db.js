'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ip_hash    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_match_id ON comments (match_id, id);

CREATE TABLE IF NOT EXISTS streams (
  match_id   TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS banners (
  slot       INTEGER PRIMARY KEY,
  type       TEXT NOT NULL,
  image_path TEXT,
  link_url   TEXT,
  html       TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

const DEFAULT_SETTINGS = { showAdPlaceholders: 'true' };

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'soccer.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  const seed = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) seed.run(k, v);

  const st = {
    commentsLatest: db.prepare(
      `SELECT id, name, body, created_at FROM (
         SELECT id, name, body, created_at FROM comments WHERE match_id = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`
    ),
    commentsAfter: db.prepare(
      'SELECT id, name, body, created_at FROM comments WHERE match_id = ? AND id > ? ORDER BY id ASC LIMIT ?'
    ),
    commentsCount: db.prepare('SELECT COUNT(*) AS n FROM comments WHERE match_id = ?'),
    commentInsert: db.prepare(
      'INSERT INTO comments (match_id, name, body, created_at, ip_hash) VALUES (?, ?, ?, ?, ?)'
    ),
    commentMatchExists: db.prepare('SELECT 1 FROM comments WHERE match_id = ? LIMIT 1'),
    commentsRecent: db.prepare(
      'SELECT id, match_id, name, body, created_at FROM comments ORDER BY id DESC LIMIT ?'
    ),
    commentDelete: db.prepare('DELETE FROM comments WHERE id = ?'),

    streamsAll: db.prepare('SELECT match_id, url, kind, updated_at FROM streams'),
    streamGet: db.prepare('SELECT match_id, url, kind, updated_at FROM streams WHERE match_id = ?'),
    streamUpsert: db.prepare(
      `INSERT INTO streams (match_id, url, kind, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(match_id) DO UPDATE SET url = excluded.url, kind = excluded.kind, updated_at = excluded.updated_at`
    ),
    streamDelete: db.prepare('DELETE FROM streams WHERE match_id = ?'),

    bannersAll: db.prepare('SELECT slot, type, image_path, link_url, html, updated_at FROM banners ORDER BY slot'),
    bannerGet: db.prepare('SELECT slot, type, image_path, link_url, html, updated_at FROM banners WHERE slot = ?'),
    bannerUpsert: db.prepare(
      `INSERT INTO banners (slot, type, image_path, link_url, html, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(slot) DO UPDATE SET type = excluded.type, image_path = excluded.image_path,
         link_url = excluded.link_url, html = excluded.html, updated_at = excluded.updated_at`
    ),
    bannerDelete: db.prepare('DELETE FROM banners WHERE slot = ?'),

    settingGet: db.prepare('SELECT value FROM settings WHERE key = ?'),
    settingSet: db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ),
  };

  const toComment = (r) => ({ id: r.id, name: r.name, body: r.body, createdAt: r.created_at });
  const toBanner = (r) => ({
    slot: r.slot,
    type: r.type,
    imagePath: r.image_path || null,
    linkUrl: r.link_url || null,
    html: r.html || null,
    updatedAt: r.updated_at,
  });

  return {
    raw: db,
    close: () => db.close(),

    listComments(matchId, after, limit = 200) {
      const rows = after > 0
        ? st.commentsAfter.all(matchId, after, limit)
        : st.commentsLatest.all(matchId, limit);
      return rows.map(toComment);
    },
    countComments(matchId) {
      return st.commentsCount.get(matchId).n;
    },
    hasComments(matchId) {
      return !!st.commentMatchExists.get(matchId);
    },
    addComment({ matchId, name, body, ipHash }) {
      const createdAt = new Date().toISOString();
      const info = st.commentInsert.run(matchId, name, body, createdAt, ipHash);
      return { id: Number(info.lastInsertRowid), name, body, createdAt };
    },
    /** Newest first, across all matches (admin moderation). */
    listRecentComments(limit = 50) {
      return st.commentsRecent.all(limit).map((r) => ({ ...toComment(r), matchId: r.match_id }));
    },
    deleteComment(id) {
      return st.commentDelete.run(id).changes;
    },

    allStreams() {
      return st.streamsAll.all();
    },
    getStream(matchId) {
      return st.streamGet.get(matchId) || null;
    },
    setStream(matchId, url, kind) {
      st.streamUpsert.run(matchId, url, kind, new Date().toISOString());
    },
    deleteStream(matchId) {
      st.streamDelete.run(matchId);
    },

    listBanners() {
      return st.bannersAll.all().map(toBanner);
    },
    getBanner(slot) {
      const r = st.bannerGet.get(slot);
      return r ? toBanner(r) : null;
    },
    setBanner({ slot, type, imagePath = null, linkUrl = null, html = null }) {
      st.bannerUpsert.run(slot, type, imagePath, linkUrl, html, new Date().toISOString());
    },
    deleteBanner(slot) {
      st.bannerDelete.run(slot);
    },

    getSetting(key) {
      const r = st.settingGet.get(key);
      return r ? r.value : null;
    },
    setSetting(key, value) {
      st.settingSet.run(key, String(value));
    },
  };
}

module.exports = { openDb };
