-- A contract of employment is accepted online by typing a full name, then
-- signed on paper at the property. These record the paper signing against the
-- contract that was accepted, rather than as a separate paper contract.
ALTER TABLE hr_contract ADD COLUMN paper_signed_on TEXT;
ALTER TABLE hr_contract ADD COLUMN paper_recorded_by TEXT;
ALTER TABLE hr_contract ADD COLUMN paper_document_id INTEGER REFERENCES hr_document (id) ON DELETE SET NULL;
