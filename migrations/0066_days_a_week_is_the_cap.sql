-- ---------------------------------------------------------------------------
-- Days a week is the rota's ceiling too
--
-- 0065 gave the rota a figure of its own so that raising somebody's allowance
-- to work a sixth day would not also change the divisor behind their day rate.
-- The property has decided it would rather have one number than two, so
-- `days_per_week` now answers both questions and `max_days_per_week` is left
-- in place but read by nothing.
--
-- The two people named as the exception are carried across, so the rota keeps
-- behaving as it did after 0065 rather than quietly putting them back to five.
-- Their day rate follows this figure, which is the trade the one-number
-- version makes.
-- ---------------------------------------------------------------------------

UPDATE att_staff
   SET days_per_week = max_days_per_week
 WHERE max_days_per_week IS NOT NULL
   AND (days_per_week IS NULL OR days_per_week < max_days_per_week);
