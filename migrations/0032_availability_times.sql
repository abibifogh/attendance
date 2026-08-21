-- Unavailability with a clock on it.
--
-- "Cannot work the 14th" was the whole story. Real life is usually smaller:
-- an antenatal appointment until noon, evening classes from six. Somebody like
-- that can work the day, just not all of it, and a mark that blocks the whole
-- day forces the planner to choose between ignoring the mark and losing a
-- worker they actually have for most of a shift.
--
-- Both times empty still means the whole day, which stays the common case.
ALTER TABLE att_availability ADD COLUMN from_time TEXT;
ALTER TABLE att_availability ADD COLUMN to_time TEXT;
