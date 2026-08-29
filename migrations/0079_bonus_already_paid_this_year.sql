-- What a person has already had as bonus this year, before this app knew.
--
-- The 5% final rate on a bonus is capped at 15% of the annual basic salary,
-- and the excess is taxed at the graduated rates. So the ceiling is a running
-- total across the year, and this app can only see the months it has closed
-- itself. A property that starts using it in August has seven months of
-- bonuses the ceiling knows nothing about, and everybody looks as though they
-- have their whole allowance left — which is how somebody ends up taxed at 5%
-- on money that should have gone through the bands.
--
-- Two columns rather than one, because the figure belongs to a year. Kept
-- beside the year it is about so that January arrives and it stops counting
-- on its own, instead of quietly carrying somebody's 2026 bonuses into 2027.
ALTER TABLE pay_profile ADD COLUMN bonus_opening REAL NOT NULL DEFAULT 0;
ALTER TABLE pay_profile ADD COLUMN bonus_opening_year TEXT;
