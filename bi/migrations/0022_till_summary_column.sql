-- The daily till summary is chosen on its own, beside "Shift closed": one
-- person may want every shift as it closes, another only the morning round-up.
-- Whoever had "Shift closed" ticked keeps getting the summary too.
ALTER TABLE till_notify ADD COLUMN on_summary INTEGER NOT NULL DEFAULT 1;
UPDATE till_notify SET on_summary = on_closed;
