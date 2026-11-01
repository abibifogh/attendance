-- Payslips sent by email: one row for each attempt, the latest per person
-- and month saying where it stands. The slip's fingerprint at the time, so a
-- month reopened and closed again shows which payslips changed since sent.
CREATE TABLE IF NOT EXISTS pay_slip_mail (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    INTEGER NOT NULL REFERENCES pay_run (id) ON DELETE CASCADE,
  staff_id  INTEGER NOT NULL,
  address   TEXT,
  status    TEXT    NOT NULL,              -- sent | failed
  error     TEXT,
  slip_hash TEXT,
  by_name   TEXT,
  at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pay_slip_mail_run ON pay_slip_mail (run_id, staff_id, id);
