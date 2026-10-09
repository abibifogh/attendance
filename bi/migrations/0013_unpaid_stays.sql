-- Stays not fully paid (Shifts → Unpaid stays).
--
-- Nothing new to store: each reservation's charges now travel in its journal
-- entry beside its payments, and answers use shift_answer under `stay:` keys.
-- Supervisors see the list and may answer by default (answers wait for an
-- admin, like every supervisor answer). An admin changes it under Till
-- settings → Supervisor access.
INSERT OR IGNORE INTO till_access (account_id, area, level) VALUES (0, 'unpaid', 2);
