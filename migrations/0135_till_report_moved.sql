-- A closing report moved to another shift from Insight: where it was, who
-- moved it, when, and why. Kept on the report so the move can be read, and
-- undone by moving it back. The latest move only: moving it back is a move.
ALTER TABLE till_report ADD COLUMN moved_from TEXT;
ALTER TABLE till_report ADD COLUMN moved_by TEXT;
ALTER TABLE till_report ADD COLUMN moved_at TEXT;
ALTER TABLE till_report ADD COLUMN moved_reason TEXT;
