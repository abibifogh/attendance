-- An expense with no PO that a shift's drawer shows but the big safe paid:
-- what it was for. Its `po` is a placeholder (NOPO-1, NOPO-2 …) and its
-- safe book line is a payment waiting for a PO.
ALTER TABLE shift_po_safe ADD COLUMN what TEXT;
