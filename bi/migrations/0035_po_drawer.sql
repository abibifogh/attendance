-- ------------------------------- A PO made in Insight, paid from a drawer --

-- A PO made from Insight's Create PO is not a shift's expense until an admin
-- allows it: ticked when it is made, or allowed (or refused) when a member of
-- staff first tries to put it on a shift, which asks for it.
ALTER TABLE po_created ADD COLUMN drawer_ok INTEGER;      -- NULL undecided, 1 allowed, 0 refused
ALTER TABLE po_created ADD COLUMN drawer_by TEXT;
ALTER TABLE po_created ADD COLUMN drawer_at TEXT;
ALTER TABLE po_created ADD COLUMN drawer_note TEXT;
ALTER TABLE po_created ADD COLUMN asked_by TEXT;          -- who tried to put it on a shift
ALTER TABLE po_created ADD COLUMN asked_at TEXT;
