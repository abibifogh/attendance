-- Which kinds of leave a member of staff may ask for themselves.
--
-- The list on their phone was every active kind of leave, which is not the
-- same list. Maternity leave is arranged in an office, not requested from a
-- dropdown at the end of a shift; suspension is not something anybody asks
-- for; a property that records unpaid leave may not want it offered as an
-- option beside the paid one. Offering all of them invites requests nobody
-- can act on, and the answer is always the same conversation.
--
-- The list somebody who manages leave picks from is unchanged: they can record
-- any of them, which is the whole point of the difference.
--
-- Not `selectable`, which asks a different question — whether a supervisor may
-- charge a day to it after the fact — and had been standing in for this one.
ALTER TABLE att_reasons ADD COLUMN staff_pick INTEGER NOT NULL DEFAULT 1;

-- Nothing changes on the day this lands: whatever the phone showed yesterday
-- it shows today, and an administrator unticks what should not have been
-- there. `selectable` was the filter until now, so anything it had switched
-- off stays off.
UPDATE att_reasons SET staff_pick = 0 WHERE selectable = 0;
