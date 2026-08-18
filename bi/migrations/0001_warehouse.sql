-- The warehouse.
--
-- Four systems record four different things and none of them can see the
-- others. This schema is the place where they are made comparable: one grain
-- (a day), one currency (pesewas, as whole numbers), one set of names for the
-- parts of the business, and one identity for a person who appears in three
-- systems under three spellings.
--
-- Nothing in here is a source of truth. Every row is derived, every row can be
-- rebuilt from the sources, and `etl_run` records where each rebuild got to so
-- a failed pull never leaves half a day loaded.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('group_name',      'Nice Operation'),
  ('timezone',        'Africa/Accra'),
  ('currency_code',   'GHS'),
  ('currency_symbol', 'GH₵'),
  -- What an hour of staff time costs the group, in pesewas, when a person's
  -- own rate is not known. Labour is the largest controllable cost in the
  -- group and leaving it out entirely would make every margin flattering, so
  -- an admitted estimate is used and every figure built on it is marked.
  ('default_hour_cost', '1200'),
  -- The share of revenue a line is expected to spend on labour. Used only to
  -- decide when to speak up, never to compute anything.
  ('labour_target_pct', '30'),
  ('demo_mode',       '1');

-- ---------------------------------------------------------------- sources --

-- One row per system we pull from. `kind` picks the connector; `config` is the
-- JSON that connector needs (a base URL, which binding to read). Keys are not
-- kept here — they are Worker secrets — so this table is safe to export.
CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  label         TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  config        TEXT    NOT NULL DEFAULT '{}',
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_ok_at    TEXT,
  last_error    TEXT,
  last_error_at TEXT
);
INSERT OR IGNORE INTO sources (id, label, kind, config) VALUES
  ('attendance', 'Staff attendance',     'attendance_d1', '{"binding":"ATT_DB"}'),
  ('breakfast',  'Breakfast & rooms',    'breakfast_d1',  '{"binding":"BREAKFAST_DB"}'),
  ('pos',        'Restaurant POS',       'snpos_http',    '{"base":""}'),
  ('laundry',    'Laundry',              'snlaundry_http','{"base":""}');

-- One row per ETL attempt. Kept because "the number looks wrong" is almost
-- always "that day was never loaded", and this is the only place that answers
-- it without guessing.
CREATE TABLE IF NOT EXISTS etl_run (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  from_day    TEXT    NOT NULL,
  to_day      TEXT    NOT NULL,
  trigger     TEXT    NOT NULL DEFAULT 'manual',
  status      TEXT    NOT NULL DEFAULT 'running',
  rows_written INTEGER NOT NULL DEFAULT 0,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_etl_run_at ON etl_run (id DESC);

-- Per source, per run: did it answer, how much did it give, what went wrong.
-- A source that is down must not look like a business that stopped trading,
-- and this table is what lets the dashboard tell the difference.
CREATE TABLE IF NOT EXISTS etl_source_run (
  run_id    INTEGER NOT NULL REFERENCES etl_run (id) ON DELETE CASCADE,
  source_id TEXT    NOT NULL,
  status    TEXT    NOT NULL,
  rows      INTEGER NOT NULL DEFAULT 0,
  detail    TEXT,
  PRIMARY KEY (run_id, source_id)
);

-- ------------------------------------------------------------- dimensions --

-- The calendar. Written by the ETL for every day it touches, so a report can
-- join to it and get weekday grouping and month boundaries without parsing
-- dates in SQL.
CREATE TABLE IF NOT EXISTS dim_day (
  day        TEXT PRIMARY KEY,
  dow        INTEGER NOT NULL,      -- 1 = Monday .. 7 = Sunday
  dow_label  TEXT    NOT NULL,
  iso_week   TEXT    NOT NULL,      -- 'YYYY-Www'
  month      TEXT    NOT NULL,      -- 'YYYY-MM'
  is_weekend INTEGER NOT NULL DEFAULT 0,
  is_holiday INTEGER NOT NULL DEFAULT 0,
  holiday    TEXT
);

-- The parts of the business. Seeded rather than discovered, because the whole
-- point is that 'restaurant' means the same thing whichever system said it.
-- `revenue_line` marks the ones that are expected to earn; the others are
-- costs that serve them, and a margin calculated without that distinction is
-- nonsense.
CREATE TABLE IF NOT EXISTS dim_line (
  id           TEXT PRIMARY KEY,
  label        TEXT    NOT NULL,
  revenue_line INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 100
);
INSERT OR IGNORE INTO dim_line (id, label, revenue_line, sort_order) VALUES
  ('rooms',        'Rooms',        1, 10),
  ('restaurant',   'Restaurant',   1, 20),
  ('bar',          'Bar',          1, 30),
  ('breakfast',    'Breakfast',    1, 40),
  ('laundry',      'Laundry',      1, 50),
  ('housekeeping', 'Housekeeping', 0, 60),
  ('maintenance',  'Maintenance',  0, 70),
  ('admin',        'Admin',        0, 80);

-- A person, once, however many systems know them.
--
-- Attendance is the master: it is the only system with an employee number and
-- a department, and it is the only one that knows whether somebody was
-- physically on the premises. The other systems contribute an alias and
-- whatever they saw that person do.
CREATE TABLE IF NOT EXISTS dim_person (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  match_key    TEXT    NOT NULL UNIQUE,
  display_name TEXT    NOT NULL,
  employee_no  TEXT,
  department   TEXT,
  job_title    TEXT,
  line_id      TEXT REFERENCES dim_line (id),
  hour_cost    INTEGER,
  active       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_dim_person_dept ON dim_person (department);

-- How each system spells them. `confidence` is 'exact' when an employee number
-- or an id matched, 'name' when only a normalised name did. A finding that
-- names somebody is only ever shown with the confidence of the link that put
-- their name on it.
CREATE TABLE IF NOT EXISTS person_link (
  source_id   TEXT    NOT NULL,
  external_id TEXT    NOT NULL,
  person_id   INTEGER NOT NULL REFERENCES dim_person (id) ON DELETE CASCADE,
  raw_name    TEXT,
  confidence  TEXT    NOT NULL DEFAULT 'name',
  PRIMARY KEY (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_person_link_person ON person_link (person_id);

-- A supplier, once. Three systems buy things and each keeps its own list, so
-- the group has never seen what it spends with anybody in total.
CREATE TABLE IF NOT EXISTS dim_supplier (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  match_key TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS supplier_link (
  source_id   TEXT    NOT NULL,
  external_id TEXT    NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES dim_supplier (id) ON DELETE CASCADE,
  raw_name    TEXT,
  PRIMARY KEY (source_id, external_id)
);

-- A thing that is bought, once. Same problem as suppliers: 'Tomatoes 5kg' in
-- the breakfast store and 'tomato' in the restaurant's ingredients are the
-- same purchase decision and have never been compared.
CREATE TABLE IF NOT EXISTS dim_item (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  match_key TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  unit      TEXT
);
CREATE TABLE IF NOT EXISTS item_link (
  source_id   TEXT    NOT NULL,
  external_id TEXT    NOT NULL,
  item_id     INTEGER NOT NULL REFERENCES dim_item (id) ON DELETE CASCADE,
  raw_name    TEXT,
  PRIMARY KEY (source_id, external_id)
);

-- ------------------------------------------------------------------ facts --
--
-- Every fact is a day, and every money column is a whole number of pesewas.
-- The primary keys are what makes a reload safe: the ETL replaces a day rather
-- than adding to it, so running it twice cannot double the takings.

-- What was earned, by line, by day.
CREATE TABLE IF NOT EXISTS fact_revenue (
  day          TEXT    NOT NULL,
  line_id      TEXT    NOT NULL REFERENCES dim_line (id),
  source_id    TEXT    NOT NULL,
  gross        INTEGER NOT NULL DEFAULT 0,   -- before discounts
  discounts    INTEGER NOT NULL DEFAULT 0,
  net          INTEGER NOT NULL DEFAULT 0,   -- what was charged
  collected    INTEGER NOT NULL DEFAULT 0,   -- what actually arrived
  outstanding  INTEGER NOT NULL DEFAULT 0,   -- charged and not yet collected
  cash         INTEGER NOT NULL DEFAULT 0,
  card         INTEGER NOT NULL DEFAULT 0,
  other_tender INTEGER NOT NULL DEFAULT 0,   -- mobile money and the rest
  orders       INTEGER NOT NULL DEFAULT 0,
  covers       INTEGER NOT NULL DEFAULT 0,   -- people served, where known
  units        REAL    NOT NULL DEFAULT 0,   -- loads, plates, whatever the line counts
  PRIMARY KEY (day, line_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_fact_revenue_day ON fact_revenue (day);

-- Who was actually there, and for how long. Straight out of attendance, which
-- is the only system that knows.
CREATE TABLE IF NOT EXISTS fact_labour (
  day              TEXT    NOT NULL,
  line_id          TEXT    NOT NULL REFERENCES dim_line (id),
  department       TEXT    NOT NULL DEFAULT '',
  scheduled_count  INTEGER NOT NULL DEFAULT 0,
  present_count    INTEGER NOT NULL DEFAULT 0,
  absent_count     INTEGER NOT NULL DEFAULT 0,
  leave_count      INTEGER NOT NULL DEFAULT 0,
  late_count       INTEGER NOT NULL DEFAULT 0,
  expected_minutes INTEGER NOT NULL DEFAULT 0,
  worked_minutes   INTEGER NOT NULL DEFAULT 0,
  late_minutes     INTEGER NOT NULL DEFAULT 0,
  overtime_minutes INTEGER NOT NULL DEFAULT 0,
  -- worked_minutes priced at each person's rate, or the group default.
  labour_cost      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, line_id, department)
);
CREATE INDEX IF NOT EXISTS idx_fact_labour_day ON fact_labour (day);

-- What was spent, by line, by day. Purchases from three systems land here.
CREATE TABLE IF NOT EXISTS fact_cost (
  day         TEXT    NOT NULL,
  line_id     TEXT    NOT NULL REFERENCES dim_line (id),
  source_id   TEXT    NOT NULL,
  category    TEXT    NOT NULL DEFAULT 'purchases',
  -- 0 means "not attributed to a supplier". A nullable column cannot be used
  -- here: SQLite lets NULLs repeat inside a primary key, which would quietly
  -- let the same day's costs be inserted twice.
  supplier_id INTEGER NOT NULL DEFAULT 0,
  amount      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, line_id, source_id, category, supplier_id)
);
CREATE INDEX IF NOT EXISTS idx_fact_cost_day ON fact_cost (day);

-- One purchase line, kept at its own grain because the price paid per unit is
-- the only way to compare two systems buying the same thing.
CREATE TABLE IF NOT EXISTS fact_purchase_line (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day         TEXT    NOT NULL,
  source_id   TEXT    NOT NULL,
  external_id TEXT    NOT NULL,
  line_id     TEXT    NOT NULL REFERENCES dim_line (id),
  item_id     INTEGER REFERENCES dim_item (id) ON DELETE SET NULL,
  supplier_id INTEGER REFERENCES dim_supplier (id) ON DELETE SET NULL,
  qty         REAL    NOT NULL DEFAULT 0,
  unit        TEXT,
  unit_cost   INTEGER NOT NULL DEFAULT 0,
  amount      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_purchase_line_item ON fact_purchase_line (item_id, day);

-- How much business there was to serve. This is the denominator for nearly
-- every question worth asking, and until now it lived in the breakfast app
-- where nobody thought to look for it.
CREATE TABLE IF NOT EXISTS fact_demand (
  day             TEXT PRIMARY KEY,
  inhouse_guests  INTEGER NOT NULL DEFAULT 0,
  outside_guests  INTEGER NOT NULL DEFAULT 0,
  rooms_cleaned   INTEGER NOT NULL DEFAULT 0,
  rooms_tracked   INTEGER NOT NULL DEFAULT 0,
  covers          INTEGER NOT NULL DEFAULT 0,
  laundry_orders  INTEGER NOT NULL DEFAULT 0,
  laundry_loads   REAL    NOT NULL DEFAULT 0
);

-- Did the work that was supposed to happen, happen. Housekeeping rounds and
-- maintenance issues, in the same shape so one screen can show both.
CREATE TABLE IF NOT EXISTS fact_service (
  day           TEXT    NOT NULL,
  line_id       TEXT    NOT NULL REFERENCES dim_line (id),
  checks_due    INTEGER NOT NULL DEFAULT 0,
  checks_done   INTEGER NOT NULL DEFAULT 0,
  faults_found  INTEGER NOT NULL DEFAULT 0,
  issues_opened INTEGER NOT NULL DEFAULT 0,
  issues_closed INTEGER NOT NULL DEFAULT 0,
  issues_open   INTEGER NOT NULL DEFAULT 0,
  oldest_open_days INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, line_id)
);

-- Every till close, and what it was out by. The person is resolved through
-- dim_person, which is what allows a variance to be set beside an attendance
-- record.
CREATE TABLE IF NOT EXISTS fact_cash_control (
  day        TEXT    NOT NULL,
  source_id  TEXT    NOT NULL,
  external_id TEXT   NOT NULL,
  line_id    TEXT    NOT NULL REFERENCES dim_line (id),
  shift      TEXT    NOT NULL DEFAULT '',
  person_id  INTEGER REFERENCES dim_person (id) ON DELETE SET NULL,
  expected   INTEGER NOT NULL DEFAULT 0,
  counted    INTEGER NOT NULL DEFAULT 0,
  variance   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_cash_day    ON fact_cash_control (day);
CREATE INDEX IF NOT EXISTS idx_cash_person ON fact_cash_control (person_id, day);

-- One person, one day, from attendance. Kept alongside the aggregate because
-- the interesting questions are about individuals: who was on site when the
-- till was short, whose overtime never coincides with a busy day.
CREATE TABLE IF NOT EXISTS fact_person_day (
  day              TEXT    NOT NULL,
  person_id        INTEGER NOT NULL REFERENCES dim_person (id) ON DELETE CASCADE,
  line_id          TEXT REFERENCES dim_line (id),
  status           TEXT    NOT NULL DEFAULT '',
  reason_code      TEXT,
  scheduled        INTEGER NOT NULL DEFAULT 0,
  worked_minutes   INTEGER NOT NULL DEFAULT 0,
  late_minutes     INTEGER NOT NULL DEFAULT 0,
  overtime_minutes INTEGER NOT NULL DEFAULT 0,
  first_in         TEXT,
  last_out         TEXT,
  PRIMARY KEY (day, person_id)
);
CREATE INDEX IF NOT EXISTS idx_person_day_person ON fact_person_day (person_id, day);

-- The stock the breakfast unit says it used, per guest. Anomalies here are the
-- earliest sign of waste or of something walking out of the door.
CREATE TABLE IF NOT EXISTS fact_usage (
  day     TEXT    NOT NULL,
  item_id INTEGER NOT NULL REFERENCES dim_item (id) ON DELETE CASCADE,
  line_id TEXT    NOT NULL REFERENCES dim_line (id),
  qty     REAL    NOT NULL DEFAULT 0,
  value   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, item_id, line_id)
);

-- ----------------------------------------------------------------- output --

-- What the tool concluded. A finding is a sentence a person can act on, the
-- money it is worth, and enough evidence to check it.
--
-- `fingerprint` is what stops the same conclusion arriving every morning as if
-- it were new: a repeat updates the row it already has, keeps `first_seen_at`
-- and moves `last_seen_at`.
CREATE TABLE IF NOT EXISTS findings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint   TEXT    NOT NULL UNIQUE,
  rule_id       TEXT    NOT NULL,
  severity      TEXT    NOT NULL DEFAULT 'info',   -- critical | warning | info | good
  headline      TEXT    NOT NULL,
  detail        TEXT    NOT NULL,
  action        TEXT,
  line_id       TEXT,
  person_id     INTEGER REFERENCES dim_person (id) ON DELETE SET NULL,
  -- Pesewas per month, positive whether it is money lost or money available.
  -- An estimate, always; `confidence` says how much of one.
  impact_monthly INTEGER NOT NULL DEFAULT 0,
  confidence    TEXT    NOT NULL DEFAULT 'medium',
  sources       TEXT    NOT NULL DEFAULT '[]',     -- which systems it drew on
  evidence      TEXT    NOT NULL DEFAULT '{}',
  from_day      TEXT,
  to_day        TEXT,
  first_seen_at TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  -- A person can put a finding down: 'open', 'acknowledged', 'actioned',
  -- 'dismissed'. Dismissed ones stay dismissed when the rule fires again.
  state         TEXT    NOT NULL DEFAULT 'open',
  state_by      TEXT,
  state_at      TEXT,
  state_note    TEXT
);
CREATE INDEX IF NOT EXISTS idx_findings_state ON findings (state, severity, impact_monthly DESC);
CREATE INDEX IF NOT EXISTS idx_findings_rule  ON findings (rule_id);
