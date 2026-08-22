-- Salary advances, and the months they are paid back over.
--
-- WHY THIS IS A LEDGER AND NOT TWO COLUMNS ON THE PERSON
--
-- The obvious shape is `advance_balance` on att_staff, decremented every
-- payday. It is also how every advance argument in this trade starts: somebody
-- says four hundred was taken off in June, the balance says otherwise, and
-- there is nothing to look at. So the balance here is not stored at all. What
-- is stored is what was handed over and what was taken back, each with a
-- month, an amount and whoever recorded it, and the balance is the difference.
-- A figure somebody can disagree with is worth nothing unless they can also be
-- shown the rows behind it.
--
-- ONE ADVANCE, ONE AGREEMENT
--
-- An advance is an agreement: this much now, that much a month, for this many
-- months. Somebody who takes a second advance while still paying the first has
-- made a second agreement, so it is a second row rather than a bigger number,
-- and both schedules run side by side. That is also how it is actually
-- discussed on the floor.
--
-- WHO MAY SEE IT
--
-- hr_pay, the same permission as what anybody earns. An advance says as much
-- about somebody's circumstances as their salary does, and often more.

CREATE TABLE IF NOT EXISTS hr_advance (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id   INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,

  -- What was handed over, and the agreement for getting it back. `monthly` is
  -- worked out from the other two when the advance is agreed and then stored,
  -- because it is a term of the agreement rather than a derived figure: an
  -- instalment that quietly recomputed itself when somebody paid a bit extra
  -- would be an app changing the deal.
  amount     REAL    NOT NULL,
  months     INTEGER NOT NULL,
  monthly    REAL    NOT NULL,
  currency   TEXT    NOT NULL DEFAULT 'GHS',

  reason     TEXT,

  -- requested | approved | declined | withdrawn | settled
  status     TEXT    NOT NULL DEFAULT 'requested',

  -- The day the money changed hands, and the first month a deduction is due.
  -- Kept apart: money handed over on the 28th is usually paid back from the
  -- following month, not that one.
  taken_on     TEXT,
  start_month  TEXT,

  asked_by     TEXT,
  asked_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  decided_by   TEXT,
  decided_at   TEXT,
  decision     TEXT,
  settled_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_hr_advance_staff ON hr_advance (staff_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_hr_advance_status ON hr_advance (status);

-- Every movement against an advance, in the month it belongs to.
--
--   repayment  what was actually deducted that month
--   skipped    a month where nothing was taken, recorded on purpose so the
--              gap is a decision somebody made rather than a missing row
--   adjustment a correction, or something paid outside the payroll
--   writeoff   the rest of it forgiven
--
-- Nothing here is ever edited into a different month. A wrong row is deleted
-- and re-entered, which leaves the audit log holding both halves.
CREATE TABLE IF NOT EXISTS hr_advance_entry (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  advance_id  INTEGER NOT NULL REFERENCES hr_advance (id) ON DELETE CASCADE,
  month       TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  amount      REAL    NOT NULL DEFAULT 0,
  note        TEXT,
  actor       TEXT,
  at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One answer per advance per month for the payroll question. Closing the same
-- month twice is a double deduction on paper and an argument in person, so the
-- database refuses it rather than the screen.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_advance_month
  ON hr_advance_entry (advance_id, month)
  WHERE kind IN ('repayment', 'skipped');

CREATE INDEX IF NOT EXISTS idx_hr_advance_entry ON hr_advance_entry (advance_id, month);

-- Which months have been dealt with, so the end-of-month prompt knows when to
-- stop asking. A month with nothing owed in it is still closed: "nobody owed
-- anything in July" is an answer, and an app that keeps asking gets ignored.
CREATE TABLE IF NOT EXISTS hr_advance_month (
  month     TEXT PRIMARY KEY,
  closed_by TEXT,
  closed_at TEXT NOT NULL DEFAULT (datetime('now')),
  note      TEXT
);
