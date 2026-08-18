-- Signing in once, and reaching four systems from it.
--
-- Until now this app had a single password and one person behind it. That is
-- the right size of lock for a reporting tool nobody else opens, and the wrong
-- one the moment it becomes the front door to the group's other software.
--
-- So: real accounts, an explicit grant per system per person, and a record of
-- every hand-off. The grant is the part worth being deliberate about. Being
-- able to sign in here does not imply being able to open the till, and a person
-- who leaves is switched off in one place rather than four.

-- ------------------------------------------------------------- the systems --

-- Somewhere a person signs in. Not the same thing as a source: `sources` is
-- where data is *read from*, and this is where a person is *sent to*. Four rows
-- overlap between the two tables and one does not — this app is a system a
-- person is granted access to, and it is nobody's data source.
CREATE TABLE IF NOT EXISTS systems (
  id          TEXT PRIMARY KEY,
  label       TEXT    NOT NULL,
  description TEXT,
  -- Where a person lands. Also what the hub links to when single sign-on is
  -- off, so the hub is useful before any of this is configured.
  home_url    TEXT    NOT NULL DEFAULT '',
  -- The endpoint that accepts a hand-off code. Set by an administrator and
  -- never taken from a request — a redirect target that a caller can choose is
  -- an open redirect, and an open redirect on an identity provider is a
  -- phishing page with your own domain on it.
  sso_url     TEXT    NOT NULL DEFAULT '',
  sso_enabled INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 100
);
INSERT OR IGNORE INTO systems (id, label, description, sort_order) VALUES
  ('insight',    'Insight',            'The group''s numbers, all four systems at once.',            10),
  ('attendance', 'Staff attendance',   'Attendance, rota and leave from the terminal at the door.',  20),
  ('breakfast',  'Breakfast & rooms',  'Guests, breakfast stock, housekeeping rounds, maintenance.', 30),
  ('pos',        'Restaurant POS',     'Orders, kitchen, shifts and cash.',                          40),
  ('laundry',    'Laundry',            'Guest laundry, from drop-off to collection.',                50);

-- ------------------------------------------------------------- the accounts --

-- One row per person who may sign in here.
--
-- Passwords are stretched in the browser and only ever reach the server as a
-- derived key, which this then keeps a peppered hash of — the same scheme the
-- attendance app uses, for the same two reasons: a Worker cannot afford six
-- hundred thousand PBKDF2 rounds inside its CPU budget, and a stolen database
-- should still have to be attacked one full derivation at a time.
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  password_hash TEXT,
  -- An owner may manage accounts and grants. Everybody else may only use what
  -- they have been given.
  is_owner      INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts (active, email);

INSERT OR IGNORE INTO settings (key, value)
  VALUES ('pin_pepper', lower(hex(randomblob(32))));

-- Who may reach what. No row means no access; there is no implicit grant and
-- no role that quietly carries all of them.
CREATE TABLE IF NOT EXISTS account_access (
  account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  system_id  TEXT    NOT NULL REFERENCES systems (id) ON DELETE CASCADE,
  -- Passed to the far system in the hand-off. What it means is that system's
  -- business; this one only carries it.
  role       TEXT    NOT NULL DEFAULT '',
  granted_by TEXT,
  granted_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, system_id)
);
CREATE INDEX IF NOT EXISTS idx_access_system ON account_access (system_id);

-- ----------------------------------------------------------- the hand-off --

-- One row per hand-off, from the moment somebody clicks until the far system
-- has redeemed it or it has expired.
--
-- The code itself is never stored. What is stored is its SHA-256, so a copy of
-- this database yields no live codes — the same reason a password table holds
-- hashes. `redeemed_at` is what makes a code single-use, and it is enforced
-- here rather than at the far end, because there are four far ends and only one
-- of these.
CREATE TABLE IF NOT EXISTS sso_codes (
  code_hash   TEXT PRIMARY KEY,
  system_id   TEXT    NOT NULL REFERENCES systems (id) ON DELETE CASCADE,
  account_id  INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT    NOT NULL,
  redeemed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sso_codes_expiry ON sso_codes (expires_at);

-- Every hand-off attempt, kept. An identity provider without an audit trail is
-- a system where "who opened the till at nine" has no answer, and this app
-- exists precisely because unanswerable questions are expensive.
CREATE TABLE IF NOT EXISTS sso_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT    NOT NULL DEFAULT (datetime('now')),
  system_id  TEXT,
  account_id INTEGER,
  email      TEXT,
  event      TEXT    NOT NULL,    -- issued | redeemed | refused
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sso_log_at ON sso_log (id DESC);
