-- The job, as against the hours.
--
-- This property runs "Breakfast 06:00–14:00", "Breakfast 06:00–14:30" and
-- "Breakfast 06:00–15:00". Those are not three jobs. They are one job that
-- finishes at three different times, and they exist as separate shifts because
-- a shift is what lateness is measured against and the three finish at
-- different times.
--
-- That is right, and it makes the position view read as a list of near
-- duplicates. A position is the name of the job: several shifts point at one,
-- and the rota groups by it. Left null it means the shift is its own position,
-- which is the truth for most of them.
--
-- Free text rather than a table of its own, exactly like `department`, because
-- the alternative is a screen for maintaining a list of eleven words.
ALTER TABLE att_shifts ADD COLUMN position TEXT;

CREATE INDEX IF NOT EXISTS idx_att_shifts_position ON att_shifts (position);
