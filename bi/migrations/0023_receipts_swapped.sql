-- Receipts that left the front drawer with no Cash Movement, the notes going
-- up by as much: swapped for cash put into the drawer. Somebody reconciles
-- it on the shift that took them out, and the drawer is worked out again.
CREATE TABLE IF NOT EXISTS shift_receipts_swap (
  day     TEXT NOT NULL,
  slot    TEXT NOT NULL,
  amount  INTEGER NOT NULL,
  note    TEXT,
  by_name TEXT,
  at      TEXT NOT NULL,
  PRIMARY KEY (day, slot)
);
