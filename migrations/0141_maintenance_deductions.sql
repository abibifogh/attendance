-- Deductions that came in from Maintenance: a weekly report more than four
-- hours late is GHS 50 off the bonus, "Late submission of report". Each one
-- carries where it came from, so it is put on the payroll once however often
-- HIVE asks, and taken back off if Maintenance withdraws the report while
-- the month is still open. Deductions entered by hand have none.
ALTER TABLE pay_penalty ADD COLUMN source TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_penalty_source ON pay_penalty (source) WHERE source IS NOT NULL;
