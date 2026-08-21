-- Who actually asked, as a person and not as a line of text.
--
-- `requested_by` has always held a name and a role for the record. That reads
-- well in an audit trail and is useless for ringing a bell: to tell somebody
-- their leave was decided you need their user id. Older rows keep a null here,
-- which simply means nobody is named and the notice goes to whoever can see
-- leave.
ALTER TABLE att_leave ADD COLUMN requested_by_id INTEGER;
