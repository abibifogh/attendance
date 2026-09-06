-- Moving somebody's leave days becomes a request.
--
-- Signing a month off records a number: how many days it takes off, or gives
-- back to, that person's leave. It is the one figure on the sign-off screen
-- that is not a fact about the month but a decision about somebody's
-- entitlement, and until now whoever could sign a period could set it.
--
-- At this property the person who signs periods is the person who builds the
-- rota, and they are also the person the shortfall is usually about. A planner
-- who is short of cover on a Tuesday, rosters somebody an extra day and then
-- signs the month minus one has moved a colleague's leave to cover a hole in
-- their own rota, with nobody else in the loop. That is not a suspicion about
-- anybody; it is simply the wrong number of hands on a thing that ends up in
-- somebody's pay.
--
-- So the number now waits, on the same footing as a clock-time change. The
-- days themselves are signed as before, because settling the month is the
-- planner's job and holding that up would stop the property working. Only the
-- figure against the leave balance is held, at whatever it stood at, until an
-- administrator approves the move.
--
-- An administrator's own figure goes on at once. Asking somebody to approve
-- their own request is a queue with one name in it, and teaches everybody to
-- press the button without reading.
CREATE TABLE IF NOT EXISTS att_leave_change (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id   INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,

  -- The sign-off it belongs to, and the span in its own right. The span is
  -- copied rather than read back through the review, so the request still says
  -- what it was about after a period is reopened and signed again.
  review_id  INTEGER REFERENCES att_period_review (id) ON DELETE CASCADE,
  from_day   TEXT    NOT NULL,
  to_day     TEXT    NOT NULL,

  -- What stood before, and what is being asked for. Both are kept: approving
  -- something that has since been changed by somebody else is the one case
  -- where a request has to be able to say it no longer applies.
  was        INTEGER NOT NULL DEFAULT 0,
  days       INTEGER NOT NULL,

  -- Why. Never optional in the screen, because a day off somebody's
  -- entitlement is not defensible three months later without one.
  reason     TEXT,

  status     TEXT    NOT NULL DEFAULT 'pending',  -- pending | approved | refused | withdrawn
  actor      TEXT    NOT NULL,
  actor_id   INTEGER,
  at_utc     TEXT    NOT NULL DEFAULT (datetime('now')),

  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_att_leave_change_pending ON att_leave_change (status, id DESC);
CREATE INDEX IF NOT EXISTS idx_att_leave_change_staff ON att_leave_change (staff_id, from_day);
