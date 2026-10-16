-- ------------------------------------------------- Create PO: what was made --

-- Every draft PO made in Odoo from Insight's Create PO, and by whom. Odoo has
-- the PO itself (its Source Document says "Insight · <name>"); this is the
-- record on this side.
CREATE TABLE IF NOT EXISTS po_created (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  odoo_id     INTEGER NOT NULL,
  name        TEXT,
  vendor      TEXT,
  product     TEXT,
  description TEXT,
  amount      INTEGER NOT NULL,   -- GH₵ minor units, as typed
  total       INTEGER,            -- the PO's total in Odoo, after any tax
  day         TEXT NOT NULL,
  receipt     INTEGER NOT NULL DEFAULT 0,
  by_name     TEXT,
  at          TEXT NOT NULL
);
