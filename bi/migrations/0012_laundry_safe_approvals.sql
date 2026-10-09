-- Three things for the Shifts screen.

-- ------------------------------------------------------- the laundry, by shift --
--
-- The laundry system's own payments and orders, one row each, so the front
-- desk's laundry in ASSD can be held against the laundry system shift by shift
-- rather than only day by day. A payment is placed in a shift by the moment it
-- was taken; an order by the moment it was accepted. Only the order number,
-- the time and the money are kept: no guest names.
CREATE TABLE IF NOT EXISTS laundry_txn (
  source_id TEXT    NOT NULL,
  kind      TEXT    NOT NULL,          -- payment | order
  ref       TEXT    NOT NULL,          -- the laundry's order number
  at        TEXT    NOT NULL,          -- 'YYYY-MM-DD HH:MM:SS', Accra time
  day       TEXT    NOT NULL,
  amount    INTEGER NOT NULL,          -- pesewas
  method    TEXT,                      -- cash | card, for a payment
  PRIMARY KEY (source_id, kind, ref, at)
);
CREATE INDEX IF NOT EXISTS idx_laundry_txn_at ON laundry_txn (at);

-- ------------------------------------------- a supervisor's answers wait --
--
-- An answer to an exception, or a set of exceptions reconciled together, is
-- what takes it off the list. From a supervisor that now waits for an admin,
-- the way a supervisor's movement correction already does. An admin's own
-- answers apply at once. Everything already stored is applied.
ALTER TABLE shift_answer ADD COLUMN status TEXT NOT NULL DEFAULT 'applied';
ALTER TABLE shift_answer ADD COLUMN decided_by TEXT;
ALTER TABLE shift_answer ADD COLUMN decided_at TEXT;
ALTER TABLE shift_link ADD COLUMN status TEXT NOT NULL DEFAULT 'applied';
ALTER TABLE shift_link ADD COLUMN decided_by TEXT;
ALTER TABLE shift_link ADD COLUMN decided_at TEXT;

-- ------------------------------------------------------------- the safe --
--
-- Cash goes into the safe shift by shift, in envelopes. Every so often an
-- admin and a supervisor close the safe together: they tick the shifts whose
-- envelopes they have dealt with, and record how much cash was taken out of
-- the safe after that closure.
CREATE TABLE IF NOT EXISTS safe_closure (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  closed_on  TEXT    NOT NULL,             -- the day it was closed
  with_name  TEXT,                         -- who closed it with the admin
  assd       INTEGER NOT NULL DEFAULT 0,   -- what ASSD moved to the safe, these shifts
  envelopes  INTEGER NOT NULL DEFAULT 0,   -- what the envelopes said, these shifts
  taken      INTEGER,                      -- cash taken out of the safe after the closure
  note       TEXT,
  by_name    TEXT,
  at         TEXT    NOT NULL
);

-- Which shifts each closure dealt with. A shift is closed once.
CREATE TABLE IF NOT EXISTS safe_closure_shift (
  day        TEXT    NOT NULL,
  slot       TEXT    NOT NULL,
  closure_id INTEGER NOT NULL REFERENCES safe_closure (id) ON DELETE CASCADE,
  assd       INTEGER NOT NULL DEFAULT 0,
  envelopes  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, slot)
);
CREATE INDEX IF NOT EXISTS idx_safe_closure_shift ON safe_closure_shift (closure_id);
