-- Asking staff to order lunch when the list opens, and reminding whoever has
-- not answered before it shuts.

-- One row per person per week asked: when they were asked and reminded, and
-- the fingerprint of the personal link texted to somebody without the app.
CREATE TABLE IF NOT EXISTS lunch_ask (
  monday       TEXT    NOT NULL,
  staff_id     INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  token_hash   TEXT,
  asked_at     TEXT,
  asked_how    TEXT,
  reminded_at  TEXT,
  PRIMARY KEY (monday, staff_id)
);
CREATE INDEX IF NOT EXISTS lunch_ask_token ON lunch_ask (token_hash);

INSERT OR IGNORE INTO settings (key, value) VALUES ('lunch_ask_on', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('lunch_ask_at', '08:00');
INSERT OR IGNORE INTO settings (key, value) VALUES ('lunch_remind_hours', '6');
INSERT OR IGNORE INTO settings (key, value) VALUES ('lunch_ask_text', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('lunch_ask_cc', '0');
-- Staff who do not take lunch: never asked, never reminded, never chased.
INSERT OR IGNORE INTO settings (key, value) VALUES ('lunch_ask_skip', '[]');
