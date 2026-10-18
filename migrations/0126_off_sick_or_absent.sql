-- Off sick, absent, or here?
--
-- Somebody is on the rota, the shift started half an hour ago, and the terminal
-- has seen nothing. Until now that day sat as a gap until somebody settled it
-- days later from memory. Now HIVE asks whoever runs the floor one question,
-- and keeps asking until a planner, a supervisor or an administrator answers.
--
-- One row per person per day. The first answer wins; anybody else who opens the
-- question afterwards is told who answered and what.
CREATE TABLE IF NOT EXISTS att_absence_q (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id       INTEGER NOT NULL REFERENCES att_staff (id),
  day            TEXT    NOT NULL,
  shift_name     TEXT,
  starts_at      TEXT,
  ends_at        TEXT,
  -- Off sick the day before, so the question is "still off sick?".
  follow_up      INTEGER NOT NULL DEFAULT 0,
  -- A sick leave the person asked for themselves before the shift, if any.
  said_leave_id  INTEGER,
  asked_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  last_asked_at  TEXT,
  times_asked    INTEGER NOT NULL DEFAULT 0,
  -- sick | absent | here | came_in | settled
  answer         TEXT,
  answered_by    TEXT,
  answered_by_id INTEGER,
  answered_at    TEXT,
  detail         TEXT,
  leave_id       INTEGER,
  UNIQUE (staff_id, day)
);

CREATE INDEX IF NOT EXISTS idx_att_absence_q_open ON att_absence_q (answer, day);

-- The medical certificate two or more days off sick needs.
--
-- One per sick leave. Owed from the moment the leave reaches two days, sent
-- when the person photographs it, and the picture is filed on their record.
CREATE TABLE IF NOT EXISTS att_sick_note (
  leave_id    INTEGER PRIMARY KEY REFERENCES att_leave (id),
  staff_id    INTEGER NOT NULL REFERENCES att_staff (id),
  due_on      TEXT    NOT NULL,
  -- owed | sent | waived
  status      TEXT    NOT NULL DEFAULT 'owed',
  document_id INTEGER,
  sent_at     TEXT,
  reminded_on TEXT,
  decided_by  TEXT,
  decided_at  TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_att_sick_note_staff ON att_sick_note (staff_id, status);
