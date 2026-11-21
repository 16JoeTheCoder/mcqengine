-- DMC on Cloudflare D1. Applied with: npx wrangler d1 migrations apply <db> --remote (see setup.md).
-- Port of supabase/schema.sql. The rules RLS used to enforce now live in the Worker (worker/*.ts);
-- every route checks auth and membership on the server. Times are Unix milliseconds.

-- ---------- who may use the Library (owner configuration, edited from the admin panel) ----------
CREATE TABLE library_domains (
  domain TEXT PRIMARY KEY CHECK (domain = lower(domain) AND domain GLOB '*?.?*' AND length(domain) <= 100)
);
CREATE TABLE library_allowlist (
  email TEXT PRIMARY KEY CHECK (email = lower(email) AND instr(email, '@') > 1 AND length(email) <= 254),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  added_at INTEGER NOT NULL,
  added_by TEXT
);
CREATE TABLE library_admins (
  email TEXT PRIMARY KEY CHECK (email = lower(email) AND instr(email, '@') > 1 AND length(email) <= 254),
  added_at INTEGER NOT NULL,
  added_by TEXT
);

-- ---------- accounts and sessions ----------
-- role is open for Phase 3 (teacher, student); Phase 2 uses only membership and admin.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  email_verified INTEGER NOT NULL DEFAULT 0,
  google_sub TEXT UNIQUE,
  hd TEXT,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  role TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
-- Only the SHA-256 of the cookie token is stored. Sessions roll (expires_at moves on use) and
-- end at absolute_expires_at regardless.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expiry ON sessions (expires_at);

-- ---------- files: every PDF and image stored once at blobs/<sha256> in R2 ----------
CREATE TABLE blobs (
  hash TEXT PRIMARY KEY CHECK (length(hash) = 64),
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 26214400),
  type TEXT NOT NULL,
  first_uploader TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  -- When nothing pointed at it any more (or since upload, if never published); the cron deletes
  -- unreferenced files 7 days after this.
  orphaned_at INTEGER
);
CREATE INDEX blobs_uploader ON blobs (first_uploader);
CREATE INDEX blobs_orphaned ON blobs (orphaned_at);

-- ---------- Library sets and their versions ----------
CREATE TABLE sets (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  owner TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  owner_name TEXT NOT NULL CHECK (length(owner_name) BETWEEN 1 AND 80),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  subject TEXT NOT NULL DEFAULT '' CHECK (length(subject) <= 80),
  code TEXT NOT NULL DEFAULT '' CHECK (length(code) <= 20),
  paper_count INTEGER NOT NULL DEFAULT 0,
  question_count INTEGER NOT NULL DEFAULT 0,
  keyed INTEGER NOT NULL DEFAULT 0,
  latest_version INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  cover_hash TEXT,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'hidden')),
  star_count INTEGER NOT NULL DEFAULT 0,
  report_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX sets_rank ON sets (star_count DESC, created_at DESC);
CREATE INDEX sets_owner ON sets (owner);

-- A version is a small JSON manifest: papers, file hashes, keys and metadata.
CREATE TABLE set_versions (
  set_id TEXT NOT NULL REFERENCES sets (id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  manifest TEXT NOT NULL CHECK (length(manifest) <= 1048576),
  bytes INTEGER NOT NULL,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (set_id, version)
);

-- Which manifests point at which files (reference counts for the GC cron).
CREATE TABLE blob_refs (
  set_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  hash TEXT NOT NULL REFERENCES blobs (hash),
  PRIMARY KEY (set_id, version, hash),
  FOREIGN KEY (set_id, version) REFERENCES set_versions (set_id, version) ON DELETE CASCADE
);
CREATE INDEX blob_refs_hash ON blob_refs (hash);

-- One entry per Cambridge paper key, pointing at the stored files. A second set that uses the
-- same key links to these files instead of uploading new ones.
CREATE TABLE papers (
  paper_key TEXT PRIMARY KEY CHECK (paper_key GLOB '[0-9][0-9][0-9][0-9]_[msw][0-9][0-9]_qp_[0-9]*'),
  qp_hash TEXT,
  ms_hash TEXT,
  question_count INTEGER,
  first_set_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------- stars and reports ----------
CREATE TABLE stars (
  set_id TEXT NOT NULL REFERENCES sets (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (set_id, user_id)
);
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL REFERENCES sets (id) ON DELETE CASCADE,
  reporter TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_at INTEGER NOT NULL,
  UNIQUE (set_id, reporter)
);

-- ---------- sync: compare-and-set writes, server revision cursor ----------
CREATE TABLE sync_records (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  store TEXT NOT NULL CHECK (store IN ('packs', 'sessions', 'sessionDetail', 'questionStats', 'snips', 'overrides', 'settings')),
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 300),
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  data TEXT CHECK (data IS NULL OR length(data) <= 262144),
  bytes INTEGER NOT NULL DEFAULT 0,
  server_revision INTEGER NOT NULL UNIQUE,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, store, id)
);
CREATE INDEX sync_revision_pull ON sync_records (user_id, server_revision);

-- Monotonic counters (sync revisions). D1 runs one write transaction at a time, so a revision
-- taken inside a batch can never appear behind a cursor that was already pulled.
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO counters (name, value) VALUES ('sync', 0);

-- A row inserted here with ok = 0 fails its CHECK and rolls back the whole batch: the Worker's
-- way of making a compare-and-set batch all-or-nothing.
CREATE TABLE cas_guard (ok INTEGER NOT NULL CHECK (ok = 1));

-- ---------- usage: downloads, uploads and AI per account per day (UTC date) ----------
CREATE TABLE usage_daily (
  day TEXT NOT NULL,
  user_id TEXT NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0,
  download_bytes INTEGER NOT NULL DEFAULT 0,
  uploads INTEGER NOT NULL DEFAULT 0,
  upload_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id)
);

-- ---------- personal pack backups (one zip per account in R2 at user-backups/<id>/packs.zip) ----------
CREATE TABLE user_backups (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
