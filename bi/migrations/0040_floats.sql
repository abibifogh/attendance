-- Floats: money given to people to spend. They send a picture of each
-- receipt from their own link; each becomes a draft PO in Odoo carrying their
-- reference (FLT/KOFI/005) as Vendor Reference and Source Document, and comes
-- off what they hold. Accepted once the PO is confirmed in Odoo; refused
-- (back on what they hold) with a reason.
CREATE TABLE IF NOT EXISTS float_person (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  code        TEXT    NOT NULL UNIQUE,   -- KOFI: their part of every reference
  note        TEXT,                      -- what the money is for
  token       TEXT    NOT NULL,          -- their link; a new one stops the old
  active      INTEGER NOT NULL DEFAULT 1,
  next_seq    INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL,
  created_by  TEXT
);

-- Money handed over, or given back.
CREATE TABLE IF NOT EXISTS float_move (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  INTEGER NOT NULL,
  kind       TEXT    NOT NULL,           -- given | back
  amount     INTEGER NOT NULL,           -- pesewas, always positive
  day        TEXT    NOT NULL,
  source     TEXT,                       -- safe | bank | drawer | other
  note       TEXT,
  by_name    TEXT,
  at         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS float_move_person ON float_move (person_id);

-- Each receipt they sent: the receipt row (read, PO) and where it stands.
CREATE TABLE IF NOT EXISTS float_receipt (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id   INTEGER NOT NULL,
  receipt_id  INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  ref         TEXT    NOT NULL,          -- FLT/KOFI/005
  status      TEXT    NOT NULL DEFAULT 'checking',  -- checking | accepted | refused
  reason      TEXT,
  decided_by  TEXT,
  decided_at  TEXT,
  at          TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS float_receipt_person ON float_receipt (person_id);
CREATE UNIQUE INDEX IF NOT EXISTS float_receipt_receipt ON float_receipt (receipt_id);
