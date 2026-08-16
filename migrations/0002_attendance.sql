-- Attendance: who was at work, when, and what the gaps mean.
--
-- The terminal on the wall knows one thing — that a face was recognised at
-- 07:03 — and it is very good at knowing it. Everything a manager actually
-- wants is downstream of that: was 07:03 late, is a missing evening punch an
-- absence or a forgotten tap, how many days has this person worked this month,
-- and how much leave is left. None of that lives on the device, so all of it
-- lives here.
--
-- The shape follows from one decision: raw punches are kept forever and never
-- edited, and everything else is derived from them. A punch is a fact the
-- device observed. A day's status is an opinion this system holds about those
-- facts, given the rota, the leave book and the rules in settings — and an
-- opinion has to be recomputable, because rules change and rotas get corrected
-- weeks after the fact. So `att_punches` is the record, `att_days` is a cache
-- that can be thrown away and rebuilt, and no report ever reads the device
-- again.
--
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- People and terminals
-- ---------------------------------------------------------------------------

-- Staff are their own table rather than rows in `users`.
--
-- Almost nobody who clocks in has a login. A kitchen porter has a face on a
-- terminal and no reason to ever open this app, while an administrator has an
-- account and may not clock in at all. Forcing the two into one table would
-- mean every staff list filtering out logins that never clock, every user list
-- filtering out people who cannot sign in, and a PIN column on a room attendant
-- who will never have one. `user_id` links them where the same human is both.
CREATE TABLE IF NOT EXISTS att_staff (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- What the terminal calls them: `employeeNoString` on every ISAPI event.
  -- This is the join between a punch and a person, so it is the one field that
  -- must match the device exactly.
  employee_no TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  department  TEXT,
  job_title   TEXT,
  -- Leave accrues from the day they started, and a mid-year joiner's
  -- entitlement is pro-rated from it. Null means "we never recorded it", which
  -- is treated as having started before the current leave year.
  hired_on    TEXT,
  -- Set when somebody leaves. Their history stays — a report for March must
  -- still show the person who worked in March — but they drop off the rota and
  -- out of today's exception list.
  left_on     TEXT,
  -- Per-person override of the property's annual leave entitlement. Null means
  -- "whatever setup says", which is what it should be for almost everybody.
  leave_days  REAL,
  user_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  note        TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_att_staff_active ON att_staff (active, name);
CREATE INDEX IF NOT EXISTS idx_att_staff_user   ON att_staff (user_id);

-- The terminals themselves, one row each.
--
-- A property with one door has one row and will never look at this table. It
-- exists for the two things that go wrong in practice: a device that stopped
-- sending and nobody noticed for a fortnight, and a second terminal added at
-- the staff entrance whose punches must not be mistaken for the first one's.
CREATE TABLE IF NOT EXISTS att_devices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  serial        TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  location      TEXT,
  model         TEXT,
  -- HMAC of the token the on-site poller presents, salted with the same pepper
  -- as everything else. The token itself is shown once when it is created and
  -- never stored, so a copy of this database does not hand anybody the ability
  -- to post fabricated punches.
  token_hash    TEXT,
  -- Last time the poller said anything at all, and last time it brought a punch
  -- with it. The pair is the difference between "the terminal is quiet because
  -- it is Sunday" and "the terminal has been unplugged since Tuesday".
  last_seen_at  TEXT,
  last_event_at TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- The record: raw punches
-- ---------------------------------------------------------------------------

-- One row per authentication the terminal accepted. Append-only.
--
-- Nothing in this table is ever corrected. When a supervisor fixes a forgotten
-- clock-out they are not editing what the device saw — the device saw nothing,
-- that is the whole problem — they are recording a decision, and decisions live
-- on `att_days` with their author attached.
--
-- `staff_id` is resolved at write time but left null when the employee number
-- is unknown here. That happens on the first day of anybody new, and losing
-- their punches until somebody adds them to the roster would be the worst
-- possible behaviour: the punches are kept, and claimed retroactively when the
-- person is created.
CREATE TABLE IF NOT EXISTS att_punches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_serial TEXT    NOT NULL,
  employee_no   TEXT    NOT NULL,
  staff_id      INTEGER REFERENCES att_staff (id) ON DELETE SET NULL,
  -- UTC, always, as 'YYYY-MM-DD HH:MM:SS'. The device reports its own offset
  -- and the property's timezone can be changed in setup, so storing local time
  -- would quietly rewrite history the day somebody corrects either.
  at_utc        TEXT    NOT NULL,
  -- Local time and local day, resolved once on the way in so that every report
  -- is a plain indexed lookup rather than a timezone conversion per row. Both
  -- are derived from `at_utc` and can be rebuilt from it.
  at_local      TEXT    NOT NULL,
  day           TEXT    NOT NULL,
  -- 'in', 'out' or null. Taken from the device's own attendance status when it
  -- has one configured, and otherwise inferred from where the punch falls in
  -- the shift. Null survives to the day computation, which pairs by time.
  direction     TEXT,
  -- Exactly what the device called it, kept even when it is 'undefined'. When a
  -- terminal's attendance mode is fixed later, this is what says which historic
  -- punches were guesses.
  device_status TEXT,
  major         INTEGER,
  minor         INTEGER,
  door          TEXT,
  verify_mode   TEXT,
  -- 'poller' for the on-site ISAPI reader, 'push' for the device's own HTTP
  -- listener, 'cloud' for a Hik-Connect adapter, 'import' for a file, 'manual'
  -- for a punch typed in by a supervisor.
  source        TEXT    NOT NULL DEFAULT 'poller',
  -- What makes an ingest idempotent. The device's own event serial when it
  -- sends one, and otherwise a hash of the fields that identify the event. A
  -- poller that overlaps its window — which it must, or a punch at the boundary
  -- is lost — depends on this being right.
  dedupe_key    TEXT    NOT NULL,
  raw           TEXT,
  received_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (device_serial, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_att_punches_day   ON att_punches (day, employee_no);
CREATE INDEX IF NOT EXISTS idx_att_punches_staff ON att_punches (staff_id, day);
CREATE INDEX IF NOT EXISTS idx_att_punches_emp   ON att_punches (employee_no, at_utc);

-- ---------------------------------------------------------------------------
-- What was expected: shifts and the rota
-- ---------------------------------------------------------------------------

-- A named working window. "Late" has no meaning without one.
--
-- Times are 'HH:MM' local. A shift whose end is at or before its start crosses
-- midnight — 22:00 to 06:00 — and belongs to the day it *starts*, which is how
-- everybody talks about a night shift and the only convention under which "how
-- many nights did he work" gives the answer a human expects.
CREATE TABLE IF NOT EXISTS att_shifts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT    NOT NULL UNIQUE,
  starts_at          TEXT    NOT NULL,
  ends_at            TEXT    NOT NULL,
  -- Unpaid break, subtracted from hours worked. Not policed against punches:
  -- staff do not clock out for lunch here, and pretending otherwise would
  -- invent data.
  break_minutes      INTEGER NOT NULL DEFAULT 0,
  -- Minutes of slack before a late arrival counts as late, and before an early
  -- departure counts as early. Set per shift because a night shift handover has
  -- different tolerances from a breakfast service.
  grace_in_minutes   INTEGER NOT NULL DEFAULT 5,
  grace_out_minutes  INTEGER NOT NULL DEFAULT 5,
  -- Hours below which a day is only half worked, and at or above which it is a
  -- full day. Used for the days-worked count, which is the number that ends up
  -- in front of an accountant.
  half_day_minutes   INTEGER NOT NULL DEFAULT 240,
  full_day_minutes   INTEGER NOT NULL DEFAULT 420,
  -- Minutes past the shift end, beyond grace, before overtime starts counting.
  -- Zero means every minute counts.
  overtime_after     INTEGER NOT NULL DEFAULT 0,
  colour             TEXT,
  sort_order         INTEGER NOT NULL DEFAULT 100,
  active             INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_att_shifts_order ON att_shifts (sort_order, name);

-- The standing pattern: what this person normally works on a given weekday.
--
-- Monday is 0. A row with a null shift is a rest day, which is different from
-- having no row at all — no row means "the pattern says nothing", and a person
-- with no pattern rows is not scheduled and never shows up as absent.
CREATE TABLE IF NOT EXISTS att_patterns (
  staff_id INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  dow      INTEGER NOT NULL,
  shift_id INTEGER REFERENCES att_shifts (id) ON DELETE SET NULL,
  PRIMARY KEY (staff_id, dow)
);

-- The rota proper: what this person is working on one specific day.
--
-- Overrides the pattern, and is what a swap, a cover or a one-off double
-- writes. Null shift is an explicitly rostered day off, which is why the column
-- is nullable and the row still exists — "I gave him Thursday off" and "I never
-- said" produce the same absence otherwise.
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

-- ---------------------------------------------------------------------------
-- What a day means
-- ---------------------------------------------------------------------------

-- The vocabulary of non-ordinary days, and what each one costs.
--
-- This is the table that answers "update what each absent should mean". A
-- property decides for itself whether sick leave is paid, whether it comes out
-- of the annual allowance, and whether a day at a training course counts
-- towards days worked. Hard-coding those answers would be hard-coding one
-- country's labour law and one manager's temperament.
--
-- `kind` is the part the code reasons about and cannot be invented freely;
-- everything else is the property's business.
CREATE TABLE IF NOT EXISTS att_reasons (
  code             TEXT    PRIMARY KEY,
  label            TEXT    NOT NULL,
  -- One of: 'worked', 'leave', 'absent', 'holiday', 'rest', 'incomplete'.
  kind             TEXT    NOT NULL,
  -- Does the day earn pay, and does it count as a day worked? Not the same
  -- question: paid annual leave is paid but is not a day worked, and an unpaid
  -- day at a family funeral is neither.
  paid             INTEGER NOT NULL DEFAULT 0,
  counts_as_worked INTEGER NOT NULL DEFAULT 0,
  -- Does taking it reduce the annual leave balance?
  deducts_leave    INTEGER NOT NULL DEFAULT 0,
  -- Can a supervisor apply it to a day after the fact?
  --
  -- Almost everything can, including 'present' and 'late' — confirming that
  -- somebody who forgot to clock out did in fact work their shift is the single
  -- commonest correction anybody makes here. The exception is 'incomplete',
  -- which is not a verdict but the absence of one: it is what a day is charged
  -- to while it waits for a human, and choosing it by hand would mean deciding
  -- not to decide.
  selectable       INTEGER NOT NULL DEFAULT 1,
  requires_note    INTEGER NOT NULL DEFAULT 0,
  -- 'green', 'amber', 'red' or 'grey' — the four the reports actually use.
  colour           TEXT    NOT NULL DEFAULT 'grey',
  sort_order       INTEGER NOT NULL DEFAULT 100,
  -- A built-in the code refers to by name. Its label, colours and rules can all
  -- be changed; it cannot be deleted, because something in the status machine
  -- would then have nothing to point at.
  system           INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1
);

-- The seeded vocabulary. Everything here can be relabelled and re-costed in
-- setup; the eight marked `system` cannot be deleted.
INSERT OR IGNORE INTO att_reasons
  (code, label, kind, paid, counts_as_worked, deducts_leave, selectable, requires_note, colour, sort_order, system) VALUES
  ('present',      'Present',                'worked',     1, 1, 0, 1, 0, 'green',  10,  1),
  ('late',         'Late',                   'worked',     1, 1, 0, 1, 0, 'amber',  20,  1),
  ('early_leave',  'Left early',             'worked',     1, 1, 0, 1, 0, 'amber',  30,  1),
  ('late_early',   'Late and left early',    'worked',     1, 1, 0, 1, 0, 'amber',  40,  1),
  -- Not selectable: this is the waiting state, not a verdict.
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

-- One row per person per day, derived and rewritable.
--
-- Every column above `status` is arithmetic on the punches and the rota. From
-- `status` down is the part a human can touch, and it is kept in the same row
-- deliberately: a correction that lived somewhere else would be a correction
-- the reports could forget to apply.
--
-- `resolution` is the state of the supervisor's decision, not of the day.
-- 'open' is what an incomplete day starts as and what the exception list is
-- built from; the day is only settled when somebody has said what happened.
CREATE TABLE IF NOT EXISTS att_days (
  staff_id         INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  day              TEXT    NOT NULL,
  shift_id         INTEGER REFERENCES att_shifts (id) ON DELETE SET NULL,
  scheduled        INTEGER NOT NULL DEFAULT 0,
  expected_minutes INTEGER NOT NULL DEFAULT 0,

  -- Local 'HH:MM' of the first and last punch attributed to this day's shift.
  first_in         TEXT,
  last_out         TEXT,
  punches          INTEGER NOT NULL DEFAULT 0,

  worked_minutes   INTEGER NOT NULL DEFAULT 0,
  late_minutes     INTEGER NOT NULL DEFAULT 0,
  early_minutes    INTEGER NOT NULL DEFAULT 0,
  overtime_minutes INTEGER NOT NULL DEFAULT 0,

  -- The computed verdict: 'present', 'late', 'early_leave', 'late_early',
  -- 'missing_out', 'missing_in', 'absent', 'leave', 'holiday', 'rest'.
  status           TEXT    NOT NULL DEFAULT 'absent',
  -- Which row of `att_reasons` the day is charged to. This is what the counts
  -- of days worked, days absent and leave taken are all built from.
  reason_code      TEXT    REFERENCES att_reasons (code) ON DELETE SET NULL,
  -- Set when the day came from an approved leave request, so cancelling the
  -- request can find the days it created.
  leave_id         INTEGER,

  resolution       TEXT    NOT NULL DEFAULT 'settled',
  resolved_by      TEXT,
  resolved_at      TEXT,
  resolved_note    TEXT,
  -- Times a supervisor supplied for a punch the device never saw. Kept apart
  -- from `first_in`/`last_out` so a report can always show what was observed
  -- next to what was decided.
  corrected_in     TEXT,
  corrected_out    TEXT,

  -- The plain-language line the staff report prints. Generated, stored so that
  -- a report reprinted in November says what it said in June.
  note             TEXT,
  computed_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (staff_id, day)
);

CREATE INDEX IF NOT EXISTS idx_att_days_day    ON att_days (day, status);
CREATE INDEX IF NOT EXISTS idx_att_days_open   ON att_days (resolution, day);
CREATE INDEX IF NOT EXISTS idx_att_days_reason ON att_days (reason_code, day);

-- ---------------------------------------------------------------------------
-- Leave and holidays
-- ---------------------------------------------------------------------------

-- A leave request, from asking to approved and taken.
--
-- Stored as a range rather than a row per day, because that is how it is asked
-- for and how it is cancelled. The days it covers are written onto `att_days`
-- when it is approved, and rubbed off again if it is cancelled — which is what
-- `leave_id` over there is for.
CREATE TABLE IF NOT EXISTS att_leave (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id      INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  reason_code   TEXT    NOT NULL REFERENCES att_reasons (code),
  from_day      TEXT    NOT NULL,
  to_day        TEXT    NOT NULL,
  -- Working days actually consumed, worked out when the request is made and
  -- then frozen. Recomputing it later would silently change a balance because
  -- somebody edited a rota six months on.
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

-- Public holidays, as concrete dates.
--
-- Held per date rather than as rules because half of Ghana's are moveable —
-- Easter follows its own arithmetic, the two Eids are announced locally, and
-- Farmers' Day is the first Friday in December. The app can generate a year's
-- fixed and calculable dates in one go; the Eids get typed in when they are
-- announced.
--
-- `observed_on` carries the Monday when a holiday falls at the weekend, which
-- is the day people actually take off.
CREATE TABLE IF NOT EXISTS att_holidays (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day         TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  observed_on TEXT,
  paid        INTEGER NOT NULL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_att_holidays_day ON att_holidays (day);

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

-- Defaults chosen for a Ghanaian hotel, and every one of them editable.
--
-- `att_missing_punch` is the important one. The terminal's own reports treat a
-- missing clock-out as an absence, which is defensible for a device with no
-- other options and wrong for a system that can ask a supervisor. 'incomplete'
-- leaves the day unsettled and puts it on somebody's list; 'absent' reproduces
-- the terminal's behaviour; 'auto_close' credits the scheduled end time and
-- flags it.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('att_missing_punch',       'incomplete'),
  -- Annual leave. The Labour Act 2003 (Act 651) sets a floor of fifteen working
  -- days after twelve months' continuous service; a property may be more
  -- generous and some are.
  ('att_leave_days',          '15'),
  ('att_leave_qualify_months','12'),
  ('att_leave_carryover_days','0'),
  ('att_leave_year_starts',   '01-01'),
  -- Two punches closer together than this are one person tapping twice, not a
  -- clock-out and a clock-in.
  ('att_min_gap_minutes',     '2'),
  -- How far either side of a shift a punch may fall and still belong to it.
  -- Wide enough for somebody who arrives an hour early, narrow enough that a
  -- night shift's punches do not get claimed by the morning.
  ('att_window_before',       '180'),
  ('att_window_after',        '240'),
  -- Consecutive absences before the day's note changes tone and the bell rings.
  ('att_escalate_after',      '3'),
  ('att_country_holidays',    'GH');
