-- Every saved version of a template, so a save made over somebody's edits
-- (another tab, another phone) can be undone, and the words as they stood
-- on any day can be read back.
CREATE TABLE IF NOT EXISTS hr_template_rev (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES hr_template (id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  saved_by    TEXT,
  saved_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS hr_template_rev_of ON hr_template_rev (template_id, id);

-- Each template as it stands today is its first kept version.
INSERT INTO hr_template_rev (template_id, version, name, body, saved_by, saved_at)
SELECT id, COALESCE(version, 1), name, body, 'As it stood when history began', COALESCE(updated_at, datetime('now'))
  FROM hr_template;
