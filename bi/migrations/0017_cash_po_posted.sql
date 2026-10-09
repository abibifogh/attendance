-- Whether a cash PO's bill is posted in Odoo, not only entered. A draft bill
-- already counts in the costs (the nightly read takes drafts), so `billed`
-- still decides the money; but the to-do item to get the bill in stays open
-- until the bill is posted.
ALTER TABLE cash_po ADD COLUMN posted INTEGER NOT NULL DEFAULT 0;
