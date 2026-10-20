-- Notes and history on a difference ("What does not agree"): notes written by
-- admins and supervisors, each tagging whoever should read it, and what
-- happened to it (answered, changed, taken back, approved, proof asked and
-- sent, put on a staff account, moved), from the day this was added. One
-- table so the order is the order things happened. Keyed by the difference's key.
CREATE TABLE IF NOT EXISTS shift_history (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  key      TEXT NOT NULL,
  type     TEXT NOT NULL CHECK (type IN ('note', 'event')),
  text     TEXT NOT NULL,
  tags     TEXT,               -- a note's: JSON [{ id, name }] of the accounts tagged
  by_id    INTEGER,
  by_name  TEXT,
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shift_history_key ON shift_history (key, id);
