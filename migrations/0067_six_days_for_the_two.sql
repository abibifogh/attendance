-- ---------------------------------------------------------------------------
-- Six days a week for the two, not seven
--
-- 0065 set the pair the property named to seven, which was read as "no cap"
-- rather than as a figure anybody had chosen. Six is the figure. The rota will
-- not put them down for a seventh day, and their Sunday comes back.
--
-- Their day rate follows this number, six days being the divisor now instead
-- of seven, so a day of theirs is worth more on a payslip than it was
-- yesterday. That is the trade the property took when it decided to have one
-- days-a-week figure rather than two.
-- ---------------------------------------------------------------------------

UPDATE att_staff
   SET days_per_week = 6
 WHERE days_per_week = 7
   AND (name LIKE '%Sarpei%' OR name LIKE '%Aryee%');
