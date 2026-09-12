-- ---------------------------------------------------------------------------
-- Giving up a shift, and taking one
-- ---------------------------------------------------------------------------
--
-- The phone call this replaces goes: I cannot do Saturday, do you know anybody,
-- let me ask around, ring me back. It ends with a supervisor editing the grid
-- on somebody's word, and no record of who agreed to what.
--
-- So an offer is a row. It names the roster row being given up rather than the
-- day and the shift, because the roster row is the thing that will actually
-- change hands, and if it has been deleted or rebuilt underneath the offer
-- then the offer is stale and must not be approved.
--
-- NOTHING HERE TOUCHES THE ROTA. Not on offering, not on taking. The rota
-- changes once, on approval, and until then the shift belongs to the person it
-- always belonged to. That is the whole reason this is a table and not a
-- feature of the grid: a shift with two people half-attached to it is exactly
-- the state a rota must never be in.
--
-- `kind` is what is on the table:
--   give   somebody's shift, going to whoever takes it
--   trade  their shift for one of yours, both rows moving at once
--
-- `status` is where it has got to:
--   open       on the board, or waiting on the one person it was aimed at
--   claimed    somebody has taken it, waiting on a manager
--   approved   the rota has changed
--   declined   a manager said no, or the person it was aimed at did
--   withdrawn  the offerer took it back
--   expired    the shift came and went

CREATE TABLE IF NOT EXISTS att_swap (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,

  kind          TEXT    NOT NULL DEFAULT 'give',
  status        TEXT    NOT NULL DEFAULT 'open',

  -- The shift being given up, and the day it falls on. The day is copied out
  -- of the roster row so the board can be read and sorted without joining, and
  -- so an offer whose row has gone still says what it was about.
  -- SET NULL rather than CASCADE. A roster row deleted underneath a live
  -- offer is exactly the case the approval has to refuse out loud, and an
  -- offer that vanishes with it leaves both people waiting on an answer that
  -- is never coming.
  roster_id     INTEGER REFERENCES att_roster (id) ON DELETE SET NULL,
  day           TEXT    NOT NULL,
  shift_id      INTEGER REFERENCES att_shifts (id) ON DELETE SET NULL,
  from_staff    INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,

  -- For a trade: the shift wanted back, which belongs to the one person the
  -- offer is aimed at.
  back_roster_id INTEGER REFERENCES att_roster (id) ON DELETE SET NULL,
  back_day       TEXT,
  back_shift_id  INTEGER REFERENCES att_shifts (id) ON DELETE SET NULL,

  -- A JSON array of staff ids, or null for anybody who can cover it. Named
  -- people are asked first and the board does not show it to anybody else
  -- while `aimed_only` is set.
  aimed_at      TEXT,
  aimed_only    INTEGER NOT NULL DEFAULT 0,

  reason        TEXT,

  taken_by      INTEGER REFERENCES att_staff (id) ON DELETE SET NULL,
  taken_at      TEXT,

  decided_by    TEXT,
  decided_at    TEXT,
  decision      TEXT,

  created_by    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_att_swap_day ON att_swap (day);
CREATE INDEX IF NOT EXISTS idx_att_swap_status ON att_swap (status, day);
CREATE INDEX IF NOT EXISTS idx_att_swap_from ON att_swap (from_staff, status);
CREATE INDEX IF NOT EXISTS idx_att_swap_taken ON att_swap (taken_by, status);

-- One live offer per roster row. Somebody who offers the same Saturday twice
-- means the first one, and two live offers on one shift is how it ends up
-- given to two people.
CREATE UNIQUE INDEX IF NOT EXISTS idx_att_swap_one_live
  ON att_swap (roster_id)
  WHERE status IN ('open', 'claimed');

-- The rules, all off or conservative to begin with. A property that has never
-- asked for this gets nothing new on any screen.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('swaps_on', '0'),
  -- How close to the start a shift can still be given up.
  ('swap_notice_hours', '24'),
  -- 'always', or 'clean' to let one through when nothing at all is flagged.
  ('swap_approval', 'always'),
  -- Whether somebody may offer a shift to people outside its department, for
  -- a property that trains across.
  ('swap_cross_department', '0'),
  -- How many a person may give away in a calendar month. 0 is no limit.
  ('swap_monthly_cap', '0');
