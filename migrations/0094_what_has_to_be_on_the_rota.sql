-- What has to be on the rota, what is wanted on it, and what is a bonus.
--
-- A shift had two states: optional, or not. "Not optional" was doing two very
-- different jobs. The craft shop is worth covering and the day survives
-- without it; the night desk is not, and a night with nobody on it is a fact
-- somebody has to be looking at on Monday morning, not a line in a list of
-- things the draft could not manage. The draft treated them the same way and
-- quietly left both off the grid, which is what "it omits some shifts" means.
--
-- Three levels now.
--
--   must      Always on the rota. If nobody can be found for it, it goes on
--             the grid EMPTY, so the hole is a cell somebody has to fill
--             rather than an absence nobody sees.
--   wanted    Filled if somebody is free. The old "it has to be covered", and
--             what every shift is unless it is told otherwise.
--   optional  Only if somebody is spare, after everything else is settled.
--             Nobody free for it is the answer, not a gap.
--
-- WHAT IS SEEDED HERE IS A FIRST PASS, meant to be argued with on the new
-- Setup screen rather than lived with. Two rules, both of them things the
-- property has already said rather than anything guessed about hotels:
--
--   Must is every shift that already carries a "how many people it needs"
--   count, because setting that number was somebody saying out loud that this
--   shift needs a person. Plus overnight Security, which is the one shift
--   where an empty cell is a locked building nobody is watching.
--
--   Alternates are the name families that differ only by a "+" or by their
--   finishing time — Breakfast main and Breakfast main +, and the three
--   Breakfast 06:00 shifts. Those are one morning written several ways, and
--   two of them on one day has always been a mistake. Anything numbered
--   (Maintenance 1, 2, 3; Laundry 1 and 2; Admin and Admin 2) is left alone,
--   because a number means a second person, not a second version.
ALTER TABLE att_shifts ADD COLUMN cover TEXT NOT NULL DEFAULT 'wanted';

-- Whatever was already marked optional stays optional.
UPDATE att_shifts SET cover = 'optional' WHERE optional = 1;

-- The shifts that already declare they need somebody, and the night watch.
UPDATE att_shifts SET cover = 'must'
 WHERE optional = 0
   AND (needed IS NOT NULL OR name = 'Security');

-- One morning, written several ways. Only where the names say so.
UPDATE att_shifts SET alt_group = 'breakfast-main'
 WHERE alt_group IS NULL AND name IN ('Breakfast main', 'Breakfast main +');
UPDATE att_shifts SET alt_group = 'breakfast-helper'
 WHERE alt_group IS NULL AND name IN ('Breakfast helper', 'Breakfast helper +');
UPDATE att_shifts SET alt_group = 'housekeeping-helper'
 WHERE alt_group IS NULL AND name IN ('Housekeeping helper', 'Housekeeping helper +');
UPDATE att_shifts SET alt_group = 'breakfast-late'
 WHERE alt_group IS NULL
   AND name IN ('Breakfast 06:00–11:00', 'Breakfast 06:00–13:00', 'Breakfast 06:00–14:00',
                'Breakfast 06:00–14:30', 'Breakfast 06:00–15:00');

-- `optional` said one of the three things this column now says, and saying it
-- in two places is how the two of them come to disagree.
ALTER TABLE att_shifts DROP COLUMN optional;
