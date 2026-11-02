-- Team: an admin's notes on a person, and their scores on measures of the
-- admin's own (src/routes/team.js). People are HIVE's staff (att_staff.id).
CREATE TABLE IF NOT EXISTS team_note (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL,
  text     TEXT NOT NULL,
  by_name  TEXT,
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_note_staff ON team_note (staff_id, at);

CREATE TABLE IF NOT EXISTS team_score (
  staff_id   INTEGER NOT NULL,
  measure_id TEXT NOT NULL,
  score      REAL NOT NULL,
  by_name    TEXT,
  at         TEXT NOT NULL,
  PRIMARY KEY (staff_id, measure_id)
);
