-- Till shortages on their own payslip line, and only from a checked shift.
--
-- A shortage Insight sends to be recovered from pay is still recorded as an
-- advance (one month, approved), because the payroll already knows how to take
-- an advance back. What changes: it is marked as a till shortage, so the
-- payslip gives it its own line instead of calling it a salary advance; it
-- carries the shift it came from; and it comes off pay only while that shift
-- is checked in Insight. HIVE asks Insight which are checked every few minutes.

ALTER TABLE hr_advance ADD COLUMN till_key TEXT;
ALTER TABLE hr_advance ADD COLUMN till_day TEXT;
ALTER TABLE hr_advance ADD COLUMN till_slot TEXT;
ALTER TABLE hr_advance ADD COLUMN till_checked_at TEXT;
ALTER TABLE hr_advance ADD COLUMN till_checked_by TEXT;

-- The shortages already recovered, told apart from salary advances by the
-- words every one of them was written with. Their shift is read off the reason
-- ("Till: …, 2026-08-01 afternoon") by the first sync, which also asks whether
-- it is checked; until then they wait, as any unchecked shortage does.
UPDATE hr_advance SET purpose = 'till'
 WHERE decision = 'A till shortage, recovered from pay as agreed under My till';

CREATE INDEX IF NOT EXISTS idx_hr_advance_till ON hr_advance (till_key);
