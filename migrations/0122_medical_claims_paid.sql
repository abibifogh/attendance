-- Approved medical claims go to finance to be paid, and are marked paid.
--
-- When a claim is approved HIVE emails the address below a payment voucher
-- with the receipts, and records when it went. Whoever pays it marks it paid
-- in HIVE, so the office can see which approved claims are still owed.
ALTER TABLE hr_medical_claim ADD COLUMN sent_to_pay_at TEXT;
ALTER TABLE hr_medical_claim ADD COLUMN paid_at TEXT;
ALTER TABLE hr_medical_claim ADD COLUMN paid_by TEXT;
ALTER TABLE hr_medical_claim ADD COLUMN paid_note TEXT;

INSERT OR IGNORE INTO settings (key, value) VALUES ('medical_pay_to', '["info@hostelaccra.com"]');
