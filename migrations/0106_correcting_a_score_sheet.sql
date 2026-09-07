-- Correcting a sheet after it has been saved.
--
-- Somebody comes out of an interview, marks the sheet on their phone, and finds
-- they have put a 4 against the wrong line, or has the whole of a good answer
-- in their head and nothing in the box. Made to live with it, they do the only
-- thing left: score the person a second time, and the record then holds two
-- sheets for one interview and nothing saying which of them is meant.
--
-- So a sheet can be corrected. What may change is the marks, the notes, the
-- recommendation and the line at the bottom. What may not change is the
-- questions: the words on an answer are what that person was actually asked,
-- and a sheet that rewrites its own questions afterwards is not a record of
-- anything. Answers are not added or taken away either, for the same reason.
--
-- WHO. The person who wrote it, and an administrator. Not anybody who happens
-- to hold the recruitment permission: a mark somebody else's name is on, moved
-- by a third party, is the one thing that would make the whole record
-- unanswerable a year later. Every correction goes on the candidate's trail
-- with what moved and who moved it, and the sheet itself carries who touched it
-- last, so nothing about this is quiet.
ALTER TABLE rec_score ADD COLUMN scored_by_id INTEGER;
ALTER TABLE rec_score ADD COLUMN edited_by TEXT;
ALTER TABLE rec_score ADD COLUMN edited_at TEXT;
