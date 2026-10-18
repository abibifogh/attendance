-- An admin looking at Insight as somebody else sees: who, as whom, from when
-- until when. Look only, so nothing else is recorded; this says it happened.
CREATE TABLE IF NOT EXISTS view_as_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  by_id INTEGER NOT NULL,
  by_name TEXT,
  as_id INTEGER NOT NULL,
  as_name TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS view_as_log_by ON view_as_log (by_id, ended_at);
