-- The birthday message, in the property's own words.
--
--   May your day be as remarkable and bright as you are. Cheers to another
--   great year ahead, from all of us here at {property}.
--
-- Set as the property's wording, where the screen under Setup keeps it, so it
-- can still be changed there like any other. {property} is filled with the
-- property's name when the card, the notice and the email are made.
INSERT INTO settings (key, value) VALUES (
  'att_bd_line',
  'May your day be as remarkable and bright as you are. Cheers to another great year ahead, from all of us here at {property}.'
)
ON CONFLICT (key) DO UPDATE SET value = excluded.value;
