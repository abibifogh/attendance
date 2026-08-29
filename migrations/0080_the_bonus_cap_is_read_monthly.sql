-- Whether the 15% cap on the 5% bonus rate is read against the month or the year.
--
-- The Act frames it as 15% of the annual basic salary. Salaries are paid
-- monthly, and the practice here is to read the same share against the month
-- being paid: a 2,000 basic gets 300 of bonus at 5% in any month, and anything
-- over that in that month goes through the graduated bands.
--
-- Read against the year it is a running total, and a running total is only as
-- good as the months it has seen — a property that starts here in August has
-- seven months of bonuses the ceiling knows nothing about, and everybody looks
-- as though their whole allowance is intact. Read against the month there is
-- nothing to carry and nothing to be wrong about.
--
-- Kept with the other bonus figures rather than in the settings on its own, so
-- that a month is taxed by the table that was in force when it was worked.
ALTER TABLE pay_rates ADD COLUMN bonus_cap_basis TEXT NOT NULL DEFAULT 'monthly';

INSERT INTO settings (key, value)
VALUES ('pay_bonus_cap_basis', 'monthly')
ON CONFLICT (key) DO NOTHING;
