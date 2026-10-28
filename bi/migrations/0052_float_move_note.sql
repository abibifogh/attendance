-- A note on money given (or given back), added when it is given or later by
-- an admin, shown on the person's page and their statement. Who wrote or last
-- changed it, and when.
ALTER TABLE float_move ADD COLUMN note_by TEXT;
ALTER TABLE float_move ADD COLUMN note_at TEXT;
