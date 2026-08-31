-- A panel is more than one person.
--
-- An interview at a property this size is the head of department and whoever
-- runs the place, sitting in together. One interviewer per slot meant one of
-- them was named and told and the other found out when somebody walked past
-- reception.
--
-- So a slot names as many as it needs to. The typed name stays on rec_slot and
-- is still what prints - it is now the list written out, or a free-text name
-- for somebody who is not on the books at all - and the people are here.

CREATE TABLE IF NOT EXISTS rec_slot_panel (
  slot_id  INTEGER NOT NULL REFERENCES rec_slot (id) ON DELETE CASCADE,
  staff_id INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  -- Who put them on it, because being taken off a panel by somebody else is
  -- the sort of thing that gets asked about the morning it goes wrong.
  added_by TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (slot_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_rec_panel_staff ON rec_slot_panel (staff_id, slot_id);

-- Everybody already named, carried across, so a diary published last week
-- keeps its interviewer and keeps getting told.
INSERT OR IGNORE INTO rec_slot_panel (slot_id, staff_id, added_by)
  SELECT id, interviewer_staff_id, created_by
    FROM rec_slot
   WHERE interviewer_staff_id IS NOT NULL;

-- And the single column goes, rather than lingering with data nothing reads.
-- A second place a panel could be recorded is a second place for the two to
-- disagree.
DROP INDEX IF EXISTS idx_rec_slot_interviewer;
ALTER TABLE rec_slot DROP COLUMN interviewer_staff_id;

-- The default that fills the publish form is a list now. Stored as JSON, the
-- way the staff record already stores which departments somebody can work in.
INSERT OR IGNORE INTO settings (key, value) VALUES ('rec_panel', '');
