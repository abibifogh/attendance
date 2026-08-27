-- ---------------------------------------------------------------------------
-- Whose shift it is, in order
--
-- 0062 let a shift belong to one person. What a property actually says is
-- "Nii, and Dorcas when Nii is not there" — a first choice and who steps in.
-- A single id cannot hold that, and writing it down as a habit for the
-- suggester to notice does not hold it either: a habit is a tendency and this
-- is an instruction.
--
-- An ordered JSON array of staff ids. Only these people may work the shift,
-- and the earlier in the list the sooner they are asked. `only_staff_id` is
-- carried across and then read by nothing.
-- ---------------------------------------------------------------------------

ALTER TABLE att_shifts ADD COLUMN only_staff TEXT;

UPDATE att_shifts
   SET only_staff = '[' || only_staff_id || ']'
 WHERE only_staff_id IS NOT NULL AND only_staff IS NULL;
