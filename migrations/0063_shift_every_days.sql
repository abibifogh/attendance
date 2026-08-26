-- ---------------------------------------------------------------------------
-- A shift with a day's break in between
--
-- The deep clean, the linen run, the pool treatment: work that is wanted often
-- but not two days running, because the point of it is the day in between. A
-- rota built by hand spaces these without thinking about it and a draft does
-- not, so it put the deep clean on Monday, Tuesday and Wednesday and left
-- Thursday to Sunday clear.
--
-- The number of days from one running of the shift to the next: 2 for every
-- other day, 3 for every third. Null is the ordinary case, a shift that may
-- run on any day it is otherwise wanted.
--
-- Deliberately a gap rather than a fixed cadence from an anchor date. An
-- anchor is a thing somebody has to maintain, and it goes wrong the first time
-- a day is skipped for Christmas.
-- ---------------------------------------------------------------------------

ALTER TABLE att_shifts ADD COLUMN every_days INTEGER;
