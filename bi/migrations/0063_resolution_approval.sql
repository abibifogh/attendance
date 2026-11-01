-- A supervisor's "accept" settles nothing until an admin approves it: it waits,
-- like their other answers. An admin's applies at once. Rejected ones stay,
-- marked, so the decision can be read later.
ALTER TABLE till_resolution ADD COLUMN status TEXT NOT NULL DEFAULT 'applied';
ALTER TABLE till_resolution ADD COLUMN decided_by TEXT;
ALTER TABLE till_resolution ADD COLUMN decided_at TEXT;
