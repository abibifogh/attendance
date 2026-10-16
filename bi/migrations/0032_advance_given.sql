-- ------------------------------------- Advances: given to one person to report --

-- Instead of more time, an admin (or a supervisor who acts on advances) gives
-- an advance to one member of staff to report on the expense form. Then only
-- that person's Close shift in HIVE waits for it; everybody else's closes.
ALTER TABLE advance_decision ADD COLUMN given_to INTEGER;      -- HIVE user id
ALTER TABLE advance_decision ADD COLUMN given_name TEXT;
ALTER TABLE advance_decision ADD COLUMN given_by TEXT;
ALTER TABLE advance_decision ADD COLUMN given_at TEXT;
