-- Each save of a template is a version, so the office can see which one a
-- contract was issued from. Formatting counts: it is part of what is signed.
ALTER TABLE hr_template ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
