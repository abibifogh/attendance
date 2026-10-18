-- ---------------------------------------------------------------------------
-- The rules the property gave by name
--
-- Written here rather than left to be typed in, because they were given as
-- instructions and a typed-in rule is one nobody can see was ever agreed.
-- Every one of them is editable afterwards under Setup → Shifts.
--
-- Matched on name rather than on id: these ids are this property's, and a
-- migration that hard-codes them is a migration that does the wrong thing to
-- the next database it meets. Nothing matches, nothing happens.
--
--   Breakfast main      one a day, Nicholas first and Dinah when he is not free
--   Breakfast helper    one a day
--   Housekeeping main   one a day, Lydia first and Awuku after her
--   Reception           one each on AM, PM and Night, every day
-- ---------------------------------------------------------------------------

-- Breakfast main: Nicholas, then Dinah.
UPDATE att_shifts
   SET needed = 1,
       only_staff = (
         SELECT '[' || group_concat(id) || ']' FROM (
           SELECT id, 1 AS rank FROM att_staff WHERE name LIKE '%Armah%' AND active = 1
           UNION ALL
           SELECT id, 2 AS rank FROM att_staff WHERE name LIKE '%Sowah%' AND active = 1
           ORDER BY rank
         )
       )
 WHERE name = 'Breakfast main';

-- Breakfast helper: one a day, whoever is set up for it.
UPDATE att_shifts SET needed = 1 WHERE name = 'Breakfast helper';

-- Housekeeping main: Lydia, then Awuku.
UPDATE att_shifts
   SET needed = 1,
       only_staff = (
         SELECT '[' || group_concat(id) || ']' FROM (
           SELECT id, 1 AS rank FROM att_staff WHERE name LIKE '%Amegashie%' AND active = 1
           UNION ALL
           SELECT id, 2 AS rank FROM att_staff WHERE name LIKE '%Ametewee%' AND active = 1
           ORDER BY rank
         )
       )
 WHERE name = 'Housekeeping main';

-- Reception: three people every day, one on each of the three shifts.
UPDATE att_shifts
   SET needed = 1
 WHERE department = 'Reception'
   AND name IN ('AM Shift', 'PM shift', 'Night shift');
