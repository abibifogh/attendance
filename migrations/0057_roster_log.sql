-- ---------------------------------------------------------------------------
-- Who changed this shift, and what it was before
--
-- The rota already carried `set_by` and `set_at`, which answer "who touched
-- this last" and nothing else. The question people actually ask is the other
-- one: this cell says Dinner and somebody remembers agreeing Breakfast, so who
-- changed it, when, and what did it say before. That needs a row per change
-- rather than a column per row.
--
-- Deliberately not a foreign key onto att_roster. The most interesting entry
-- in any trail is the one where the row was deleted, and a cascade would take
-- exactly that entry with it.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS att_roster_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT    NOT NULL DEFAULT (datetime('now')),
  day          TEXT    NOT NULL,
  -- The state after the change. Null staff is an empty slot standing on the
  -- day; null shift on a removal is "there is nothing here any more".
  staff_id     INTEGER,
  shift_id     INTEGER,
  -- The state before it. Both null on the first entry of a cell's life.
  was_staff_id INTEGER,
  was_shift_id INTEGER,
  -- added | changed | removed | published
  action       TEXT    NOT NULL,
  -- hand | copy | import | draft | publish | off_rota
  source       TEXT    NOT NULL DEFAULT 'hand',
  actor        TEXT    NOT NULL,
  detail       TEXT
);

-- The two ways a trail is read: one person's day, and one shift on one day.
CREATE INDEX IF NOT EXISTS idx_roster_log_cell  ON att_roster_log (staff_id, day);
CREATE INDEX IF NOT EXISTS idx_roster_log_shift ON att_roster_log (day, shift_id);
CREATE INDEX IF NOT EXISTS idx_roster_log_at    ON att_roster_log (at DESC);
