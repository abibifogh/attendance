-- The monthly reckoning: days owed against days worked.
--
-- A rota says somebody was due twenty-two days. The terminal says they worked
-- nineteen and a half. Somewhere those two and a half days have to go, and
-- until now this app would show both numbers and leave the arithmetic hanging
-- in the air for ever.
--
-- So each month is closed off deliberately, per person. The two numbers are
-- computed from the same rules every other screen uses — never stored, so a
-- correction to a shift or a supervisor's ruling changes them, right up until
-- the month is signed off. What is stored is the decision, because that is the
-- part nobody can recompute:
--
--   `days_applied` is what actually moves, signed. Negative takes days off the
--   person's leave entitlement — the usual case for a shortfall. Positive gives
--   days back, for somebody who covered more than they were rostered.
--
--   It is deliberately separate from `difference`. A manager who looks at three
--   days short and decides to charge one of them has made a judgement, and the
--   record has to hold both what the figures said and what was decided, or the
--   conversation six months later has nothing to stand on.
--
--   `waived` records exactly that judgement where nothing moves: the month was
--   looked at, and the difference was allowed to stand. An unreviewed month and
--   a month somebody decided to let go are not the same state, and a screen
--   that cannot tell them apart will keep asking about the same month for ever.
--
-- One row per person per month, so signing off twice is a correction rather
-- than a second charge against the same days.

CREATE TABLE IF NOT EXISTS att_month_review (
  staff_id       INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  month          TEXT    NOT NULL,
  -- What the figures said at the moment it was signed off, kept so a later
  -- recomputation cannot quietly rewrite the basis of somebody's decision.
  scheduled_days REAL    NOT NULL,
  worked_days    REAL    NOT NULL,
  difference     REAL    NOT NULL,
  -- What was actually done about it.
  decision       TEXT    NOT NULL DEFAULT 'approved',
  days_applied   REAL    NOT NULL DEFAULT 0,
  note           TEXT,
  decided_by     TEXT    NOT NULL,
  decided_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (staff_id, month)
);

CREATE INDEX IF NOT EXISTS idx_att_month_review_month ON att_month_review (month);
