-- What to ask, written down before the interview rather than during it.
--
-- An interview here was a mark out of five and a paragraph. That is a record of
-- somebody's impression, and impressions of six candidates taken on six
-- different afternoons by three different people are not comparable, which is
-- the one thing a hiring decision needs them to be. It is also how a hotel ends
-- up hiring on how well somebody talked rather than on whether they can do the
-- job: the questions that actually separate a good room attendant from a poor
-- one are not the ones that come to mind while a nervous person is sitting
-- across the table.
--
-- So the questions are set out in advance, per kind of role, and every
-- candidate for that role is asked the same ones and marked on each. What
-- changes is the answer, not the question.
--
-- A SET BELONGS TO A KIND OF WORK, NOT TO A VACANCY. Reception is reception
-- whether the vacancy is opened in March or in November, so the set is written
-- once, named, and pointed at by whichever vacancies want it. Editing it later
-- does not disturb anything already marked: an answer keeps the question's
-- words as they stood when it was asked, because a score sheet that changes its
-- own questions afterwards is not a record of anything.
CREATE TABLE IF NOT EXISTS rec_pack (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  -- Which part of the house it is for. A word rather than a link, the same way
  -- every other department in this app is a word.
  department TEXT,
  note       TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_rec_pack_active ON rec_pack (active, name);

-- One question, and what a good answer to it sounds like.
--
-- The second half is the point of writing them down at all. Whoever sits in the
-- interview at a property this size is usually the head of the department
-- rather than anybody who interviews for a living, and "what does good look
-- like" is the part they are being asked to supply out of their own head at the
-- moment they can least afford to.
CREATE TABLE IF NOT EXISTS rec_question (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  pack_id  INTEGER NOT NULL REFERENCES rec_pack (id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  text     TEXT    NOT NULL,
  listen_for TEXT,
  active   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_rec_question_pack ON rec_question (pack_id, position);

-- Which set a vacancy uses. Null is what every vacancy opened before today has,
-- and it means what it always meant: a mark out of five and a paragraph.
ALTER TABLE rec_role ADD COLUMN pack_id INTEGER REFERENCES rec_pack (id) ON DELETE SET NULL;

-- One mark against one question, on one person's score sheet.
--
-- The question's words are copied in rather than only pointed at. A set edited
-- in six months must not rewrite what somebody was asked in March, and a
-- question deleted outright must not empty out the sheets that used it.
CREATE TABLE IF NOT EXISTS rec_answer (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  score_id    INTEGER NOT NULL REFERENCES rec_score (id) ON DELETE CASCADE,
  question_id INTEGER REFERENCES rec_question (id) ON DELETE SET NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  asked       TEXT    NOT NULL,
  mark        INTEGER,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_rec_answer_score ON rec_answer (score_id, position);

-- Which set was used, kept on the sheet for the same reason as the words.
ALTER TABLE rec_score ADD COLUMN pack_id INTEGER REFERENCES rec_pack (id) ON DELETE SET NULL;
ALTER TABLE rec_score ADD COLUMN pack_name TEXT;
