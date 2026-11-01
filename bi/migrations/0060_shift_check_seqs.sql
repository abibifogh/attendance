-- A checked shift is locked: nothing on it changes until it is unchecked.
-- Its ASSD lines, first to last, so a change named only by a line (a card
-- line, a cash movement) is known to be on it. Filled in when the shift is
-- read on the Shifts screen, and when it is checked from there.
ALTER TABLE shift_check ADD COLUMN start_seq INTEGER;
ALTER TABLE shift_check ADD COLUMN end_seq INTEGER;
