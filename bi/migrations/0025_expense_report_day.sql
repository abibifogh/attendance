-- The expense form's own date of the expense and where it was paid from
-- (the cash register or the safe): what ties a response to a shift.
ALTER TABLE expense_report ADD COLUMN expense_day TEXT;
ALTER TABLE expense_report ADD COLUMN paid_from TEXT;
