-- Phase 3: paper identity by file hash and text fingerprint, profiles, search, admin operations.

-- ---------- paper identity ----------
-- One row per question paper file brought to the Library. `fingerprint` is the MinHash text
-- fingerprint (shared/fingerprint.ts); `label` is the Cambridge code read from the file name or
-- cover, for display only. Later sets link to `qp_hash` instead of uploading their own copy.
CREATE TABLE paper_prints (
  qp_hash TEXT PRIMARY KEY,
  ms_hash TEXT,
  fingerprint TEXT CHECK (fingerprint IS NULL OR length(fingerprint) = 512),
  label TEXT,
  title TEXT NOT NULL DEFAULT '',
  question_count INTEGER,
  first_set_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Locality-sensitive bands of each fingerprint: papers sharing a band are match candidates.
CREATE TABLE paper_bands (
  band TEXT NOT NULL,
  qp_hash TEXT NOT NULL REFERENCES paper_prints (qp_hash) ON DELETE CASCADE,
  PRIMARY KEY (band, qp_hash)
) WITHOUT ROWID;
CREATE INDEX paper_bands_hash ON paper_bands (qp_hash);

-- Existing registry rows (keyed by Cambridge code) become prints without a fingerprint.
INSERT OR IGNORE INTO paper_prints (qp_hash, ms_hash, label, question_count, first_set_id, created_at, updated_at)
  SELECT qp_hash, ms_hash, paper_key, question_count, first_set_id, created_at, updated_at FROM papers WHERE qp_hash IS NOT NULL;

-- ---------- profiles ----------
ALTER TABLE users ADD COLUMN handle TEXT;
ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '' CHECK (length(bio) <= 160);
ALTER TABLE users ADD COLUMN headline TEXT NOT NULL DEFAULT '' CHECK (length(headline) <= 80);
ALTER TABLE users ADD COLUMN subjects TEXT NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN avatar_hash TEXT;
-- 'school': members of the Library only (the default); 'private': only the owner and admins.
ALTER TABLE users ADD COLUMN visibility TEXT NOT NULL DEFAULT 'school' CHECK (visibility IN ('school', 'private'));
ALTER TABLE users ADD COLUMN show_stats INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN stats TEXT NOT NULL DEFAULT '{}';
-- Admin operations.
ALTER TABLE users ADD COLUMN suspended_at INTEGER;
ALTER TABLE users ADD COLUMN quota_bytes INTEGER;
CREATE UNIQUE INDEX users_handle ON users (handle) WHERE handle IS NOT NULL;

CREATE TABLE profile_reports (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reporter TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (length(reason) <= 500),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, reporter)
);

-- ---------- search (FTS5, kept in step by triggers) ----------
CREATE VIRTUAL TABLE sets_fts USING fts5 (title, description, subject, owner_name, content = 'sets', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2');
INSERT INTO sets_fts (rowid, title, description, subject, owner_name) SELECT rowid, title, description, subject, owner_name FROM sets;
CREATE TRIGGER sets_fts_ai AFTER INSERT ON sets BEGIN
  INSERT INTO sets_fts (rowid, title, description, subject, owner_name) VALUES (new.rowid, new.title, new.description, new.subject, new.owner_name);
END;
CREATE TRIGGER sets_fts_ad AFTER DELETE ON sets BEGIN
  INSERT INTO sets_fts (sets_fts, rowid, title, description, subject, owner_name) VALUES ('delete', old.rowid, old.title, old.description, old.subject, old.owner_name);
END;
CREATE TRIGGER sets_fts_au AFTER UPDATE OF title, description, subject, owner_name ON sets BEGIN
  INSERT INTO sets_fts (sets_fts, rowid, title, description, subject, owner_name) VALUES ('delete', old.rowid, old.title, old.description, old.subject, old.owner_name);
  INSERT INTO sets_fts (rowid, title, description, subject, owner_name) VALUES (new.rowid, new.title, new.description, new.subject, new.owner_name);
END;

CREATE VIRTUAL TABLE users_fts USING fts5 (display_name, handle, headline, subjects, content = 'users', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2');
INSERT INTO users_fts (rowid, display_name, handle, headline, subjects) SELECT rowid, display_name, handle, headline, subjects FROM users;
CREATE TRIGGER users_fts_ai AFTER INSERT ON users BEGIN
  INSERT INTO users_fts (rowid, display_name, handle, headline, subjects) VALUES (new.rowid, new.display_name, new.handle, new.headline, new.subjects);
END;
CREATE TRIGGER users_fts_ad AFTER DELETE ON users BEGIN
  INSERT INTO users_fts (users_fts, rowid, display_name, handle, headline, subjects) VALUES ('delete', old.rowid, old.display_name, old.handle, old.headline, old.subjects);
END;
CREATE TRIGGER users_fts_au AFTER UPDATE OF display_name, handle, headline, subjects ON users BEGIN
  INSERT INTO users_fts (users_fts, rowid, display_name, handle, headline, subjects) VALUES ('delete', old.rowid, old.display_name, old.handle, old.headline, old.subjects);
  INSERT INTO users_fts (rowid, display_name, handle, headline, subjects) VALUES (new.rowid, new.display_name, new.handle, new.headline, new.subjects);
END;

-- ---------- admin audit log ----------
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_at ON audit_log (at DESC);

-- Client errors per day, for the admin overview (the message itself goes to Workers logs).
CREATE TABLE error_daily (
  day TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0
);
