-- Telling the person being interviewed, not only the panel.
--
-- Choosing a time used to end on a screen that said "booked" and nothing
-- else. Now they are sent the details by email (or by text where there is no
-- email address): when, where, a way to get there, a calendar entry, and a
-- way to change it. The day before, a reminder. When the time moves or is
-- cancelled, by them or by the office, they are told that too.

-- What to bring to the interview, set on each vacancy. Left empty, the
-- message leaves the line out.
ALTER TABLE rec_role ADD COLUMN bring TEXT;

-- When the day-before reminder went, so it goes once. Cleared when the time
-- moves.
ALTER TABLE rec_slot ADD COLUMN reminded_at TEXT;

-- The candidate's link, sealed with the server's secret, so a message sent
-- later (a reminder, a change made by the office) can carry the same link
-- they already have. A copy of the database alone opens nothing: the hash is
-- still what the link is checked against.
ALTER TABLE rec_invite ADD COLUMN token_box TEXT;
