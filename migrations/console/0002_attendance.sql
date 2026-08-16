CREATE TABLE IF NOT EXISTS att_staff (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_no TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  department  TEXT,
  job_title   TEXT,
        hired_on    TEXT,
        left_on     TEXT,
      leave_days  REAL,
  user_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  note        TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_att_staff_active ON att_staff (active, name);
CREATE INDEX IF NOT EXISTS idx_att_staff_user   ON att_staff (user_id);
CREATE TABLE IF NOT EXISTS att_devices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  serial        TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  location      TEXT,
  model         TEXT,
          token_hash    TEXT,
        last_seen_at  TEXT,
  last_event_at TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS att_punches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_serial TEXT    NOT NULL,
  employee_no   TEXT    NOT NULL,
  staff_id      INTEGER REFERENCES att_staff (id) ON DELETE SET NULL,
        at_utc        TEXT    NOT NULL,
        at_local      TEXT    NOT NULL,
  day           TEXT    NOT NULL,
        direction     TEXT,
        device_status TEXT,
  major         INTEGER,
  minor         INTEGER,
  door          TEXT,
  verify_mode   TEXT,
        source        TEXT    NOT NULL DEFAULT 'poller',
          dedupe_key    TEXT    NOT NULL,
  raw           TEXT,
  received_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (device_serial, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_att_punches_day   ON att_punches (day, employee_no);
CREATE INDEX IF NOT EXISTS idx_att_punches_staff ON att_punches (staff_id, day);
CREATE INDEX IF NOT EXISTS idx_att_punches_emp   ON att_punches (employee_no, at_utc);
CREATE TABLE IF NOT EXISTS att_shifts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT    NOT NULL UNIQUE,
  starts_at          TEXT    NOT NULL,
  ends_at            TEXT    NOT NULL,
        break_minutes      INTEGER NOT NULL DEFAULT 0,
        grace_in_minutes   INTEGER NOT NULL DEFAULT 5,
  grace_out_minutes  INTEGER NOT NULL DEFAULT 5,
        half_day_minutes   INTEGER NOT NULL DEFAULT 240,
  full_day_minutes   INTEGER NOT NULL DEFAULT 420,
      overtime_after     INTEGER NOT NULL DEFAULT 0,
  colour             TEXT,
  sort_order         INTEGER NOT NULL DEFAULT 100,
  active             INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_att_shifts_order ON att_shifts (sort_order, name);
CREATE TABLE IF NOT EXISTS att_patterns (
  staff_id INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  dow      INTEGER NOT NULL,
  shift_id INTEGER REFERENCES att_shifts (id) ON DELETE SET NULL,
  PRIMARY KEY (staff_id, dow)
);
CREATE TABLE IF NOT EXISTS att_roster (
  staff_id INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  day      TEXT    NOT NULL,
  shift_id INTEGER REFERENCES att_shifts (id) ON DELETE SET NULL,
  note     TEXT,
  set_by   TEXT,
  set_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (staff_id, day)
);
CREATE INDEX IF NOT EXISTS idx_att_roster_day ON att_roster (day);
CREATE TABLE IF NOT EXISTS att_reasons (
  code             TEXT    PRIMARY KEY,
  label            TEXT    NOT NULL,
    kind             TEXT    NOT NULL,
        paid             INTEGER NOT NULL DEFAULT 0,
  counts_as_worked INTEGER NOT NULL DEFAULT 0,
    deducts_leave    INTEGER NOT NULL DEFAULT 0,
                  selectable       INTEGER NOT NULL DEFAULT 1,
  requires_note    INTEGER NOT NULL DEFAULT 0,
    colour           TEXT    NOT NULL DEFAULT 'grey',
  sort_order       INTEGER NOT NULL DEFAULT 100,
        system           INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO att_reasons
  (code, label, kind, paid, counts_as_worked, deducts_leave, selectable, requires_note, colour, sort_order, system) VALUES
  ('present',      'Present',                'worked',     1, 1, 0, 1, 0, 'green',  10,  1),
  ('late',         'Late',                   'worked',     1, 1, 0, 1, 0, 'amber',  20,  1),
  ('early_leave',  'Left early',             'worked',     1, 1, 0, 1, 0, 'amber',  30,  1),
  ('late_early',   'Late and left early',    'worked',     1, 1, 0, 1, 0, 'amber',  40,  1),
    ('incomplete',   'Incomplete — to check',  'incomplete', 0, 0, 0, 0, 0, 'amber',  50,  1),
  ('absent',       'Absent',                 'absent',     0, 0, 0, 1, 0, 'red',    60,  1),
  ('rest_day',     'Rest day',               'rest',       0, 0, 0, 1, 0, 'grey',   70,  1),
  ('public_holiday', 'Public holiday',       'holiday',    1, 0, 0, 1, 0, 'grey',   80,  1),
  ('annual_leave', 'Annual leave',           'leave',      1, 0, 1, 1, 0, 'grey',   90,  0),
  ('sick_leave',   'Sick leave',             'leave',      1, 0, 0, 1, 1, 'grey',  100,  0),
  ('compassionate','Compassionate leave',    'leave',      1, 0, 0, 1, 1, 'grey',  110,  0),
  ('maternity',    'Maternity leave',        'leave',      1, 0, 0, 1, 0, 'grey',  120,  0),
  ('unpaid_leave', 'Unpaid leave',           'leave',      0, 0, 0, 1, 1, 'grey',  130,  0),
  ('excused',      'Absent — excused',       'absent',     0, 0, 0, 1, 1, 'amber', 140,  0),
  ('suspension',   'Suspended',              'absent',     0, 0, 0, 1, 1, 'red',   150,  0),
  ('training',     'Training',               'worked',     1, 1, 0, 1, 0, 'green', 160,  0),
  ('offsite',      'Working off site',       'worked',     1, 1, 0, 1, 1, 'green', 170,  0);
CREATE TABLE IF NOT EXISTS att_days (
  staff_id         INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  day              TEXT    NOT NULL,
  shift_id         INTEGER REFERENCES att_shifts (id) ON DELETE SET NULL,
  scheduled        INTEGER NOT NULL DEFAULT 0,
  expected_minutes INTEGER NOT NULL DEFAULT 0,
    first_in         TEXT,
  last_out         TEXT,
  punches          INTEGER NOT NULL DEFAULT 0,
  worked_minutes   INTEGER NOT NULL DEFAULT 0,
  late_minutes     INTEGER NOT NULL DEFAULT 0,
  early_minutes    INTEGER NOT NULL DEFAULT 0,
  overtime_minutes INTEGER NOT NULL DEFAULT 0,
      status           TEXT    NOT NULL DEFAULT 'absent',
      reason_code      TEXT    REFERENCES att_reasons (code) ON DELETE SET NULL,
      leave_id         INTEGER,
  resolution       TEXT    NOT NULL DEFAULT 'settled',
  resolved_by      TEXT,
  resolved_at      TEXT,
  resolved_note    TEXT,
        corrected_in     TEXT,
  corrected_out    TEXT,
      note             TEXT,
  computed_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (staff_id, day)
);
CREATE INDEX IF NOT EXISTS idx_att_days_day    ON att_days (day, status);
CREATE INDEX IF NOT EXISTS idx_att_days_open   ON att_days (resolution, day);
CREATE INDEX IF NOT EXISTS idx_att_days_reason ON att_days (reason_code, day);
CREATE TABLE IF NOT EXISTS att_leave (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id      INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  reason_code   TEXT    NOT NULL REFERENCES att_reasons (code),
  from_day      TEXT    NOT NULL,
  to_day        TEXT    NOT NULL,
        days          REAL    NOT NULL DEFAULT 0,
  half_day      TEXT,
  status        TEXT    NOT NULL DEFAULT 'pending',
  reason        TEXT,
  requested_by  TEXT,
  requested_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  decided_by    TEXT,
  decided_at    TEXT,
  decision_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_att_leave_staff  ON att_leave (staff_id, from_day);
CREATE INDEX IF NOT EXISTS idx_att_leave_status ON att_leave (status, from_day);
CREATE TABLE IF NOT EXISTS att_holidays (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day         TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  observed_on TEXT,
  paid        INTEGER NOT NULL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_att_holidays_day ON att_holidays (day);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('att_missing_punch',       'incomplete'),
        ('att_leave_days',          '15'),
  ('att_leave_qualify_months','12'),
  ('att_leave_carryover_days','0'),
  ('att_leave_year_starts',   '01-01'),
      ('att_min_gap_minutes',     '2'),
        ('att_window_before',       '180'),
  ('att_window_after',        '240'),
    ('att_escalate_after',      '3'),
  ('att_country_holidays',    'GH');
