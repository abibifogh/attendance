-- A day put back the way it was published is published again.
--
-- `published` is a flag and nothing else, so every write cleared it: a day
-- being changed is a draft again, which is true and was applied to writes
-- where nothing had moved. Take a shift off somebody, think better of it, put
-- it back where it was, and the rota is exactly what staff were sent while the
-- Publish button asks for a change nobody made. The only way to clear that was
-- to publish the week again, which sends everybody a notice about a rota that
-- has not moved.
--
-- The flag cannot answer this on its own, because it does not know what was
-- published. This column does: the shape of the row at the moment it went out,
-- as staff, shift, title and note. A write compares what it is about to store
-- against it, and a row that matches stays published rather than going back to
-- draft.
--
-- Rows already published are backfilled from what they say now, which is what
-- was published: nothing has been written to them since, or they would not
-- still be marked published.
ALTER TABLE att_roster ADD COLUMN published_as TEXT;

UPDATE att_roster
   SET published_as = COALESCE(staff_id, '') || '|' || COALESCE(shift_id, '')
                      || '|' || COALESCE(title, '') || '|' || COALESCE(note, '')
 WHERE published = 1;
