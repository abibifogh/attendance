-- A bonus scheme can pay by a tier rather than a percentage or a flat figure.
--
-- Nkosoɔ is scored one to ten, and each score is worth a stated amount: a 1 is
-- seventy cedis, a 4 is a hundred and thirty, a 10 is two hundred and fifty.
-- That is neither of the two shapes already here. Scored out of a hundred it
-- would mean working out what per cent of 250 comes to 130, every month, for
-- everybody; as a set figure each it would mean typing the amount rather than
-- the score, and the score is the thing the property actually decides.
--
-- So the table of scores and what each is worth belongs to the scheme, and
-- somebody picks a score. The award still lands the same way downstream —
-- an amount scored at a hundred — because a tier is a lookup, not a different
-- kind of money.
ALTER TABLE pay_scheme ADD COLUMN tiers TEXT;

-- Which tier somebody was put in. Kept beside the money rather than worked
-- back out of it, because two tiers worth the same amount are still two
-- different things to have said about somebody, and a table that changes next
-- year must not rewrite what was decided this one.
ALTER TABLE pay_score ADD COLUMN tier REAL;
