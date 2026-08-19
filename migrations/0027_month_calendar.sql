-- What a particular month asked of a particular person.
--
-- The expectation was one number per person — five days a week, or whatever
-- their contract said — and it was applied to every month the same way. That is
-- close enough to right for an office and wrong for a hotel, where December is
-- not November: somebody covers the season on six days a week and goes back to
-- five in January, a kitchen closes for a fortnight, a person comes back
-- part-time after an illness for three months and then does not.
--
-- Encoding all of that as a days-per-week figure means editing it twice a year
-- and remembering to edit it back, and the month it is wrong for is the month
-- nobody notices until somebody's leave has already moved.
--
-- So a month can simply be told what it expected. One row per person per month,
-- set on the screen the figure is read on, and nothing at all for the months
-- where the ordinary rule is right — which is almost all of them.

CREATE TABLE IF NOT EXISTS att_calendar (
  staff_id INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  -- YYYY-MM. A month rather than a date range because that is the unit the
  -- reckoning is done in and the unit a contract is varied in.
  month    TEXT    NOT NULL,
  -- Working days this person was expected for, that month. Halves allowed: a
  -- month that ends mid-week for somebody on a five-and-a-half-day pattern is
  -- a real number and rounding it costs somebody real days.
  days     REAL    NOT NULL,
  -- Why it differs, for whoever reads the month back in March.
  note     TEXT,
  set_by   TEXT,
  set_at   TEXT    NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (staff_id, month)
);
CREATE INDEX IF NOT EXISTS idx_att_calendar_month ON att_calendar (month);
