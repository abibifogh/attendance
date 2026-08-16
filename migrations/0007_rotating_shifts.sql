-- Shifts that rotate week by week.
--
-- The standing pattern was one week wide: Monday mornings, Tuesday mornings,
-- and so on forever. That fits an office. It does not fit a hotel, where a
-- porter is on mornings this week, afternoons next week and nights the week
-- after, and where the day off moves with the rotation.
--
-- A one-week pattern forces that person's rota to be typed out by hand every
-- week for the rest of their employment — which is the job this app was
-- supposed to remove.
--
-- So the pattern gains a week number, and a member of staff gains the length of
-- their cycle. `rotation_weeks = 1` is the old behaviour exactly: one week, week
-- zero, repeating. Nobody who does not rotate has to know this exists.
--
-- Which week of the cycle a date falls in is counted from a fixed Monday, so it
-- never depends on when a screen was opened or when a person was added. Move
-- the anchor and every rotation shifts together, which is the one lever needed
-- when a cycle is a week out of step.

-- SQLite cannot add a column to a primary key, so the table is rebuilt. Every
-- existing pattern becomes week zero of a one-week cycle, which is what it
-- already was.
CREATE TABLE att_patterns_new (
  staff_id INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  -- 0-based position in the cycle. Always 0 for somebody who does not rotate.
  week     INTEGER NOT NULL DEFAULT 0,
  dow      INTEGER NOT NULL,
  shift_id INTEGER REFERENCES att_shifts (id) ON DELETE SET NULL,
  PRIMARY KEY (staff_id, week, dow)
);

INSERT INTO att_patterns_new (staff_id, week, dow, shift_id)
  SELECT staff_id, 0, dow, shift_id FROM att_patterns;

DROP TABLE att_patterns;
ALTER TABLE att_patterns_new RENAME TO att_patterns;

-- How many weeks before this person's pattern repeats. 1 means it does not
-- rotate, which is the sensible default and the whole of the previous world.
ALTER TABLE att_staff ADD COLUMN rotation_weeks INTEGER NOT NULL DEFAULT 1;

-- The Monday every cycle is counted from. 1 January 2024 was a Monday, and it
-- is safely before any record this system will hold.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('att_rotation_anchor', '2024-01-01');
