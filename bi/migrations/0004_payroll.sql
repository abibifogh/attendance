-- What people were actually paid, as opposed to what they probably cost.
--
-- Until now every wage figure in this warehouse was an estimate: hours worked
-- multiplied by an hourly rate, and — because the connector never sent a rate —
-- that rate was one flat default for a night porter, a chef and a manager
-- alike. Every labour share, every revenue-per-hour, every "this line does not
-- cover the cost of staffing it" rested on it.
--
-- HIVE now runs payroll, so two better numbers exist. This migration makes room
-- for both.

-- ---------------------------------------------------------------- payroll --

-- One closed payslip. The truth, at the grain the truth is kept in.
--
-- Monthly, because that is what a pay run is, and no amount of wishing makes a
-- payslip a daily fact. Everything else in this warehouse is daily and is
-- replaced by window; this is replaced by month, which is why it is not in the
-- `clearWindow` list with the others.
--
-- Only finalised runs land here. A draft is somebody's working, and a report
-- that moves because an accountant is mid-calculation is a report nobody
-- trusts twice.
CREATE TABLE IF NOT EXISTS fact_payroll (
  month        TEXT    NOT NULL,          -- YYYY-MM
  person_id    INTEGER NOT NULL REFERENCES dim_person (id) ON DELETE CASCADE,
  source_id    TEXT    NOT NULL,
  line_id      TEXT    NOT NULL REFERENCES dim_line (id),
  department   TEXT    NOT NULL DEFAULT '',

  -- All pesewas. HIVE keeps these as cedis in REAL columns; the connector
  -- converts once, on the way in, and they are never converted back until a
  -- screen prints them.
  gross        INTEGER NOT NULL DEFAULT 0,
  bonus_gross  INTEGER NOT NULL DEFAULT 0,
  ssf_employee INTEGER NOT NULL DEFAULT 0,
  ssf_employer INTEGER NOT NULL DEFAULT 0,
  paye         INTEGER NOT NULL DEFAULT 0,
  loans        INTEGER NOT NULL DEFAULT 0,
  net          INTEGER NOT NULL DEFAULT 0,

  -- What the employer actually parted with: gross plus the employer's pension
  -- contribution. This is the figure a margin should be struck against, and
  -- it is roughly 13% of basic above gross — an amount every labour ratio in
  -- this warehouse has been silently missing.
  cost         INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (month, person_id)
);
CREATE INDEX IF NOT EXISTS idx_fact_payroll_month ON fact_payroll (month);
CREATE INDEX IF NOT EXISTS idx_fact_payroll_line ON fact_payroll (line_id, month);

-- ------------------------------------------------------- expected minutes --

-- What somebody was down to work.
--
-- HIVE has stored this per person per day since the beginning, the connector
-- has been fetching it since the beginning, and it was dropped on the floor
-- because there was nowhere to put it. `fact_labour.expected_minutes` was then
-- fabricated as "scheduled people × 480" — a hard-coded eight-hour day for a
-- property that runs six-hour breakfast shifts and twelve-hour night cover.
--
-- Rostered-against-worked is not a question that can be asked of a fiction.
ALTER TABLE fact_person_day ADD COLUMN expected_minutes INTEGER NOT NULL DEFAULT 0;

-- ------------------------------------------------------------ where a rate --
-- came from, so a figure can say how much to trust it.
--
-- 'payslip' — a closed pay run covering this person and month.
-- 'rate'    — their own dated rate from HIVE, priced against hours worked.
-- 'default' — nobody's rate; the property-wide fallback. A guess, and labelled.
--
-- Recorded rather than inferred: "the wage bill is 38% of takings" means three
-- different things depending on which of these it was built from, and a reader
-- has no way to tell them apart unless the warehouse remembers.
ALTER TABLE fact_labour ADD COLUMN cost_basis TEXT NOT NULL DEFAULT 'default';
