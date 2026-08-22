-- Bonus schemes belong to a department.
--
-- The list had grown to the point where kitchen schemes, housekeeping schemes
-- and property-wide ones sat in one flat run of cards, and finding the one you
-- wanted meant reading all of them. A scheme now says which department it
-- belongs to, and the screen groups by it.
--
-- Null is not a gap to be filled in. A scheme that covers everybody genuinely
-- has no department, and those sit together under General.
ALTER TABLE pay_scheme ADD COLUMN department TEXT;
