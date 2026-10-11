-- A PO's price can change after it was paid from a drawer. The difference is
-- paid (a top-up) or comes back (change back) on whichever shift the cash
-- moved, so a PO can now have more than one row. Only its first payment, the
-- claim, is still one per PO ever. A claim can also be an advance: cash given
-- out against a requisition before the purchase.
CREATE TABLE IF NOT EXISTS till_po_next (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  po        TEXT    NOT NULL,
  -- 'claim' the first payment, 'topup' more paid, 'change' money back (paid < 0)
  kind      TEXT    NOT NULL DEFAULT 'claim',
  report_id INTEGER,
  user_id   INTEGER NOT NULL,
  day       TEXT    NOT NULL,
  slot      TEXT    NOT NULL,
  paid      INTEGER NOT NULL,
  total     INTEGER NOT NULL,
  vendor    TEXT,
  state     TEXT,
  via       TEXT    NOT NULL DEFAULT 'report',
  -- 1 when given out before the purchase, against a PO still a requisition
  -- in Odoo: an advance, settled once the PO is approved and reported on the
  -- expense form.
  advance   INTEGER NOT NULL DEFAULT 0,
  at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO till_po_next (po, kind, report_id, user_id, day, slot, paid, total, vendor, state, via, at)
  SELECT po, 'claim', report_id, user_id, day, slot, paid, total, vendor, state, via, at FROM till_po;
DROP TABLE till_po;
ALTER TABLE till_po_next RENAME TO till_po;
CREATE UNIQUE INDEX IF NOT EXISTS idx_till_po_claim ON till_po (po) WHERE kind = 'claim';
CREATE INDEX IF NOT EXISTS idx_till_po_shift ON till_po (day, slot);
CREATE INDEX IF NOT EXISTS idx_till_po_po ON till_po (po);

-- What Insight last said about a PO paid from a drawer (Odoo, the expense
-- form, an admin's decision), kept ten minutes, so opening Close shift again
-- does not ask the same thing again. Signing always asks afresh.
CREATE TABLE IF NOT EXISTS till_po_odoo (
  po         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

-- A deficit somebody said was not paid on their shift: not asked of them again.
CREATE TABLE IF NOT EXISTS till_po_skip (
  po      TEXT    NOT NULL,
  total   INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (po, total, user_id)
);
