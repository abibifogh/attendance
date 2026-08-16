-- A week's rota, read from a file and held as a draft until somebody says yes.
--
-- The rota decides whether people are late and whether they are absent, so an
-- import that writes straight to it is one nobody dares run: a misread column
-- or a name matched to the wrong person is discovered a fortnight later in a
-- report, by which time the file it came from is three versions old.
--
-- So the file is parsed, every line is resolved against the staff and shifts
-- this property actually has, and the whole thing sits here saying what it
-- would do. Confirming applies it in one go. Discarding costs nothing, which is
-- the property that makes it safe to try.
--
-- The rows are kept after applying rather than deleted. "Where did Thursday's
-- night shift come from" is a question that gets asked, and a draft that erases
-- itself on success cannot answer it.

CREATE TABLE IF NOT EXISTS att_roster_import (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT,
  from_day    TEXT,
  to_day      TEXT,
  -- draft → applied, or draft → discarded. Never back.
  status      TEXT    NOT NULL DEFAULT 'draft',
  created_by  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  decided_by  TEXT,
  decided_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_att_roster_import_status
  ON att_roster_import (status, created_at);

CREATE TABLE IF NOT EXISTS att_roster_import_row (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id  INTEGER NOT NULL REFERENCES att_roster_import (id) ON DELETE CASCADE,
  line       INTEGER NOT NULL,
  -- What the file said, kept verbatim. Every judgement below was made from
  -- these, so they have to survive for the judgement to be arguable later.
  raw_name   TEXT,
  raw_position TEXT,
  raw_title  TEXT,
  raw_note   TEXT,
  day        TEXT,
  starts_at  TEXT,
  ends_at    TEXT,
  -- What this app made of it.
  staff_id   INTEGER REFERENCES att_staff (id) ON DELETE SET NULL,
  shift_id   INTEGER REFERENCES att_shifts (id) ON DELETE SET NULL,
  shift_name TEXT,
  action     TEXT    NOT NULL DEFAULT 'skip',
  problem    TEXT
);

CREATE INDEX IF NOT EXISTS idx_att_roster_import_row ON att_roster_import_row (import_id, line);

-- Names the file uses that this property does not, once somebody has said who
-- they mean.
--
-- The export is written by a different system with its own spelling of every
-- person, and being asked the same question every Monday is how an import stops
-- being used. Answered once, remembered after.
CREATE TABLE IF NOT EXISTS att_name_alias (
  alias      TEXT    PRIMARY KEY,
  staff_id   INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  created_by TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- The two already established while loading this year's history. Both are the
-- scheduling system's spelling against Hik-Connect's, and neither would be
-- matched by shared words alone: one shares only a first name, the other only
-- a first name against a different surname entirely.
INSERT OR IGNORE INTO att_name_alias (alias, staff_id, created_by)
  SELECT 'chichi ayim', id, 'Import' FROM att_staff WHERE employee_no = 'BAR001';
INSERT OR IGNORE INTO att_name_alias (alias, staff_id, created_by)
  SELECT 'patience naa torshie', id, 'Import' FROM att_staff WHERE employee_no = 'HSK004';
