-- An hour's lunch on the nine-hour shifts, and a department on every shift.
--
-- ---------------------------------------------------------------------------
-- The break, and why the thresholds have to move with it
-- ---------------------------------------------------------------------------
--
-- Hours worked are counted with the unpaid break already taken off. So putting
-- an hour's break on a nine-hour shift leaves eight paid hours — and the
-- full-day threshold on those shifts is currently 480 minutes, which was ninety
-- per cent of nine hours and is now one hundred per cent of eight.
--
-- Left alone, that would mean somebody had to work every last minute of the
-- shift to be credited with a full day, and leaving two minutes early would
-- cost them one. Adding the break without moving the threshold would quietly
-- make the rules stricter than they have ever been, which is not what "give
-- them their lunch hour" is supposed to do.
--
-- So both move together, derived from paid time rather than from the span:
-- half a day is 240 minutes and a full day 420, being half and ninety per cent
-- of the eight paid hours.
--
-- Only shifts of exactly nine hours are touched. Bistro (9h30) and Security
-- (13h) are left alone deliberately — they are not nine hours, and what their
-- break should be is a decision rather than an inference.
--
-- ---------------------------------------------------------------------------
-- Departments
-- ---------------------------------------------------------------------------
--
-- Taken from the five departments Hik-Connect already files people under —
-- Reception, F&B, Housekeeping, Maintenance, Security — rather than from a
-- finer set invented here. Reports group by department, and a rota where the
-- shifts say "Kitchen" while the staff say "F&B" produces two half-populated
-- groups and no way to tell that from a real split.
--
-- So the coarser, real vocabulary wins. Their own filing decides the awkward
-- cases: Craft sits under F&B because CRFT001 does, and the Admin shifts sit
-- under Reception because Adm001 does. Laundry has shifts but no staff of its
-- own, so it goes with Housekeeping.
--
-- If the finer grouping is wanted later — Kitchen apart from Bistro apart from
-- Bar — it is a dropdown on each shift, and nothing here prevents it.
--
-- Every one of these is editable on the shift itself.

ALTER TABLE att_shifts ADD COLUMN department TEXT;

-- Exactly nine hours: an hour off, and the day thresholds recut from the eight
-- paid hours that leaves.
UPDATE att_shifts
   SET break_minutes = 60, half_day_minutes = 240, full_day_minutes = 420
 WHERE break_minutes = 0
   AND name IN (
     'Housekeeping helper +', 'Admin', 'Housekeeping main', 'Laundry 1', 'Craft',
     'Maintenance 1', 'Laundry 2', 'Maintenance 3', 'Housekeeping helper',
     'Craft 2', 'Maintenance 2', 'Admin 2'
   );

UPDATE att_shifts SET department = 'Reception'   WHERE name IN ('AM Shift', 'PM shift', 'Night shift', 'Admin', 'Admin 2');
UPDATE att_shifts SET department = 'F&B'         WHERE name IN ('Breakfast main', 'Breakfast main +', 'Breakfast helper', 'Breakfast helper +', 'Bistro', 'Bistro shift 1', 'Bistro shift 2', 'Bar', 'Craft', 'Craft 2');
UPDATE att_shifts SET department = 'Housekeeping' WHERE name IN ('Housekeeping main', 'Housekeeping helper', 'Housekeeping helper +', 'Laundry 1', 'Laundry 2');
UPDATE att_shifts SET department = 'Maintenance' WHERE name IN ('Maintenance 1', 'Maintenance 2', 'Maintenance 3');
UPDATE att_shifts SET department = 'Security'    WHERE name = 'Security';

-- The department list, replaced with the five this property actually uses —
-- but only if nobody has edited it since it was seeded. An edited list is
-- somebody's decision and is not ours to overwrite.
UPDATE settings
   SET value = 'Reception
F&B
Housekeeping
Maintenance
Security'
 WHERE key = 'att_departments'
   AND value = 'Front Office
Housekeeping
Kitchen
Restaurant & Bar
Maintenance
Security
Grounds
Administration';
