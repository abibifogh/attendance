-- Sign a day, a week or a month off — but never the same days twice.
--
-- The reckoning was keyed to a calendar month, which is the wrong shape as soon
-- as somebody wants to close off a single week before payroll, or settle one
-- disputed Tuesday and be done with it. So the record holds a period.
--
-- That freedom brings the one hazard worth building against. Sign off the first
-- week at a day short, then sign off the whole month at three days short, and
-- four days come off somebody's leave for three days of absence. Nothing in the
-- arithmetic would notice; the person would, eventually, and by then there is no
-- way to reconstruct which charge was the mistake.
--
-- So periods for one person may not overlap. Signing off a month that contains
-- an already-signed week is refused, by name and by date, rather than quietly
-- added to it — reopen the week first and the month is then free. It is a
-- deliberate obstruction: every alternative silently produces a wrong number.
--
-- Existing month sign-offs carry over as periods of exactly their month, so
-- nothing already decided has to be decided again.

CREATE TABLE IF NOT EXISTS att_period_review (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id       INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  -- What was being looked at. Only ever a label: the dates are what count, and
  -- every check below is on them.
  kind           TEXT    NOT NULL DEFAULT 'month',
  from_day       TEXT    NOT NULL,
  to_day         TEXT    NOT NULL,
  -- What the figures said at the moment it was signed, kept so a later
  -- recomputation cannot rewrite the basis of somebody's decision.
  scheduled_days REAL    NOT NULL,
  worked_days    REAL    NOT NULL,
  difference     INTEGER NOT NULL,
  -- What was actually done about it. Whole days: the figures behind this are
  -- counted as events rather than measured in hours, so a fractional charge
  -- would invent a precision the rule does not have.
  decision       TEXT    NOT NULL DEFAULT 'approved',
  days_applied   INTEGER NOT NULL DEFAULT 0,
  note           TEXT,
  decided_by     TEXT    NOT NULL,
  decided_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (staff_id, from_day, to_day)
);

CREATE INDEX IF NOT EXISTS idx_att_period_review_span
  ON att_period_review (staff_id, from_day, to_day);

INSERT OR IGNORE INTO att_period_review
  (staff_id, kind, from_day, to_day, scheduled_days, worked_days, difference,
   decision, days_applied, note, decided_by, decided_at)
  SELECT staff_id, 'month',
         month || '-01',
         date(month || '-01', '+1 month', '-1 day'),
         scheduled_days, worked_days, CAST(ROUND(difference) AS INTEGER),
         decision, CAST(ROUND(days_applied) AS INTEGER), note, decided_by, decided_at
    FROM att_month_review;

DROP TABLE att_month_review;
