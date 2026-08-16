-- Departments, chosen from a list rather than typed.
--
-- A department is not decoration. Reports group by it, so "Kitchen", "kitchen"
-- and "Kitchens" are three departments as far as the monthly figures are
-- concerned, and the person reading them has no way to tell that from a real
-- split. Free text guarantees this happens across thirty staff typed in over a
-- fortnight, and it is close to impossible to spot afterwards.
--
-- Kept as a setting rather than a table on purpose. It is one list, edited once
-- a year, with no per-row properties to hold — a table would buy a screen to
-- maintain and nothing else. The staff dialog offers this list plus whatever is
-- already in use, so a department can never vanish from the list while somebody
-- is still in it.
--
-- Seeded with what a hotel usually runs. Every one of these is editable and
-- deletable under Setup → Rules; they are a starting point, not an opinion.

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('att_departments', 'Front Office
Housekeeping
Kitchen
Restaurant & Bar
Maintenance
Security
Grounds
Administration');
