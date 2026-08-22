-- The payroll.
--
-- Everything the property already knows about somebody — what they are paid,
-- what they have been lent, what they were docked — comes together here once a
-- month and turns into a payslip. What makes a payroll different from every
-- other screen in this app is that its answers are final: a payslip is handed
-- over, filed and argued about months later, and it must say the same thing
-- then as it said on payday.
--
-- SO A FINALISED RUN IS A SNAPSHOT, NOT A QUERY. The whole computation is
-- written into pay_slip as it stood, tax bands and all. Change somebody's
-- salary in November and October's payslip is untouched, which is the entire
-- point. A payroll that recomputes history is one nobody can be held to.
--
-- THE BONUS IS AGREED NET. A scheme is worth so much in somebody's hand; the
-- tax on it is the property's to carry. So the amounts stored here for schemes
-- and for misconduct are net figures, and the grossing up happens at the
-- moment of computation against the salary beside it.

-- What somebody is paid, for payroll purposes.
--
-- Kept apart from hr_pay, which is the dated rate the labour-cost report reads
-- and can be daily or hourly. This is the monthly basic a payslip is built
-- from, and whether SSNIT applies to them at all.
CREATE TABLE IF NOT EXISTS pay_profile (
  staff_id INTEGER PRIMARY KEY REFERENCES att_staff (id) ON DELETE CASCADE,
  basic    REAL    NOT NULL DEFAULT 0,
  ssnit    INTEGER NOT NULL DEFAULT 1,
  note     TEXT,
  set_by   TEXT,
  set_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- The standing allowances. One row each rather than a single figure, because a
-- payslip has to say what the money was for, and because transport is taxable
-- and a reimbursement is not.
CREATE TABLE IF NOT EXISTS pay_allowance (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  name     TEXT    NOT NULL,
  amount   REAL    NOT NULL DEFAULT 0,
  taxable  INTEGER NOT NULL DEFAULT 1,
  active   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_pay_allowance ON pay_allowance (staff_id);

-- A performance bonus scheme: what it is worth at a hundred per cent, and who
-- is under it. Somebody can be under several, or none.
CREATE TABLE IF NOT EXISTS pay_scheme (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT    NOT NULL UNIQUE,
  note   TEXT,
  amount REAL    NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pay_scheme_staff (
  scheme_id INTEGER NOT NULL REFERENCES pay_scheme (id) ON DELETE CASCADE,
  staff_id  INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  PRIMARY KEY (scheme_id, staff_id)
);

-- One month's payroll.
CREATE TABLE IF NOT EXISTS pay_run (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  month     TEXT    NOT NULL UNIQUE,
  status    TEXT    NOT NULL DEFAULT 'draft',
  note      TEXT,
  opened_by TEXT,
  opened_at TEXT    NOT NULL DEFAULT (datetime('now')),
  closed_by TEXT,
  closed_at TEXT
);

-- What somebody scored on a scheme this month. The scheme's award is copied in
-- beside the score, so changing what a scheme is worth in December does not
-- rewrite what somebody was paid in June.
CREATE TABLE IF NOT EXISTS pay_score (
  run_id    INTEGER NOT NULL REFERENCES pay_run (id) ON DELETE CASCADE,
  scheme_id INTEGER NOT NULL REFERENCES pay_scheme (id) ON DELETE CASCADE,
  staff_id  INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  score     REAL    NOT NULL DEFAULT 0,
  amount    REAL,
  PRIMARY KEY (run_id, scheme_id, staff_id)
);

-- Money off the bonus for misconduct. A net figure, like the bonus it comes
-- out of, and it carries its reason because it appears on a payslip somebody
-- will ask about.
CREATE TABLE IF NOT EXISTS pay_penalty (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   INTEGER NOT NULL REFERENCES pay_run (id) ON DELETE CASCADE,
  staff_id INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  amount   REAL    NOT NULL,
  reason   TEXT,
  actor    TEXT,
  at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pay_penalty ON pay_penalty (run_id, staff_id);

-- The payslip itself, as it stood when the month was closed.
CREATE TABLE IF NOT EXISTS pay_slip (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL REFERENCES pay_run (id) ON DELETE CASCADE,
  staff_id     INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  -- The whole working, so a slip can be reprinted years later exactly as it
  -- was issued. The columns beside it are for adding up without opening it.
  detail       TEXT    NOT NULL,
  gross        REAL    NOT NULL DEFAULT 0,
  bonus_gross  REAL    NOT NULL DEFAULT 0,
  ssf_employee REAL    NOT NULL DEFAULT 0,
  ssf_employer REAL    NOT NULL DEFAULT 0,
  paye         REAL    NOT NULL DEFAULT 0,
  loans        REAL    NOT NULL DEFAULT 0,
  net          REAL    NOT NULL DEFAULT 0,
  cost         REAL    NOT NULL DEFAULT 0,
  UNIQUE (run_id, staff_id)
);

-- Where an advance repayment came from, so closing a payroll and closing the
-- advances month cannot record the same deduction twice, and so reopening a
-- payroll can take back exactly what it wrote.
ALTER TABLE hr_advance_entry ADD COLUMN source TEXT;

INSERT OR IGNORE INTO settings (key, value) VALUES
  -- The graduated monthly bands, as published by the Ghana Revenue Authority.
  -- Held as data because they change with the budget, and stamped on every
  -- payslip so a slip can be checked against the table it was worked out on.
  ('pay_bands', '[{"width":490,"rate":0},{"width":110,"rate":0.05},{"width":130,"rate":0.1},{"width":3166.67,"rate":0.175},{"width":16000,"rate":0.25},{"width":30520,"rate":0.3},{"width":null,"rate":0.35}]'),
  ('pay_bands_label', 'GRA monthly bands, 2026'),
  -- National Pensions Act 2008 (Act 766): 5.5% from the worker, 13% from the
  -- employer, on basic salary.
  ('pay_ssnit_employee', '0.055'),
  ('pay_ssnit_employer', '0.13'),
  -- Income Tax Act 2015 (Act 896): bonus at 5% as a final tax, up to 15% of
  -- annual basic salary.
  ('pay_bonus_rate', '0.05'),
  ('pay_bonus_share', '0.15');
