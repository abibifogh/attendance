-- A rota cell stops being one row per person per day.
--
-- TWO THINGS THE OLD SHAPE MADE IMPOSSIBLE, and both of them happen in a hotel
-- every week.
--
-- Somebody covering two shifts on one day. The primary key was (staff_id, day),
-- so putting a person on the evening quietly deleted the breakfast they were
-- already down for. Nothing said so. The planner found out when somebody did
-- not turn up, and the record of what had been promised was gone. A double is
-- usually a mistake and occasionally deliberate; either way the app's job is to
-- keep both and say something is wrong, not to pick one and stay quiet.
--
-- A shift nobody is on yet. A slot existed only because a person was standing
-- in it, so taking the person out took the slot with them, and "the breakfast
-- on Thursday still needs covering" had nowhere to live. Now staff_id may be
-- null: the row is the requirement, and who fills it is a separate question.
--
-- So the row gets an id of its own. Every existing row carries over untouched.
CREATE TABLE att_roster_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Null is an unfilled slot: this shift is wanted on this day and nobody is
  -- on it yet. It stays until somebody fills it or deletes it.
  staff_id       INTEGER REFERENCES att_staff (id) ON DELETE CASCADE,
  day            TEXT    NOT NULL,

  -- Null is a rostered day off, which is a decision and not an absence of one.
  -- Deleting the shift takes the row with it, which is the only way an empty
  -- slot ever goes without somebody saying so; the Setup screen refuses to
  -- delete a shift anybody is actually rostered on.
  shift_id       INTEGER REFERENCES att_shifts (id) ON DELETE CASCADE,

  note           TEXT,
  title          TEXT,
  set_by         TEXT,
  set_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  published      INTEGER NOT NULL DEFAULT 0,
  ever_published INTEGER NOT NULL DEFAULT 0
);

INSERT INTO att_roster_new (
  staff_id, day, shift_id, note, title, set_by, set_at, published, ever_published
)
SELECT staff_id, day, shift_id, note, title, set_by, set_at, published, ever_published
  FROM att_roster;

DROP TABLE att_roster;
ALTER TABLE att_roster_new RENAME TO att_roster;

CREATE INDEX IF NOT EXISTS idx_att_roster_day ON att_roster (day);
CREATE INDEX IF NOT EXISTS idx_att_roster_staff_day ON att_roster (staff_id, day);

-- Two shifts on a day is now allowed. The same shift twice is not: it is not a
-- double, it is the same promise written down again. COALESCE because a
-- rostered day off is one row too, and SQLite counts two nulls as different.
-- Unfilled slots are outside it on purpose — breakfast wanting two people is
-- two slots.
CREATE UNIQUE INDEX IF NOT EXISTS idx_att_roster_once
  ON att_roster (staff_id, day, COALESCE(shift_id, -1))
  WHERE staff_id IS NOT NULL;
