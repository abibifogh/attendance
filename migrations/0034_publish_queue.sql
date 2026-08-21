-- Two different words for a dashed cell.
--
-- A day nobody has ever published is new: staff have not been told about it
-- and nothing they planned around is changing. A day that was published and
-- then edited is a broken promise being remade, and it is the one a planner
-- wants counted separately before they press the button. Humanity draws the
-- same line and calls them Publish and Republish, which is the right pair of
-- words for it.
ALTER TABLE att_roster ADD COLUMN ever_published INTEGER NOT NULL DEFAULT 0;

-- Everything currently published has, by definition, been published.
UPDATE att_roster SET ever_published = 1 WHERE published = 1;

-- An optional name for one particular shift on one particular day.
--
-- The shift says what hours somebody works. This says what they are doing in
-- them: "Stock take", "Cover for Ama", "Conference set-up". Optional on
-- purpose — most days do not need one, and a rota where every cell carries a
-- caption is a rota nobody reads.
ALTER TABLE att_roster ADD COLUMN title TEXT;
