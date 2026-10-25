-- Nice Place: a reading (with its picture) put on the wrong day or shift can
-- be moved to the right one. Where it came from, who moved it and when.
ALTER TABLE np_reading ADD COLUMN moved_from TEXT;
ALTER TABLE np_reading ADD COLUMN moved_by TEXT;
ALTER TABLE np_reading ADD COLUMN moved_at TEXT;
