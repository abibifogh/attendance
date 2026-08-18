-- A clock-time correction becomes a request, and approving it settles the day.
--
-- The register went in first and the administrators were told after the fact.
-- Being told after the fact is not the same as being asked, and for a change
-- that moves what somebody is paid, being asked is the right way round. So a
-- correction raised by anybody who is not an administrator now waits.
--
-- WHAT WAITING MEANS
-- Nothing is written to the day. `att_days` is untouched until somebody with
-- the setup permission approves, so a period cannot be signed off against
-- figures that are still somebody's proposal. The request is visible on the
-- day it concerns, on the person's report and on the sign-off screen, so
-- nobody signs a period without knowing a change is pending on it.
--
-- WHAT APPROVING MEANS
-- The times go on, the day is recomputed from them, and then it is settled —
-- closed, with the verdict the rules reached from the corrected times, under
-- the approver's name. That order matters. The administrator is not being
-- asked to type a status; they are approving two clock times, and the day that
-- follows from them is worked out rather than chosen. Settling it there and
-- then is the point: a day that has been looked at twice by two people should
-- not still be sitting on somebody's list.
--
-- An administrator's own correction is applied and settled immediately. Asking
-- somebody to approve their own request is a queue with one name in it and
-- teaches everybody to press the button without reading.

ALTER TABLE att_time_edit ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE att_time_edit ADD COLUMN decided_by TEXT;
ALTER TABLE att_time_edit ADD COLUMN decided_at TEXT;
ALTER TABLE att_time_edit ADD COLUMN decision_note TEXT;

-- Existing rows default to approved, which is what they are: they were applied
-- to the day at the moment they were made, under the rules as they stood.

CREATE INDEX IF NOT EXISTS idx_att_time_edit_pending ON att_time_edit (status, id DESC);
CREATE INDEX IF NOT EXISTS idx_att_time_edit_day ON att_time_edit (staff_id, day, status);
