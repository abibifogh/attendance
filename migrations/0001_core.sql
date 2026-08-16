-- The parts every screen needs before attendance means anything: who may open
-- it, what the property is called, and how anybody gets told something.
--
-- Written as one migration rather than the dozen it took to arrive at, because
-- this database starts here. There is no installation part-way through the
-- history to be walked forward.
--
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('property_name', 'Staff Attendance'),
  -- Decides which calendar day a punch belongs to. Set it before the terminal
  -- starts sending, because changing it later moves days across boundaries.
  ('timezone',      'Africa/Accra'),
  ('notices_enabled', '1'),
  ('push_on_exception', '1');

-- The installation's pepper for hashing PINs and device tokens. Generated once,
-- here, so that rotating the session key never invalidates everybody's PIN.
INSERT OR IGNORE INTO settings (key, value)
  VALUES ('pin_pepper', lower(hex(randomblob(32))));

-- ---------------------------------------------------------------------------
-- People who can sign in
-- ---------------------------------------------------------------------------

-- Not the same list as the staff whose attendance is recorded.
--
-- Almost nobody who clocks in has a login: a room attendant has a face on a
-- terminal and no reason to ever open this. These are the handful of people who
-- do — supervisors, managers, whoever sets it up. `att_staff.user_id` links the
-- two where the same human is both.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  -- HMAC of the PIN, peppered from settings. Deterministic so a login is one
  -- indexed lookup rather than a scan. Null for administrators, who use a
  -- password instead.
  pin_hash      TEXT    UNIQUE,
  email         TEXT    UNIQUE,
  password_hash TEXT,
  role          TEXT    NOT NULL DEFAULT 'supervisor',
  -- JSON array of permission keys. NULL means "use the role's defaults".
  permissions   TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_active ON users (active);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users (email);

-- ---------------------------------------------------------------------------
-- The trail
-- ---------------------------------------------------------------------------

-- Every decision with a person's name on it.
--
-- Attendance leans on this harder than most things would. A supervisor
-- confirming that somebody worked a shift the terminal has no record of is
-- making a claim that ends up in a wage, and "who said so" has to survive the
-- argument about it three months later.
CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL DEFAULT (datetime('now')),
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC);

-- ---------------------------------------------------------------------------
-- Telling somebody
-- ---------------------------------------------------------------------------

-- The bell: a count, and a list of what has happened since you last looked.
--
-- `audience` is a permission rather than a list of people, so a notice
-- addressed to whoever runs the rota still reaches somebody promoted tomorrow
-- and stops reaching somebody demoted yesterday.
CREATE TABLE IF NOT EXISTS app_notices (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL DEFAULT (datetime('now')),
  kind     TEXT NOT NULL,
  level    TEXT NOT NULL DEFAULT 'info',
  title    TEXT NOT NULL,
  body     TEXT,
  -- Held as text rather than assembled on the way out, so a notice always
  -- points where it pointed when it was written.
  link     TEXT,
  day      TEXT,
  slot     TEXT,
  actor    TEXT,
  audience TEXT
);

CREATE INDEX IF NOT EXISTS idx_app_notices_at ON app_notices (id DESC);

-- How far each person has read. One integer per person rather than a row per
-- person per notice, because the only question ever asked is "anything since I
-- last looked".
CREATE TABLE IF NOT EXISTS app_notice_reads (
  user_id INTEGER PRIMARY KEY,
  last_id INTEGER NOT NULL DEFAULT 0,
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Browser push, for the alert that has to arrive when the app is closed.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users (id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions (user_id);

-- What was sent and what came back. Notifications are the thing people forget,
-- so without this there is nothing to look at when somebody says they were
-- never told.
CREATE TABLE IF NOT EXISTS push_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  day    TEXT,
  sent   INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  detail TEXT,
  at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  kind       TEXT NOT NULL,
  day        TEXT,
  recipients TEXT,
  status     TEXT NOT NULL,
  detail     TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_log_at ON email_log (at DESC);
