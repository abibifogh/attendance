-- A leave plan for the whole year, sent at the start of it.
--
-- Everybody who earns annual leave is asked once, early in the year, for the
-- weeks they want off. They see which weeks their department is already full
-- and which are busy seasons, and pick around them. The managers then approve
-- the year in one place, and approved weeks become ordinary approved leave.

-- One planning round per year: when it opens, when plans are due, and the
-- rules it is planned against.
CREATE TABLE IF NOT EXISTS leave_plan_round (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  year          INTEGER NOT NULL UNIQUE,
  opens_on      TEXT    NOT NULL,
  due_on        TEXT    NOT NULL,
  -- Ask each person to plan at least this many of their days now.
  min_days      REAL    NOT NULL DEFAULT 10,
  -- [{"from":"2027-12-20","to":"2028-01-02","label":"Christmas and New Year"}]
  busy          TEXT    NOT NULL DEFAULT '[]',
  -- {"Front desk":1,"Housekeeping":2}. A department not listed takes one.
  limits        TEXT    NOT NULL DEFAULT '{}',
  remind        INTEGER NOT NULL DEFAULT 1,
  tell_managers INTEGER NOT NULL DEFAULT 1,
  -- draft | open | closed
  status        TEXT    NOT NULL DEFAULT 'draft',
  invited_at    TEXT,
  opened_by     TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One plan per person per round.
CREATE TABLE IF NOT EXISTS leave_plan (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id    INTEGER NOT NULL REFERENCES leave_plan_round (id) ON DELETE CASCADE,
  staff_id    INTEGER NOT NULL REFERENCES att_staff (id),
  -- draft | sent | reviewed
  status      TEXT    NOT NULL DEFAULT 'draft',
  sent_at     TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  reminded_on TEXT,
  UNIQUE (round_id, staff_id)
);

-- A block of time off inside a plan.
CREATE TABLE IF NOT EXISTS leave_plan_block (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id      INTEGER NOT NULL REFERENCES leave_plan (id) ON DELETE CASCADE,
  from_day     TEXT    NOT NULL,
  to_day       TEXT    NOT NULL,
  days         REAL    NOT NULL DEFAULT 0,
  reason_code  TEXT    NOT NULL DEFAULT 'annual_leave',
  -- planned | approved | move | declined
  status       TEXT    NOT NULL DEFAULT 'planned',
  -- The approved leave it became.
  leave_id     INTEGER,
  -- What the manager said, and the dates suggested instead, when asked to move.
  note         TEXT,
  suggest_from TEXT,
  suggest_to   TEXT,
  decided_by   TEXT,
  decided_at   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leave_plan_block_plan ON leave_plan_block (plan_id, status);
CREATE INDEX IF NOT EXISTS idx_leave_plan_round_status ON leave_plan_round (status);
