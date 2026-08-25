-- ---------------------------------------------------------------------------
-- Which departments somebody may be put on
--
-- `department` says where a person belongs. It does not say where they may be
-- rostered, and for most of the staff those are the same thing: a housekeeper
-- has no business being drafted onto Security, and until now nothing stopped
-- the suggester doing exactly that.
--
-- A JSON array of department names, matching how `tags` is already kept.
-- Empty means their own department answers for them, which is what everybody
-- already had before this column existed.
-- ---------------------------------------------------------------------------

ALTER TABLE att_staff ADD COLUMN works_in TEXT;
