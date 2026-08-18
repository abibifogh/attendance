-- Signing off day by day, and asking somebody before you do.
--
-- Sign-off already worked on any span — a day, a week, a month, or a range
-- picked by hand. Two things were missing, and both are about the awkward
-- cases rather than the easy ones.
--
-- CHOOSING WHAT TO INCLUDE
-- A month with three days nobody can explain used to be all-or-nothing: sign
-- the lot, or leave twenty-eight settled days waiting on three. So a sign-off
-- can now leave days out. They stay outstanding and can be dealt with on their
-- own afterwards.
--
-- That changes the rule about overlaps. It was "no two signed spans may share a
-- day", enforced on the raw dates. It is now "no two signed spans may share a
-- day either of them actually signed" — otherwise signing the three excluded
-- days later would be refused by the month that deliberately left them out.
-- The comparison moved out of SQL and into code for exactly this reason.
--
-- ASKING FIRST
-- Whoever builds the rota can sign a period off, and often should not. A run of
-- lateness or an absence nobody has explained is a question for somebody senior
-- before it becomes a charge against leave. So there is a second answer beside
-- "sign it": raise it, say why, and it lands in a queue where an administrator
-- can look, sign it themselves, or send it back with a direction.

-- Days inside the span that were deliberately not signed. A JSON array of
-- dates, empty or null where the whole span was signed — which is the common
-- case and costs nothing to store.
ALTER TABLE att_period_review ADD COLUMN excluded_days TEXT;

-- Whether the person signing knew there was something wrong and went ahead. A
-- sign-off over a known problem is a decision, and worth telling apart from one
-- where there was nothing to notice.
ALTER TABLE att_period_review ADD COLUMN issues TEXT;

-- ---------------------------------------------------------------------------
-- Questions raised on a period
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS att_query (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id    INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  from_day    TEXT    NOT NULL,
  to_day      TEXT    NOT NULL,
  -- Which days the question is actually about, where it is not the whole span.
  days        TEXT,
  -- What the figures looked like when it was raised, so the queue can be read
  -- without recomputing a month for every row in it.
  issues      TEXT,
  reason      TEXT,

  status      TEXT    NOT NULL DEFAULT 'open',  -- open | answered | resolved | withdrawn
  raised_by   TEXT    NOT NULL,
  raised_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  closed_by   TEXT,
  closed_at   TEXT,
  outcome     TEXT,   -- signed | returned | withdrawn | no_action

  UNIQUE (staff_id, from_day, to_day, status)
);
CREATE INDEX IF NOT EXISTS idx_att_query_open ON att_query (status, raised_at);
CREATE INDEX IF NOT EXISTS idx_att_query_staff ON att_query (staff_id, from_day);

-- The conversation on a question. Append-only: an answer that can be edited
-- afterwards is not an answer anybody can rely on having been given.
CREATE TABLE IF NOT EXISTS att_query_note (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  query_id INTEGER NOT NULL REFERENCES att_query (id) ON DELETE CASCADE,
  kind     TEXT    NOT NULL DEFAULT 'comment',  -- comment | direction | decision
  body     TEXT    NOT NULL,
  author   TEXT    NOT NULL,
  at_utc   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_att_query_note ON att_query_note (query_id, id);
