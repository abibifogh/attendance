-- ---------------------------------------------------------------------------
-- The most days a week somebody may be put down for
--
-- Kept apart from `days_per_week`, which looks like the same thing and is not.
-- That one is what their week is worth: it decides whether their month came
-- out over or under, and it is the divisor behind their day rate on a payslip.
-- Raising it to let somebody work a sixth day would quietly change what they
-- are paid for a day, which is not what anybody meant.
--
-- This is only about the rota. Null means their contracted week answers for
-- them, which for this property is five days.
-- ---------------------------------------------------------------------------

ALTER TABLE att_staff ADD COLUMN max_days_per_week REAL;

-- The two people the property has said are the exception. Written by name
-- because that is how the instruction was given; anybody can change it
-- afterwards under Setup → Staff, and a name that does not match here simply
-- does nothing.
UPDATE att_staff SET max_days_per_week = 7
 WHERE name LIKE '%Sarpei%' OR name LIKE '%Aryee%';
