-- The suspense account: differences an admin parks to look at later, with
-- their amount (plus: money in that ASSD does not show; minus: money ASSD
-- shows that is not there). Each is cleared by matching it with others in
-- the account, or by moving it to the safe, where it is a line in or out
-- until the safe is next counted.
CREATE TABLE IF NOT EXISTS suspense (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  keys         TEXT    NOT NULL,              -- JSON: the differences it came from
  day          TEXT,
  slot         TEXT,
  what         TEXT    NOT NULL,
  amount       INTEGER NOT NULL,              -- pesewas, signed
  note         TEXT,
  answered     INTEGER NOT NULL DEFAULT 1,    -- its differences answered "In suspense" (not when reconciled together)
  by_name      TEXT,
  at           TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'open',   -- open | matched | safe
  group_id     INTEGER,                       -- matched together: the lowest id of the set
  cleared_note TEXT,
  cleared_by   TEXT,
  cleared_at   TEXT,
  safe_day     TEXT,
  closure_id   INTEGER                        -- the safe count that took it in
);
CREATE INDEX IF NOT EXISTS idx_suspense_status ON suspense (status);
