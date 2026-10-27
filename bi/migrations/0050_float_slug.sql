-- A short link for each person holding a float: /float/igna. The first four
-- letters of their name unless an admin changes it. Given on first use for
-- anybody already here; their long link (?t=) works until it is changed.
ALTER TABLE float_person ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_float_person_slug ON float_person (slug) WHERE slug IS NOT NULL;
