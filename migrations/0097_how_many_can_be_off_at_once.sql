-- How many people may be off on one day.
--
-- A property can survive two or three people being away at once and cannot
-- survive eight, and nothing in the app knew that. Leave was answered one
-- request at a time, on whether that person could spare the days, with no view
-- of who else had already asked for the same Friday. The first anybody heard
-- about a Friday with nine people off was the Friday.
--
-- Three to begin with, because that is what this property runs on, and it is a
-- number on the Rules screen rather than one built into the code: a bigger
-- property will want five and a quiet week may want more.
--
-- It holds against what staff ask for and not against what a planner writes.
-- Somebody writing leave on another person's behalf can see the whole week and
-- is the person who would have approved it; a member of staff cannot see who
-- else has asked, which is exactly why the app has to hold the line for them.
INSERT INTO settings (key, value) VALUES ('att_away_cap', '3')
  ON CONFLICT (key) DO NOTHING;
