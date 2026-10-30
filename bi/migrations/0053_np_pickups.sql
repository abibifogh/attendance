-- Nice Place pickups: a supervisor takes the shifts' envelopes from the safe,
-- writes what was paid out of them (each a draft PO in Odoo, with its receipt)
-- and counts what is left. Admin reviews each one. The counted cash goes into
-- the main safe's book.

CREATE TABLE IF NOT EXISTS np_pickup (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  day          TEXT    NOT NULL,              -- the day of the pickup
  by_id        INTEGER,
  by_name      TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'open',  -- open | review | approved | asked
  sales        INTEGER NOT NULL DEFAULT 0,    -- pesewas: the shifts' money, as sent from the desk
  spent        INTEGER NOT NULL DEFAULT 0,    -- pesewas: paid out of it, with receipts
  counted      INTEGER,                       -- pesewas: what was in hand
  note         TEXT,                          -- why counted is not sales less spent
  next_seq     INTEGER NOT NULL DEFAULT 1,    -- for each expense's reference
  recorded_at  TEXT,
  reviewed_by  TEXT,
  reviewed_at  TEXT,
  review_note  TEXT,
  closure_id   INTEGER,                       -- the safe count it went into
  at           TEXT    NOT NULL
);

-- Each shift's envelope is picked up once.
CREATE TABLE IF NOT EXISTS np_pickup_shift (
  day        TEXT    NOT NULL,
  shift      TEXT    NOT NULL,
  pickup_id  INTEGER NOT NULL,
  amount     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, shift)
);
CREATE INDEX IF NOT EXISTS np_pickup_shift_pickup ON np_pickup_shift (pickup_id);

CREATE TABLE IF NOT EXISTS np_pickup_expense (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pickup_id   INTEGER NOT NULL,
  what        TEXT    NOT NULL,
  amount      INTEGER NOT NULL,               -- pesewas, as typed
  supplier    TEXT,
  ref         TEXT    NOT NULL,               -- NP/PU/014-1, on the PO
  receipt_id  INTEGER,
  by_name     TEXT,
  at          TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS np_pickup_expense_pickup ON np_pickup_expense (pickup_id);
