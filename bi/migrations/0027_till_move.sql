-- ---------------------------------------- differences put on staff accounts --

-- An admin puts a drawer short, over or hand-over difference on one or more
-- people's accounts, with a reason. Each share goes on that person's list in
-- HIVE (To sort out) like any other difference; the shift's own person is
-- cleared of it. Undo keeps the row and marks it undone.
CREATE TABLE IF NOT EXISTS till_move (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT    NOT NULL,   -- the exception it came from: drawer:… or handover:…
  kind        TEXT    NOT NULL,   -- drawer-short, drawer-over, handover-gap
  day         TEXT    NOT NULL,
  slot        TEXT    NOT NULL,
  assd_user   TEXT,
  owner_id    INTEGER,            -- the shift's own person in HIVE, when known
  owner_name  TEXT,
  amount      INTEGER NOT NULL,   -- the whole difference, signed: short is negative
  shares      TEXT    NOT NULL,   -- JSON [{ userId, name, amount }], amounts signed like the whole
  reason      TEXT    NOT NULL,
  by_name     TEXT,
  at          TEXT    NOT NULL,
  undone_by   TEXT,
  undone_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_till_move_key ON till_move (key);
CREATE INDEX IF NOT EXISTS idx_till_move_day ON till_move (day);
