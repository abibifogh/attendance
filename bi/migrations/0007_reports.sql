-- Published reports, read behind a PIN.
--
-- A report is a set of files somebody made elsewhere and wants a handful of
-- people to be able to open at a fixed address. The files live here, in the
-- database, and not in the repository — the repository is public, and a PIN on
-- a page whose source anybody can read on GitHub would be theatre.
--
-- Bodies are stored as the exact bytes uploaded and served back the same way.
-- "Do not change anything" is a promise best kept by never decoding.

CREATE TABLE IF NOT EXISTS reports (
  slug          TEXT PRIMARY KEY,
  title         TEXT    NOT NULL,
  published_at  TEXT    NOT NULL,
  published_by  INTEGER
);

CREATE TABLE IF NOT EXISTS report_files (
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  body          BLOB NOT NULL,
  PRIMARY KEY (slug, name)
);

-- One PIN per reader, so a PIN can be taken away from one person without
-- taking it away from everybody. Hashed with the installation's own pepper:
-- four digits is ten thousand possibilities and no hash slows that down, but
-- a copy of this table on its own still says nothing.
CREATE TABLE IF NOT EXISTS report_pins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  pin_hash      TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  created_by    INTEGER,
  last_used_at  TEXT,
  uses          INTEGER NOT NULL DEFAULT 0,
  revoked_at    TEXT
);

-- Wrong guesses, by address, so that ten thousand possibilities cannot simply
-- be tried. This is the actual protection a four-digit PIN has.
CREATE TABLE IF NOT EXISTS report_pin_attempts (
  ip  TEXT NOT NULL,
  at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS report_pin_attempts_at ON report_pin_attempts (at);
