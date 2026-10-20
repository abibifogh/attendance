-- Whose shift it was, chosen by an admin or a supervisor when ASSD and HIVE
-- name different people (somebody worked on another person's ASSD login).
-- Takes the place of whoever closed it in HIVE, or the ASSD login's person:
-- its differences and its list in HIVE follow the person chosen.
CREATE TABLE IF NOT EXISTS shift_owner (
  day          TEXT    NOT NULL,
  slot         TEXT    NOT NULL,
  hive_user_id INTEGER NOT NULL,
  name         TEXT,
  why          TEXT    NOT NULL,
  by_name      TEXT    NOT NULL,
  at           TEXT    NOT NULL,
  PRIMARY KEY (day, slot)
);
