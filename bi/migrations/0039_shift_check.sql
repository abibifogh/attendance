-- A shift checked by somebody: its figures are confirmed. Until then its
-- person sees its differences as "not checked yet". The snapshot holds each
-- difference as it was when checked (key → amount|qty): one that changes
-- afterwards is not checked again until somebody checks the shift again.
CREATE TABLE IF NOT EXISTS shift_check (
  day TEXT NOT NULL,
  slot TEXT NOT NULL,
  by_name TEXT,
  at TEXT NOT NULL,
  snapshot TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (day, slot)
);
