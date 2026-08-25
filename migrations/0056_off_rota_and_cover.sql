-- Two things the rota could not be told.
--
-- WHO IS NOT ON IT. A property has people who are paid, clock in, take leave
-- and never appear on a rota: the manager, the accountant, the owner's driver.
-- They were a row on the grid like everybody else, twenty-eight blank cells
-- wide, and every screen built on the rota counted them as somebody with
-- nothing on. Marking them takes them off the grid, out of the cover counts,
-- off the workload list and out of the draft — and leaves their attendance,
-- their leave and their pay exactly as they were, because none of that was
-- ever about the rota.
ALTER TABLE att_staff ADD COLUMN on_rota INTEGER NOT NULL DEFAULT 1;

-- HOW MANY PEOPLE A SHIFT WANTS. The draft aimed at what the property usually
-- did, read off the weeks behind it — which answers well for a shift that has
-- been running for a month and not at all for one that has not. A third
-- reception shift added on Tuesday has no history, so the median was nought,
-- so the draft skipped it silently and nobody found out until Saturday night.
--
-- Null still means "read it from what we usually do", which is right for most
-- shifts and is what every existing one keeps. A number means the draft aims
-- at that many every day it runs, and says plainly when it could not find
-- them.
ALTER TABLE att_shifts ADD COLUMN needed INTEGER;
