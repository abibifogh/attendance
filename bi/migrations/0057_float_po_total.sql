-- A float's receipt whose PO was changed in Odoo to another total: the new
-- total, and what the person holding the float and an admin said to it.
-- Until it is accepted the receipt's own amount counts; an admin's answer
-- stands over theirs. A new change in Odoo asks again.
ALTER TABLE float_receipt ADD COLUMN po_total INTEGER;
ALTER TABLE float_receipt ADD COLUMN holder_answer TEXT;   -- accept | dispute
ALTER TABLE float_receipt ADD COLUMN holder_at TEXT;
ALTER TABLE float_receipt ADD COLUMN admin_answer TEXT;    -- accept | keep
ALTER TABLE float_receipt ADD COLUMN admin_by TEXT;
ALTER TABLE float_receipt ADD COLUMN admin_at TEXT;
