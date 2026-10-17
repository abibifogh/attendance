-- How a receipt's item was matched to a product in Odoo: by its words, or
-- picked by the reader by meaning ("Diesel Excellium" is Fuel). Null where
-- nothing was matched.
ALTER TABLE receipt ADD COLUMN item_by TEXT;
