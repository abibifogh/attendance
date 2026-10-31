-- Whether the shift's counts and answers were carried with it: not when one
-- ASSD session was taken out of a shift it had been joined to. Put it back
-- carries them back only when they came.
ALTER TABLE shift_place ADD COLUMN carried INTEGER NOT NULL DEFAULT 1;
