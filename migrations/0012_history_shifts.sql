-- Shifts the year's rota used that the Hik-Connect shift list did not contain.
--
-- The schedule export carries the actual start and end of every rostered day,
-- and seventeen time pairs in it match none of the twenty-four shifts defined
-- on the terminal. They are real — people worked them — so they are created
-- rather than rounded to the nearest tidy shift, which would silently move
-- somebody's start time and make them late for a day they were never late for.
--
-- Named by position and hours because that is all the export says about them.
-- Rename freely; nothing here depends on the names beyond the import that
-- follows.
--
-- The rare ones are created inactive. Four of these were worked fifty times or
-- more and belong in the dropdown; the rest happened once or twice, and an
-- inactive shift still explains the day it belongs to without cluttering every
-- rota cell for ever after.
--
-- Nine-hour shifts get the same hour's lunch and the same recut thresholds as
-- the rest; anything else is left at zero, unguessed.

INSERT OR IGNORE INTO att_shifts
  (name, starts_at, ends_at, break_minutes, grace_in_minutes, grace_out_minutes,
   half_day_minutes, full_day_minutes, overtime_after, sort_order, active, department)
VALUES
  ('Breakfast 06:00–11:00', '06:00', '11:00', 0, 5, 5, 150, 270, 0, 360, 0, 'F&B'),
  ('Breakfast 06:00–13:00', '06:00', '13:00', 0, 5, 5, 210, 390, 0, 360, 0, 'F&B'),
  ('Breakfast 06:00–14:00', '06:00', '14:00', 0, 5, 5, 240, 420, 0, 360, 1, 'F&B'),
  ('Breakfast 06:00–14:30', '06:00', '14:30', 0, 5, 5, 240, 450, 0, 360, 1, 'F&B'),
  ('Breakfast 06:00–15:00', '06:00', '15:00', 60, 5, 5, 240, 420, 0, 360, 1, 'F&B'),
  ('Housekeeping 07:00–16:30', '07:00', '16:30', 0, 5, 5, 300, 510, 0, 420, 1, 'Housekeeping'),
  ('Housekeeping 08:00–17:15', '08:00', '17:15', 0, 5, 5, 270, 510, 0, 480, 0, 'Housekeeping'),
  ('Craft Shop 09:00–17:00', '09:00', '17:00', 0, 5, 5, 240, 420, 0, 540, 0, 'F&B'),
  ('Housekeeping 09:00–17:00', '09:00', '17:00', 0, 5, 5, 240, 420, 0, 540, 0, 'Housekeeping'),
  ('Admin 09:30–18:30', '09:30', '18:30', 60, 5, 5, 240, 420, 0, 570, 0, 'Reception'),
  ('Craft Shop 09:30–17:00', '09:30', '17:00', 0, 5, 5, 240, 420, 0, 570, 0, 'F&B'),
  ('Admin 10:00–17:00', '10:00', '17:00', 0, 5, 5, 210, 390, 0, 600, 0, 'Reception'),
  ('Craft Shop 10:00–17:00', '10:00', '17:00', 0, 5, 5, 210, 390, 0, 600, 0, 'F&B'),
  ('Craft Shop 10:00–18:00', '10:00', '18:00', 0, 5, 5, 240, 420, 0, 600, 0, 'F&B'),
  ('Admin 11:00–18:00', '11:00', '18:00', 0, 5, 5, 210, 390, 0, 660, 0, 'Reception'),
  ('Bar & Kitchen 12:00–22:00', '12:00', '22:00', 0, 5, 5, 300, 540, 0, 720, 1, 'F&B'),
  ('Admin 13:00–22:00', '13:00', '22:00', 60, 5, 5, 240, 420, 0, 780, 0, 'Reception');
