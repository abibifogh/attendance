-- A to-do made from a difference ("What does not agree"), for an Insight
-- user, with a day it is due. Its own thing: answering the difference does
-- not close it, and Done on it does not answer the difference. Whoever it is
-- for is emailed when it is made and each morning after until it is done.
CREATE TABLE IF NOT EXISTS shift_task (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key          TEXT NOT NULL,            -- the difference it came from
  about        TEXT,                     -- the difference, in words
  day          TEXT,                     -- the shift's day and slot, to open it
  slot         TEXT,
  what         TEXT NOT NULL,
  for_id       INTEGER NOT NULL,
  for_name     TEXT NOT NULL,
  due          TEXT NOT NULL,            -- YYYY-MM-DD
  state        TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done', 'removed')),
  made_by_id   INTEGER,
  made_by      TEXT NOT NULL,
  made_at      TEXT NOT NULL,
  done_by      TEXT,
  done_at      TEXT,
  reminders    INTEGER NOT NULL DEFAULT 0,
  reminded_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_shift_task_key ON shift_task (key);
CREATE INDEX IF NOT EXISTS idx_shift_task_open ON shift_task (state, for_id);
