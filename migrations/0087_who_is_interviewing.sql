-- Who is interviewing, as a person rather than a name typed in a box.
--
-- The name was free text, which was fine for printing and no use for anything
-- else. The moment a candidate takes a time, somebody has to be told, and
-- "Kwame" is not somebody the app can tell.
--
-- So a slot can name a member of staff. The typed name stays alongside it and
-- is what prints: a staff record that is later renamed, or somebody who leaves,
-- should not change what a diary from March said. And an interviewer who is
-- not on the books at all - an owner, a consultant sitting on the panel - is
-- still just a name, exactly as before.
ALTER TABLE rec_slot ADD COLUMN interviewer_staff_id INTEGER
  REFERENCES att_staff (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_rec_slot_interviewer
  ON rec_slot (interviewer_staff_id, day);

-- The default that fills the publish form, kept beside the place for the same
-- reason: whoever usually interviews usually interviews.
INSERT OR IGNORE INTO settings (key, value) VALUES ('rec_interviewer', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('rec_interviewer_staff_id', '');
