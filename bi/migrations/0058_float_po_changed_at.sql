-- When the PO's new total was first seen. Within 30 days of the receipt
-- being sent, the person holding the float is asked too; after that, only
-- an admin.
ALTER TABLE float_receipt ADD COLUMN po_changed_at TEXT;
