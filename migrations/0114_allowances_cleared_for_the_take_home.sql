-- Every standing allowance cleared, now that the take-home works them out.
--
-- The allowances typed in by hand were the balancing figures from an earlier
-- month: Linda's 1,437.64 was what got her to that month's pay, and it stayed
-- there after the month it was right for. With a take-home on everybody the
-- allowance is worked out fresh every month, so the old figures are cleared.
--
-- JULY 2026 IS NOT TO MOVE. A closed month answers from the payslips written
-- when it was closed and never reads these rows again, so clearing them
-- leaves it exactly as it was. A month still open is worked out from today's
-- figures, and clearing them would rewrite it. So nothing is cleared unless
-- July 2026 is closed, or was never opened at all. If July is still open the
-- allowances stay where they are until it has been closed.
--
-- NOTHING IS LOST. Every row is copied here first, with when it was cleared,
-- so any of them can be put back.
CREATE TABLE IF NOT EXISTS pay_allowance_cleared (
  id         INTEGER PRIMARY KEY,
  staff_id   INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  amount     REAL    NOT NULL DEFAULT 0,
  taxable    INTEGER NOT NULL DEFAULT 1,
  active     INTEGER NOT NULL DEFAULT 1,
  cleared_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO pay_allowance_cleared (id, staff_id, name, amount, taxable, active)
  SELECT id, staff_id, name, amount, taxable, active FROM pay_allowance
   WHERE NOT EXISTS (SELECT 1 FROM pay_run WHERE month = '2026-07' AND status <> 'final');

DELETE FROM pay_allowance
 WHERE id IN (SELECT id FROM pay_allowance_cleared)
   AND NOT EXISTS (SELECT 1 FROM pay_run WHERE month = '2026-07' AND status <> 'final');
