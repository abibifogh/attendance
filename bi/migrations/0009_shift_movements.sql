-- A person's correction to a Cash Movement out of the front drawer.
--
-- ASSD records a movement as an amount and nothing else, and Insight labels
-- it from the Money Count done just before it. People get that wrong in both
-- directions, and sometimes move the same expense twice. One row per
-- movement, by its ASSD number:
--
--   expenses / safe   what the movement really was
--   split             `expenses` of it was expenses, the rest went to the safe
--   duplicate         it repeats movement `pair` and moved no cash
--   reverses          it puts back movement `pair`, on this shift or another;
--                     both are left out of their drawers
--
-- Deleting the row puts the movement back as ASSD and the counts have it.
CREATE TABLE IF NOT EXISTS shift_movement (
  seq        INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,
  expenses   INTEGER,
  pair       INTEGER,
  note       TEXT,
  by_name    TEXT,
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shift_movement_pair ON shift_movement (pair);
