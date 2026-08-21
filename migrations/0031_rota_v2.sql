-- The rota grows up: published or not, availability, and tags.
--
-- PUBLISHED IS A PROMISE. Until now saving the rota and telling people about
-- it were the same event, which meant a planner could not think out loud — the
-- moment a cell changed, that was the rota. A draft is now saved as unpublished
-- and shown with a broken border; Publish turns the fortnight solid, stamps it,
-- and rings the bell. The distinction Humanity draws, and the right one: what
-- the planner is still deciding and what staff may plan their lives around are
-- different documents that happen to share a grid.
ALTER TABLE att_roster ADD COLUMN published INTEGER NOT NULL DEFAULT 0;

-- Everything already on the rota was worked to, told to people, printed and
-- pinned up. It is published in every sense that matters, and marking it
-- otherwise would dash-border a year of settled history.
UPDATE att_roster SET published = 1;

CREATE TABLE IF NOT EXISTS rota_publish (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  from_day  TEXT    NOT NULL,
  to_day    TEXT    NOT NULL,
  changes   INTEGER NOT NULL DEFAULT 0,
  actor     TEXT,
  at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- WHEN SOMEBODY CANNOT WORK. Not leave — leave is approved absence that costs
-- an entitlement. This is "my daughter's graduation is on the 14th", recorded
-- so the planner sees it in the cell before rostering over it, and rostering
-- over it is still possible: the mark stays put and reads as a conflict, and
-- some conflicts are deliberate.
CREATE TABLE IF NOT EXISTS att_availability (
  staff_id  INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  day       TEXT    NOT NULL,
  -- 'unavailable' is the one that matters. 'preferred' is the other thing
  -- people actually say — "I want the Friday" — kept so the planner sees it.
  status    TEXT    NOT NULL DEFAULT 'unavailable',
  note      TEXT,
  set_by    TEXT,
  set_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (staff_id, day)
);

-- TAGS. "keyholder", "trainee", "speaks French" — the facts a planner filters
-- by that are not a department. A JSON array of short strings, free-form on
-- purpose: a fixed vocabulary would be somebody's guess at what matters here.
ALTER TABLE att_staff ADD COLUMN tags TEXT;
