-- ---------------------------------------------------------------------------
-- Weekdays somebody never works
--
-- Different from the ✕ on the rota, which marks a named date and is a fact
-- about one week: "cannot work Tuesday the ninth". This is the standing one.
-- Somebody who is at church every Sunday, or at school on Wednesday
-- afternoons, is not going to be told a fortnight at a time.
--
-- A JSON array of weekdays, Monday as 0, matching the standing pattern and a
-- shift's own runs_on. Null means no standing rule, which is what everybody
-- had before this column existed.
-- ---------------------------------------------------------------------------

ALTER TABLE att_staff ADD COLUMN off_days TEXT;
