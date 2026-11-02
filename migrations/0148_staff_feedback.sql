-- Staff feedback: a short survey every quarter, read and summarised when it
-- closes, with what the property is doing about it sent back to everybody.
--
-- Names are kept with answers unless a round is anonymous. An anonymous round
-- stores no name with an answer at all (only, separately, that somebody has
-- answered, so the reminders stop), and staff are told so on the survey.

CREATE TABLE IF NOT EXISTS fb_question (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  area        TEXT    NOT NULL,
  text        TEXT    NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'scale' CHECK (kind IN ('scale', 'recommend', 'text')),
  sort_order  INTEGER NOT NULL DEFAULT 100,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fb_round (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  label        TEXT    NOT NULL,             -- "October 2026"
  opens_on     TEXT    NOT NULL,
  closes_on    TEXT    NOT NULL,             -- the last day answers are taken
  anonymous    INTEGER NOT NULL DEFAULT 0,   -- fixed when the round opens
  status       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  questions    TEXT    NOT NULL,             -- the questions as they were asked, JSON
  asked        INTEGER NOT NULL DEFAULT 0,   -- how many were asked
  analysis     TEXT,                         -- the summary, JSON
  analysed_at  TEXT,
  analysed_by  TEXT,                         -- 'ai' or 'plain'
  said_at      TEXT,                         -- when You said, we did went out
  opened_by    TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fb_response (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id     INTEGER NOT NULL REFERENCES fb_round (id) ON DELETE CASCADE,
  staff_id     INTEGER REFERENCES att_staff (id) ON DELETE SET NULL,  -- null in an anonymous round
  department   TEXT,
  answers      TEXT    NOT NULL,             -- {questionId: {score, choice, comment}}
  submitted_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS fb_response_round ON fb_response (round_id);

-- Who has answered, so reminders stop. Never joined to an answer.
CREATE TABLE IF NOT EXISTS fb_done (
  round_id  INTEGER NOT NULL REFERENCES fb_round (id) ON DELETE CASCADE,
  staff_id  INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  at        TEXT    NOT NULL DEFAULT (date('now')),
  PRIMARY KEY (round_id, staff_id)
);

-- You said, we did.
CREATE TABLE IF NOT EXISTS fb_action (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id    INTEGER NOT NULL REFERENCES fb_round (id) ON DELETE CASCADE,
  status      TEXT    NOT NULL DEFAULT 'doing' CHECK (status IN ('doing', 'done', 'looking', 'keeping')),
  title       TEXT    NOT NULL,
  body        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  created_by  TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('feedback_on', '1'),
  ('feedback_months', '1,4,7,10'),
  ('feedback_open_days', '12'),
  ('feedback_anonymous', '0'),
  ('feedback_min_group', '5'),
  ('feedback_supervisors', '1'),
  ('feedback_min_service_days', '30');

-- The first questions. Fixed ids, so running this again adds nothing.
INSERT OR IGNORE INTO fb_question (id, area, text, kind, sort_order) VALUES (1, 'How it feels', 'All things considered, how do you feel about working here?', 'scale', 10);
INSERT OR IGNORE INTO fb_question (id, area, text, kind, sort_order) VALUES (2, 'Workload and the rota', 'Is your workload fair for the hours you are paid for?', 'scale', 20);
INSERT OR IGNORE INTO fb_question (id, area, text, kind, sort_order) VALUES (3, 'Your supervisor', 'Does your supervisor treat you fairly and listen to you?', 'scale', 30);
INSERT OR IGNORE INTO fb_question (id, area, text, kind, sort_order) VALUES (4, 'Conditions and equipment', 'Do you have what you need to do your job well?', 'scale', 40);
INSERT OR IGNORE INTO fb_question (id, area, text, kind, sort_order) VALUES (5, 'Safety and getting home', 'Do you feel safe at work and getting home after your shift?', 'scale', 50);
INSERT OR IGNORE INTO fb_question (id, area, text, kind, sort_order) VALUES (6, 'Pay and benefits', 'Do you feel fairly paid for the work you do?', 'scale', 60);
INSERT OR IGNORE INTO fb_question (id, area, text, kind, sort_order) VALUES (7, 'Growth and training', 'Are you learning and getting the chance to grow here?', 'scale', 70);
INSERT OR IGNORE INTO fb_question (id, area, text, kind, sort_order) VALUES (8, 'The team', 'Do the people you work with help each other?', 'scale', 80);
INSERT OR IGNORE INTO fb_question (id, area, text, kind, sort_order) VALUES (9, 'Lunch and food', 'How is the staff lunch?', 'scale', 90);
INSERT OR IGNORE INTO fb_question (id, area, text, kind, sort_order) VALUES (10, 'Recommend', 'Would you tell a friend to work here?', 'recommend', 100);
INSERT OR IGNORE INTO fb_question (id, area, text, kind, sort_order) VALUES (11, 'Open', 'What is one thing we should start, stop or keep doing?', 'text', 110);
