-- A tax table has a date it starts on.
--
-- The bands were one setting, so there was one table and it was always the
-- current one. That is right until the day it changes. GRA moves the bands in
-- the budget, somebody types the new ones in, and every month still open —
-- including one being reopened to fix a single allowance — is quietly retaxed
-- at rates that were not in force when it was worked.
--
-- A closed month was always safe: closing writes every payslip out in full and
-- nothing recomputes them. This is for the months that are not closed yet, and
-- for the ones somebody reopens in July to correct something in January.
--
-- One row per set of figures, stamped with the first month it applies to. The
-- month picks the newest row that has started by then. The settings keep
-- holding the live figures, so every screen that reads them still shows what
-- is in force today.
CREATE TABLE IF NOT EXISTS pay_rates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  from_month     TEXT    NOT NULL UNIQUE,   -- 'YYYY-MM', the first month it applies to
  label          TEXT    NOT NULL,
  bands          TEXT    NOT NULL,          -- JSON, the same shape as the setting
  ssnit_employee REAL    NOT NULL,
  ssnit_employer REAL    NOT NULL,
  tier1          REAL    NOT NULL,
  tier2          REAL    NOT NULL,
  bonus_rate     REAL    NOT NULL,
  bonus_share    REAL    NOT NULL,
  set_by         TEXT,
  set_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pay_rates_from ON pay_rates (from_month DESC);
