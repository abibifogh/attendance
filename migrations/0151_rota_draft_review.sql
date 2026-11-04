-- A weekly deadline for the draft rota, reminders to whoever plans it with a
-- copy to the administrators, and a review before it goes out.

CREATE TABLE IF NOT EXISTS rota_review (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  day_from      TEXT    NOT NULL,              -- the first day of what was sent
  day_to        TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'sent'
                CHECK (status IN ('sent', 'approved', 'returned', 'replaced')),
  note          TEXT,                          -- what the planner said with it
  reviewers     TEXT,                          -- JSON list of user ids asked
  sent_by       TEXT    NOT NULL,
  sent_by_user  INTEGER,
  sent_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  decided_by    TEXT,
  decided_at    TEXT,
  decision_note TEXT
);
CREATE INDEX IF NOT EXISTS rota_review_days ON rota_review (day_from, day_to, status);

-- Which reminder went out for which week, so a cron that fires twice tells nobody twice.
CREATE TABLE IF NOT EXISTS rota_draft_nudge (
  week_start TEXT NOT NULL,
  step       TEXT NOT NULL,
  sent_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (week_start, step)
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('rota_draft_on', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('rota_draft_due_dow', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('rota_draft_due_time', '17:00');
INSERT OR IGNORE INTO settings (key, value) VALUES ('rota_draft_first_days', '3');
INSERT OR IGNORE INTO settings (key, value) VALUES ('rota_draft_first_time', '10:00');
INSERT OR IGNORE INTO settings (key, value) VALUES ('rota_draft_last_hours', '3');
INSERT OR IGNORE INTO settings (key, value) VALUES ('rota_draft_weeks_ahead', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('rota_draft_cc_admins', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('rota_review_by', '[]');
