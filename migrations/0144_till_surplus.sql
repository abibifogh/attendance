-- Till surpluses paid with salary. A surplus an admin put on somebody's
-- account in Insight (money over, owed to them) and decided to pay through
-- payroll. On the month's payslip it nets against any till shortage coming
-- off, and what is left over is paid with their pay, untaxed: it is their
-- own money handed back, not earnings.
CREATE TABLE IF NOT EXISTS till_credit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id    INTEGER NOT NULL REFERENCES att_staff (id),
  amount      REAL    NOT NULL,              -- cedis owed to them
  currency    TEXT    NOT NULL DEFAULT 'GHS',
  month       TEXT    NOT NULL,              -- the payroll it is paid with, YYYY-MM
  reason      TEXT,
  till_key    TEXT    UNIQUE,                -- Insight's key for it; sent twice is still one
  till_day    TEXT,
  till_slot   TEXT,
  decided_by  TEXT,
  at          TEXT    NOT NULL DEFAULT (datetime('now')),
  status      TEXT    NOT NULL DEFAULT 'due' -- due | cancelled
);
CREATE INDEX IF NOT EXISTS idx_till_credit_month ON till_credit (month, staff_id);
