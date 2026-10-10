-- Every confirmed purchase order in Odoo of the last few months, with whether
-- it has a posted bill. Read each time Odoo is asked about the cash POs; a PO
-- with no posted bill is a to-do item however it was paid.
CREATE TABLE IF NOT EXISTS odoo_po (
  po          TEXT PRIMARY KEY,
  vendor      TEXT,
  total       INTEGER NOT NULL DEFAULT 0,
  state       TEXT,
  ordered_on  TEXT,
  billed      INTEGER NOT NULL DEFAULT 0,
  posted      INTEGER NOT NULL DEFAULT 0,
  drafts      TEXT,                     -- JSON: names of bills still in draft
  checked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_odoo_po_ordered ON odoo_po (ordered_on);
