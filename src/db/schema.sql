-- MergeRequestAlarm database schema.
--
-- Holds everything an operator changes at runtime, plus run history and the audit
-- log. Infrastructure and secrets stay in config.yaml and never appear here.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Scalar settings the panel can override, as a key/value store so adding a knob
-- needs no migration. `value` is JSON. A row's absence means "use the file default".
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- List-shaped exclusions: project globs, usernames, MR labels, muted MR URLs.
-- `kind` is one of 'project', 'user', 'mr_label', 'muted_mr'.
CREATE TABLE IF NOT EXISTS exclusions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('project', 'user', 'mr_label', 'muted_mr')),
  pattern     TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_by  TEXT NOT NULL DEFAULT 'system',
  UNIQUE (kind, pattern)
);

-- Recipient mapping. Seeded from config.yaml on first start, managed in the panel
-- afterwards. `channels` is a JSON array, or NULL to inherit the global setting.
CREATE TABLE IF NOT EXISTS recipients (
  gitlab_username  TEXT PRIMARY KEY,
  email            TEXT,
  teams_upn        TEXT,
  slack_id         TEXT,
  telegram_chat_id TEXT,
  channels        TEXT,
  snooze_until    TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Mutes a recipient set for themselves, from a link in their own digest. These are
-- personal: muting a merge request here silences it for that person only, unlike the
-- admin-level 'muted_mr' exclusion above which hides it from everyone.
--
-- mode:
--   'until_change' — until new commits or comments arrive, compared against `baseline`
--   'until'        — until the `until` timestamp passes
--   'forever'      — until the person un-mutes it
CREATE TABLE IF NOT EXISTS user_mutes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  gitlab_username TEXT NOT NULL,
  mr_url          TEXT NOT NULL,          -- normalised, see normaliseMrUrl
  mr_title        TEXT,                   -- for display on the self-service page
  mode            TEXT NOT NULL CHECK (mode IN ('until_change', 'until', 'forever')),
  until           TEXT,                   -- ISO timestamp when mode = 'until'
  baseline        TEXT,                   -- JSON fingerprint when mode = 'until_change'
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      TEXT NOT NULL DEFAULT 'recipient',
  UNIQUE (gitlab_username, mr_url)
);

CREATE INDEX IF NOT EXISTS idx_user_mutes_user ON user_mutes (gitlab_username);

-- One row per scan cycle.
CREATE TABLE IF NOT EXISTS runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  status         TEXT NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'failed', 'skipped')),
  trigger        TEXT NOT NULL,           -- 'schedule' | 'manual' | 'cli'
  dry_run        INTEGER NOT NULL DEFAULT 0,
  mrs_scanned    INTEGER NOT NULL DEFAULT 0,
  reasons_found  INTEGER NOT NULL DEFAULT 0,
  digests_built  INTEGER NOT NULL DEFAULT 0,
  digests_sent   INTEGER NOT NULL DEFAULT 0,
  failures       INTEGER NOT NULL DEFAULT 0,
  skipped_reason TEXT,
  error          TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC);

-- The digests produced by the most recent scan, so the panel's Pending page is
-- instant and stays truthful while the service is paused. Replaced wholesale each run.
CREATE TABLE IF NOT EXISTS snapshot_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  gitlab_username TEXT NOT NULL,
  mr_url          TEXT NOT NULL,
  mr_title        TEXT NOT NULL,
  project_path    TEXT NOT NULL,
  author          TEXT,
  reasons         TEXT NOT NULL,          -- JSON array of reason kinds
  waiting_since   TEXT NOT NULL,
  deliverable     INTEGER NOT NULL DEFAULT 1,
  skip_reason     TEXT
);

CREATE INDEX IF NOT EXISTS idx_snapshot_run ON snapshot_items (run_id);
CREATE INDEX IF NOT EXISTS idx_snapshot_user ON snapshot_items (run_id, gitlab_username);

-- Append-only audit trail. Covers every panel mutation and every delivery attempt.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  actor       TEXT NOT NULL,              -- 'admin', 'scheduler', 'cli', 'system'
  source_ip   TEXT,
  action      TEXT NOT NULL,              -- e.g. 'exclusion.add', 'notification.send'
  target      TEXT,
  before      TEXT,                       -- JSON, null for creates
  after       TEXT,                       -- JSON, null for deletes
  outcome     TEXT NOT NULL DEFAULT 'ok', -- 'ok' | 'error'
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor, at DESC);
