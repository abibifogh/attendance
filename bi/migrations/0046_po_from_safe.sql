-- A PO a shift reported as paid from the drawer that was really paid, in
-- whole or in part, from the big safe. The amount comes off what that
-- shift's drawer has to account for, and goes in the safe book as a PO paid
-- from the safe (`entry_id`), so each side holds only what it paid.
CREATE TABLE IF NOT EXISTS shift_po_safe (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  day       TEXT    NOT NULL,
  slot      TEXT    NOT NULL,
  po        TEXT    NOT NULL,             -- P02540
  amount    INTEGER NOT NULL,             -- pesewas paid from the safe
  why       TEXT,
  entry_id  INTEGER,                      -- the safe book's line for it
  by_name   TEXT,
  at        TEXT    NOT NULL,
  UNIQUE (day, slot, po)
);
