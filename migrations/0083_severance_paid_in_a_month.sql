-- Severance paid, which the return asks about and a payroll does not hold.
--
-- Column 26 on the GRA's form wants what somebody was paid off with. It is
-- not a standing fact about a person the way their grade is: it happens once,
-- in one month, when they leave. Put on the profile it would repeat every
-- month afterwards until somebody noticed and cleared it, which is the sort
-- of figure that gets filed three times.
--
-- So it belongs to the run, the way money off a bonus does, and it goes with
-- the month it was paid in.
--
-- Reported, not taxed. The figure goes in the column that asks for it and
-- nothing else moves, because how severance is taxed depends on what it was
-- for and that is a decision above a payroll.
CREATE TABLE IF NOT EXISTS pay_severance (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   INTEGER NOT NULL REFERENCES pay_run (id) ON DELETE CASCADE,
  staff_id INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  amount   REAL    NOT NULL,
  note     TEXT,
  actor    TEXT,
  at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pay_severance ON pay_severance (run_id, staff_id);
