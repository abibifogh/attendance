-- Floats whose receipts go to the POS (src/routes/floats.js).
--
-- Some float holders buy for the bistro, the bar or the craft shop, whose
-- stock and purchase orders live in the POS, not in Odoo. An admin ticks
-- where each person's receipts may go; a receipt then becomes a draft PO in
-- Odoo, or a draft purchase order in the POS for that side.

-- Where this person's receipts may go, as a JSON list of odoo, kitchen, bar,
-- craft. NULL is Odoo only (everybody before this, and somebody new); an
-- empty list is nowhere: their receipts wait in Insight for somebody to choose.
ALTER TABLE float_person ADD COLUMN dests TEXT;

-- Where one receipt went: odoo, kitchen, bar or craft; wait while somebody
-- has still to choose. NULL on a receipt from before this, which went to Odoo.
ALTER TABLE float_receipt ADD COLUMN dest TEXT;
-- Its purchase order in the POS, when it went there.
ALTER TABLE float_receipt ADD COLUMN pos_id TEXT;
ALTER TABLE float_receipt ADD COLUMN pos_no TEXT;
ALTER TABLE float_receipt ADD COLUMN pos_status TEXT;
ALTER TABLE float_receipt ADD COLUMN pos_url TEXT;
-- Why it is not in the POS yet, when the POS did not take it.
ALTER TABLE float_receipt ADD COLUMN pos_problem TEXT;
-- Each thing bought, as read off the receipt (JSON), for the POS's order lines.
ALTER TABLE float_receipt ADD COLUMN lines TEXT;
