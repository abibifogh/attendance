-- The safe book (Shifts → Safe).
--
-- Cash comes into the safe from the shifts' envelopes (worked out from ASSD,
-- nothing stored). What goes out is written here: a PO paid from the safe,
-- cash banked or handed over, or a payment still waiting for its PO. A count
-- closes a page of the book: it records what was counted, what the book said,
-- and takes in the shifts and payments of that page.

ALTER TABLE safe_closure ADD COLUMN counted INTEGER;   -- what was in the safe at the count
ALTER TABLE safe_closure ADD COLUMN book INTEGER;      -- what the book said it should hold

CREATE TABLE IF NOT EXISTS safe_entry (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL,          -- po | banked | pending
  day         TEXT    NOT NULL,          -- the day the cash left the safe
  amount      INTEGER NOT NULL,          -- pesewas out of the safe
  po          TEXT,                      -- P00440, once known
  vendor      TEXT,
  po_state    TEXT,
  po_total    INTEGER,
  ordered_on  TEXT,
  ref         TEXT,                      -- a deposit slip, who received it
  description TEXT,                      -- what a payment waiting for a PO was for
  note        TEXT,
  by_name     TEXT,
  at          TEXT    NOT NULL,
  settled_by  TEXT,                      -- who gave a waiting payment its PO
  settled_at  TEXT,
  closure_id  INTEGER REFERENCES safe_closure (id)
);
-- A PO is paid from the safe once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_safe_entry_po ON safe_entry (po) WHERE po IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_safe_entry_open ON safe_entry (closure_id, day);

-- POs somebody said were not paid from the safe, so they stop being offered.
CREATE TABLE IF NOT EXISTS safe_po_dismissed (
  po      TEXT PRIMARY KEY,
  by_name TEXT,
  at      TEXT NOT NULL
);
