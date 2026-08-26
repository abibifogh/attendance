-- ---------------------------------------------------------------------------
-- A shift that belongs to one person
--
-- The accountant's Wednesday, the spa therapist's afternoons, the one driver
-- with the licence for the minibus. Nobody else can work them, and a rota that
-- offers them to everybody is offering something that is not true.
--
-- Two consequences, and the second is the point. Only that person is ever put
-- on it, and on a day they are off the shift does not run at all. It is not a
-- gap somebody else should fill: there is nobody else, and reporting it as one
-- every week teaches a planner to ignore the list of gaps.
--
-- ON DELETE SET NULL: removing a member of staff frees the shift rather than
-- taking it with them.
-- ---------------------------------------------------------------------------

ALTER TABLE att_shifts ADD COLUMN only_staff_id INTEGER REFERENCES att_staff (id) ON DELETE SET NULL;
