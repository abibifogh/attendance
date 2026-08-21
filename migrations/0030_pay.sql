-- What each person costs, so a rota can be read in money as well as in hours.
--
-- A DATED RECORD, NOT A COLUMN ON THE PERSON
--
-- The obvious thing is a `rate` column on att_staff. It is also wrong, and
-- wrong in the way that is hardest to notice: the day somebody gets a rise,
-- every figure the app has ever produced about them silently changes. Last
-- March's labour cost is recomputed at this March's wage, the month-end report nobody
-- reprinted still says the old number, and the two disagree with no way to
-- tell which was right.
--
-- So a rate has a date it starts from, and the old one stays. The cost of a
-- day is worked out at the rate in force on that day, which is both what an
-- accountant means by cost and what a labour officer would ask to see.
--
-- THREE WAYS TO BE PAID, BECAUSE A HOTEL HAS THREE
--
-- Monthly for salaried staff, daily for casuals engaged under ss.74–77, and
-- hourly where hours are what is actually bought. Each is stored as what it
-- is rather than converted on the way in: converting a monthly salary to an
-- hourly rate and back loses the thing that matters about it, which is that
-- it does not change when somebody works a sixth day.
--
-- WHO CAN SEE IT
--
-- Its own permission, held by nobody by default except an administrator.
-- Managers hold hr_view and hr_manage as a matter of course — they need
-- contact details and contracts — and what a colleague earns is a different
-- order of confidence from where they live. Grant it to whoever does the
-- wages, and to nobody else.

CREATE TABLE IF NOT EXISTS hr_pay (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id   INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,

  -- monthly | daily | hourly
  basis      TEXT    NOT NULL,
  amount     REAL    NOT NULL,
  currency   TEXT    NOT NULL DEFAULT 'GHS',

  -- The day this rate starts applying. Everything before it is costed at
  -- whatever the previous row said, and there is always a previous row or
  -- nothing at all.
  from_day   TEXT    NOT NULL,

  note       TEXT,
  set_by     TEXT,
  set_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One rate per person per start date. Correcting a mistake replaces that row
-- rather than laying a second one on top of it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_pay_when ON hr_pay (staff_id, from_day);
CREATE INDEX IF NOT EXISTS idx_hr_pay_staff ON hr_pay (staff_id, from_day DESC);

INSERT OR IGNORE INTO settings (key, value) VALUES
  -- Ghana cedi. One currency for the property: a hotel paying two would be a
  -- different problem than this table is trying to solve.
  ('currency', 'GHS'),

  -- Overtime. The Labour Act (s.35) requires an undertaking to have fixed
  -- rates for overtime; it does not fix them for it. These are the customary
  -- Ghanaian rates and they are this property's to change — which is why they
  -- are settings and not constants, and why the app calls them the property's
  -- rates rather than the law's.
  ('pay_overtime_multiplier', '1.5'),
  ('pay_holiday_multiplier',  '2.0');
