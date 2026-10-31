-- A whole shift the journal put on the wrong day or slot, put where it
-- belongs by an admin: each of its ASSD sessions by the number of the line
-- that opened it ("Beginn of Day Processing"). The placing keeps to it; where
-- it was, why and who moved it are kept for Put it back.
CREATE TABLE IF NOT EXISTS shift_place (
  start_seq  INTEGER PRIMARY KEY,
  day        TEXT NOT NULL,
  slot       TEXT NOT NULL,
  from_day   TEXT,
  from_slot  TEXT,
  why        TEXT,
  by_name    TEXT,
  at         TEXT NOT NULL
);
