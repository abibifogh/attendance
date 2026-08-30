-- Position, residency and reliefs, against the person rather than guessed at.
--
-- The GRA form asks three things about somebody that a payroll does not know.
-- They were being filled in by inference: the grade from whatever job title
-- att_staff happened to hold, everybody down as resident and full time, and
-- reliefs at nought for everyone.
--
-- Two of those are wrong often enough to matter. The grade on the return is
-- SENIOR, JUNIOR or MANAGEMENT, which is not the same thing as being a cook,
-- and somebody promoted in June has to be filed as what they are in June.
-- Reliefs are nought for most people and are not nought for anybody holding a
-- certificate the GRA has issued them.
--
-- Kept on the pay profile, beside the basic and the SSNIT flag, because that
-- is the record somebody opens when what a person is paid changes, and this
-- changes at the same time.
--
-- Null rather than a default for the two text ones, so that "nobody has said"
-- stays different from "somebody said this", and the reading the form had
-- before is what a null still falls back to.
ALTER TABLE pay_profile ADD COLUMN gra_position TEXT;
ALTER TABLE pay_profile ADD COLUMN gra_residency TEXT;
ALTER TABLE pay_profile ADD COLUMN gra_relief REAL NOT NULL DEFAULT 0;
