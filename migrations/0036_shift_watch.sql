-- Which nudges have already gone out.
--
-- The watcher runs every quarter of an hour, so without a record of what it
-- has already said it would tell the same person their shift started, every
-- fifteen minutes, until they clocked in — which is how somebody learns to
-- turn notifications off, and then the one that mattered does not arrive
-- either. One row per person per day per kind, and the primary key is the
-- whole rule.
CREATE TABLE IF NOT EXISTS att_nudge (
  staff_id INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  day      TEXT    NOT NULL,
  kind     TEXT    NOT NULL,
  at       TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (staff_id, day, kind)
);

-- Whether the app tells somebody their shift has started and nothing has been
-- recorded. On by default: it is the one push that saves a shift rather than
-- reporting on one. A property that finds it fussy can turn it off.
INSERT OR IGNORE INTO settings (key, value) VALUES ('att_late_nudge', '1');
