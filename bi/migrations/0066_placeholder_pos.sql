-- POs in Odoo still using a stand-in (src/routes/cashpo.js, src/routes/todo.js).
--
-- A PO made from a receipt Insight could not match uses the placeholder
-- vendor ("Vendor to confirm") or item ("Item to classify") chosen in Buying
-- › Receipts › Settings. Each is a to-do, kind "placeholder", for whoever an
-- admin chose to put them right in Odoo. Replaced whole each time Odoo is
-- read; left as it was when Odoo could not be read, so nothing closes by
-- mistake.
CREATE TABLE IF NOT EXISTS odoo_placeholder_po (
  po                TEXT PRIMARY KEY,
  odoo_id           INTEGER,
  vendor            TEXT,
  total             INTEGER,
  state             TEXT,
  ordered_on        TEXT,
  origin            TEXT,
  ref               TEXT,
  vendor_to_confirm INTEGER NOT NULL DEFAULT 0,
  item_to_confirm   INTEGER NOT NULL DEFAULT 0,
  url               TEXT,
  checked_at        TEXT NOT NULL
);
