-- The property's real shifts, taken from the Hik-Connect shift list.
--
-- Twenty-four of them, which is why they are here rather than typed into a form
-- one at a time. Names and times are copied exactly as Hik-Connect has them, so
-- that a shift called "Bistro shift 2" means the same thing in both places and
-- nobody has to hold a translation in their head.
--
-- Three of these run past midnight — Bar, Security and Night shift. An end time
-- at or before the start is what marks a shift as overnight here, and all three
-- satisfy that, Bar included: it ends at 00:00, which is not later than 16:00.
-- The whole of an overnight shift belongs to the day it started on.
--
-- Five share 08:00–17:00 and several more overlap. That is fine and deliberate:
-- only the name is unique, because "who is on Housekeeping main" and "who is on
-- Laundry 1" are different questions even when the hours are identical.
--
-- Two things Hik-Connect does not know, and which this cannot invent:
--
--   Unpaid break is set to zero on every one of them. Hik-Connect's work period
--   is only a start and an end. A nine-hour shift almost certainly has an hour
--   for lunch, but guessing an hour would silently take an hour off somebody's
--   recorded time, and guessing zero at least matches what the terminal saw.
--   These want going through once.
--
--   Grace is five minutes each way, this app's default, because the device has
--   no opinion on it either.
--
-- Half-day and full-day thresholds are derived from the length of each shift —
-- half of it, and ninety per cent of it, rounded to the nearest half hour. They
-- decide whether a day counts as one worked day in the figures that reach the
-- wages, so they are a starting point rather than an answer.
--
-- Sorted by start time, so the rota dropdown reads down the day.
--
-- `source` is deliberately left null, which marks these as set up by hand. A
-- device re-sync matches on times, and with five shifts sharing 08:00–17:00 it
-- could rename the wrong one; leaving them unmarked means the sync never
-- touches them.

INSERT OR IGNORE INTO att_shifts
  (name, starts_at, ends_at, break_minutes, grace_in_minutes, grace_out_minutes,
   half_day_minutes, full_day_minutes, overtime_after, sort_order, active)
VALUES
  ('Breakfast main',       '05:00', '11:30', 0, 5, 5, 180, 360, 0,  300, 1),
  ('Breakfast main +',     '05:00', '13:30', 0, 5, 5, 240, 450, 0,  300, 1),
  ('AM Shift',             '06:00', '14:15', 0, 5, 5, 240, 450, 0,  360, 1),
  ('Breakfast helper',     '06:00', '12:00', 0, 5, 5, 180, 330, 0,  360, 1),
  ('Breakfast helper +',   '06:00', '13:30', 0, 5, 5, 240, 420, 0,  360, 1),
  ('Housekeeping helper +','07:00', '16:00', 0, 5, 5, 270, 480, 0,  420, 1),
  ('Admin',                '08:00', '17:00', 0, 5, 5, 270, 480, 0,  480, 1),
  ('Housekeeping main',    '08:00', '17:00', 0, 5, 5, 270, 480, 0,  480, 1),
  ('Laundry 1',            '08:00', '17:00', 0, 5, 5, 270, 480, 0,  480, 1),
  ('Craft',                '08:00', '17:00', 0, 5, 5, 270, 480, 0,  480, 1),
  ('Maintenance 1',        '08:00', '17:00', 0, 5, 5, 270, 480, 0,  480, 1),
  ('Laundry 2',            '08:30', '17:30', 0, 5, 5, 270, 480, 0,  510, 1),
  ('Maintenance 3',        '08:30', '17:30', 0, 5, 5, 270, 480, 0,  510, 1),
  ('Housekeeping helper',  '09:00', '18:00', 0, 5, 5, 270, 480, 0,  540, 1),
  ('Craft 2',              '09:00', '18:00', 0, 5, 5, 270, 480, 0,  540, 1),
  ('Maintenance 2',        '09:00', '18:00', 0, 5, 5, 270, 480, 0,  540, 1),
  ('Admin 2',              '10:00', '19:00', 0, 5, 5, 270, 480, 0,  600, 1),
  ('Bistro shift 1',       '11:00', '19:00', 0, 5, 5, 240, 420, 0,  660, 1),
  ('Bistro',               '12:30', '22:00', 0, 5, 5, 300, 510, 0,  750, 1),
  ('Bistro shift 2',       '13:45', '22:00', 0, 5, 5, 240, 450, 0,  825, 1),
  ('PM shift',             '14:00', '22:15', 0, 5, 5, 240, 450, 0,  840, 1),
  ('Bar',                  '16:00', '00:00', 0, 5, 5, 240, 420, 0,  960, 1),
  ('Security',             '17:30', '06:30', 0, 5, 5, 390, 690, 0, 1050, 1),
  ('Night shift',          '22:00', '06:15', 0, 5, 5, 240, 450, 0, 1320, 1);
