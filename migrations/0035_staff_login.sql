-- A login that belongs to a member of staff.
--
-- Every account until now has been somebody who runs the place: a supervisor,
-- a planner, an administrator. This is the other half of a rota system and the
-- half a hotel actually notices, because the alternative is a printed sheet on
-- a noticeboard and a photograph of it in a group chat, which is out of date
-- the moment anybody swaps a shift.
--
-- The link is a column rather than a table because it is one to one and
-- optional in both directions: a manager has no staff record to point at, and
-- most staff have no login. Nulled rather than cascaded when a staff record
-- goes, so the account survives to be looked at and closed deliberately —
-- deleting somebody's login as a side effect of tidying the staff list is how
-- an audit trail loses its owner.
ALTER TABLE users ADD COLUMN staff_id INTEGER REFERENCES att_staff (id) ON DELETE SET NULL;

-- One login per member of staff. Two accounts for the same person means two
-- sets of leave requests and no way to tell which is theirs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_staff ON users (staff_id) WHERE staff_id IS NOT NULL;
