-- Christmas or New Year: staff choose which holiday they have off.
--
-- The office sets the choices (two days each, usually), how many of each
-- department may have each one, and a date to answer by. Everybody on the rota
-- except casual staff is asked. Each person picks one and works the other.
-- Confirming turns every pick into approved leave of its own kind, so it is on
-- the rota and the person's shifts like any other leave, and a day in it that
-- is not a public holiday comes off annual leave when the round says so.

CREATE TABLE IF NOT EXISTS hol_round (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL,
  -- draft: saved, nobody asked. open: asked, answers coming in.
  -- confirmed: on the rota and everybody told.
  status        TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'confirmed')),
  -- first: a choice that is full shows as full and cannot be picked.
  -- decide: everybody says what they want and the office settles the overs.
  mode          TEXT    NOT NULL DEFAULT 'first' CHECK (mode IN ('first', 'decide')),
  due_on        TEXT    NOT NULL,
  -- What happens to somebody who has not answered when it is confirmed:
  -- room: given whichever choice has room. office: left for the office.
  unanswered    TEXT    NOT NULL DEFAULT 'room' CHECK (unanswered IN ('room', 'office')),
  remind        INTEGER NOT NULL DEFAULT 1,
  -- Days in a choice that are not public holidays come off annual leave.
  charge_leave  INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  opened_at     TEXT,
  confirmed_at  TEXT,
  confirmed_by  TEXT
);

CREATE TABLE IF NOT EXISTS hol_option (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id  INTEGER NOT NULL REFERENCES hol_round (id) ON DELETE CASCADE,
  label     TEXT    NOT NULL,
  from_day  TEXT    NOT NULL,
  to_day    TEXT    NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_hol_option_round ON hol_option (round_id, position);

-- How many of a department may have a choice. No row means no limit.
CREATE TABLE IF NOT EXISTS hol_limit (
  option_id   INTEGER NOT NULL REFERENCES hol_option (id) ON DELETE CASCADE,
  department  TEXT    NOT NULL,
  places      INTEGER NOT NULL,
  PRIMARY KEY (option_id, department)
);

-- One answer per person per round, and who gave it.
CREATE TABLE IF NOT EXISTS hol_pick (
  round_id     INTEGER NOT NULL REFERENCES hol_round (id) ON DELETE CASCADE,
  staff_id     INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  option_id    INTEGER REFERENCES hol_option (id) ON DELETE CASCADE,
  picked_at    TEXT,
  by_office    INTEGER NOT NULL DEFAULT 0,
  picked_by    TEXT,
  reminded_on  TEXT,
  leave_id     INTEGER,
  PRIMARY KEY (round_id, staff_id)
);

-- The leave a confirmed pick becomes. Not something staff ask for themselves;
-- what it takes off annual leave is set on each row when it is written.
INSERT OR IGNORE INTO att_reasons
  (code, label, kind, paid, counts_as_worked, deducts_leave, selectable, requires_note, colour, sort_order, system, staff_pick)
VALUES ('holiday_choice', 'Holiday chosen', 'leave', 1, 0, 1, 0, 0, 'grey', 95, 1, 0);
