-- How many days a week the property expects of somebody.
--
-- The over-or-under is worked plus leave, less the working days the period
-- held, and until now "working days" meant Monday to Friday for everybody.
-- That is wrong in a hotel in both directions at once: the kitchen porter works
-- six shorter days, the maintenance man works four long ones, and measuring
-- both against five means one of them is permanently over and the other
-- permanently under for doing exactly what was asked of them.
--
-- So the expectation is a number of days per week, five by default, and it can
-- be set for one person where their contract says something else. Days rather
-- than hours because that is the unit the whole of this — leave, absence,
-- sign-off — is already counted in, and a system that charges leave in days
-- while measuring the debt in hours is a system nobody can check by hand.

-- The property's own answer, for everybody who has no answer of their own.
INSERT OR IGNORE INTO settings (key, value) VALUES ('att_days_per_week', '5');

-- And one person's, where it differs. Null means "whatever the property says",
-- which is what every row starts as and what almost all of them will stay.
ALTER TABLE att_staff ADD COLUMN days_per_week REAL;
