-- Up to five pictures on one medical bill.
--
-- A bill was one picture. A real one is often more: the receipt, the
-- prescription it was for, a second page of a lab report. Somebody with three
-- pieces of paper and room for one either leaves two out or splits one bill
-- into three with made-up amounts, and neither is what the office wants.
--
-- So the pictures get a table of their own. hr_medical_receipt.document_id
-- stays and still holds the first one, so anything that only ever looked
-- there keeps working; every picture, the first included, is listed here.
CREATE TABLE IF NOT EXISTS hr_medical_receipt_file (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id  INTEGER NOT NULL REFERENCES hr_medical_receipt (id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES hr_document (id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL DEFAULT 0,
  at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hr_medical_receipt_file ON hr_medical_receipt_file (receipt_id, seq);

-- Every picture already sent, as the first of its bill's.
INSERT INTO hr_medical_receipt_file (receipt_id, document_id, seq)
  SELECT r.id, r.document_id, 0 FROM hr_medical_receipt r
   WHERE r.document_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM hr_document d WHERE d.id = r.document_id)
     AND NOT EXISTS (SELECT 1 FROM hr_medical_receipt_file f WHERE f.receipt_id = r.id);
