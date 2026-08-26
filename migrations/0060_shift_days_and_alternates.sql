-- ---------------------------------------------------------------------------
-- When a shift runs, and which shifts stand in for each other
--
-- Two facts about a shift that the rota has had to hold in somebody's head.
--
-- RUNS_ON. Not every shift runs every day. The craft shop is shut on Sunday
-- and the bar does not open on a Monday, and the only thing stopping either
-- appearing there was a person remembering. A JSON array of weekdays, Monday
-- as 0, matching how the standing pattern already numbers them. Null means
-- every day, which is what every shift meant before this column existed.
--
-- ALT_GROUP. Five breakfast shifts that differ only in when they finish are
-- five ways of saying the same morning. Exactly one of them runs on any given
-- day, and two of them on one day is a mistake nobody catches until the wages
-- are worked out. Shifts sharing a name here are alternatives to each other.
-- Null means the shift stands alone and clashes with nothing.
--
-- OPTIONAL. A shift worth running when there is somebody spare and not worth
-- pulling anybody off anything for. The draft fills every shift that has to be
-- covered first, across the whole window, and only then comes back for these
-- with whoever is left. One it could not fill is not a gap: it is the answer.
-- ---------------------------------------------------------------------------

ALTER TABLE att_shifts ADD COLUMN runs_on TEXT;
ALTER TABLE att_shifts ADD COLUMN alt_group TEXT;
ALTER TABLE att_shifts ADD COLUMN optional INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_shifts_alt ON att_shifts (alt_group) WHERE alt_group IS NOT NULL;
