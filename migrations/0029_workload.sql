-- Shift intelligence: what this property considers a sustainable rota.
--
-- The rota screen answers "is anybody on Security on Sunday". It has never
-- been able to answer "has Kofi had a day off this fortnight", and that is the
-- question that ends with somebody handing in their notice — or, just as
-- expensively, with somebody quietly carried by colleagues who get every
-- weekend while they get none.
--
-- WHAT IS FIXED AND WHAT IS THIS PROPERTY'S OPINION
--
-- The first four are the law. Ghana's Labour Act 2003 (Act 651) sets eight
-- hours a day and forty a week (s.33, stretching to nine on a day where
-- another is shorter, s.34), twelve consecutive hours of rest between working
-- days (s.35), and forty-eight consecutive hours in every seven (s.36). They
-- are seeded here so a property can tighten them, and the app cites the
-- section wherever it reports one — a warning that names its authority is one
-- somebody can act on, and a bare number is one they argue with.
--
-- The rest are this trade's rules of thumb and genuinely arguable. Six days in
-- a row is where hotel practice puts the line; a property running four-on
-- four-off would say something different, and should be able to.
--
-- NOTHING HERE BLOCKS A ROTA. A hotel has nights when somebody simply has to
-- cover, and an app that refuses to record what happened gets worked around on
-- paper — at which point it knows nothing at all. It says so, loudly, names
-- the rule, and leaves the decision with whoever's name is on it.

INSERT OR IGNORE INTO settings (key, value) VALUES
  -- Act 651
  ('wl_dailyRestHours',      '12'),
  ('wl_weeklyRestHours',     '48'),
  ('wl_weeklyHours',         '40'),
  ('wl_dailyHours',          '9'),

  -- Practice
  ('wl_consecutiveDays',     '6'),
  ('wl_nightsPerFortnight',  '7'),
  ('wl_flipsPerFortnight',   '2'),
  ('wl_weekendsPerMonth',    '3');
