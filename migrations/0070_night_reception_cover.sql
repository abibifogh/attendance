-- ---------------------------------------------------------------------------
-- Three people who do the reception night, and nothing else there
--
-- Johnson, Atsu and Ofori sit in Maintenance and Housekeeping and come to the
-- desk overnight. Giving them Reception would put them in the running for the
-- AM and the PM as well, which is not what anybody said, so they are named for
-- the one shift instead.
--
-- Both halves have to be written. Naming a shift is the whole answer on its
-- own — somebody picked out shift by shift is not also their department — so
-- the department they already sit in is written down alongside it, or Atsu
-- would stop being second choice for Housekeeping main the moment he took a
-- night.
-- ---------------------------------------------------------------------------

UPDATE att_staff
   SET works_in = COALESCE(works_in, '["' || department || '"]'),
       works_shifts = json_insert(
         COALESCE(works_shifts, json_array()),
         '$[#]',
         (SELECT id FROM att_shifts WHERE name = 'Night shift' AND department = 'Reception')
       )
 WHERE active = 1
   AND department IS NOT NULL
   AND (name LIKE '%Yakanu%' OR name LIKE '%Adanuvi%' OR name LIKE '%Bennie%')
   AND EXISTS (SELECT 1 FROM att_shifts WHERE name = 'Night shift' AND department = 'Reception')
   -- Not twice, if a hand has already added it.
   AND (works_shifts IS NULL OR NOT EXISTS (
     SELECT 1 FROM json_each(att_staff.works_shifts) AS picked
      WHERE picked.value = (SELECT id FROM att_shifts
                             WHERE name = 'Night shift' AND department = 'Reception')
   ));
