-- Recruitment: from a name on a scrap of paper to somebody with a contract.
--
-- The gap this fills is the one before People starts. Everything in this app
-- assumes somebody is already on the books; how they got there was a folder of
-- CVs, a WhatsApp group and somebody's memory of who was coming in on Thursday.
--
-- FOUR IDEAS RUN THROUGH IT.
--
-- A CANDIDATE IS NOT A MEMBER OF STAFF, and nothing in here writes to
-- att_staff. Taking somebody on is one deliberate press with an employee
-- number typed into it, and it is the only door between the two. A pipeline
-- that quietly creates people would put strangers on the payroll.
--
-- THE CANDIDATE PICKS THE TIME. The property publishes when it is free and the
-- person chooses; a time somebody was told to attend is a time half of them
-- cannot make, and the phone call that follows is the whole cost of the
-- exercise.
--
-- EVERY MOVE IS WRITTEN DOWN. Who shortlisted, who turned somebody down and
-- why, who offered, who took them on. Hiring decisions are the ones asked
-- about a year later.
--
-- AND NOTHING IS DELETED. Somebody not taken on this time is somebody to ring
-- when the next vacancy opens, which is the single most useful thing a small
-- property's recruitment records can do for it.

-- ---------------------------------------------------------------------------
-- A vacancy
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rec_role (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  department  TEXT,
  -- How many of them are wanted. A property hires three room attendants at
  -- once far more often than it hires one of anything.
  headcount   INTEGER NOT NULL DEFAULT 1,
  status      TEXT    NOT NULL DEFAULT 'open',   -- open | on_hold | filled | closed
  -- Whoever the applications belong to. A name rather than a login, because
  -- the person who wants the room attendant may not have an account.
  hiring_for  TEXT,
  employment  TEXT,                              -- permanent | fixed | casual | temporary
  detail      TEXT,
  opened_on   TEXT    NOT NULL DEFAULT (date('now')),
  needed_by   TEXT,
  closed_on   TEXT,
  created_by  TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_rec_role_status ON rec_role (status, opened_on DESC);

-- ---------------------------------------------------------------------------
-- Somebody who wants the job
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rec_candidate (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- A vacancy can be closed while somebody is still in the pipeline against
  -- it, so this is set null rather than cascading: losing the candidate would
  -- lose the record of why they were turned down.
  role_id      INTEGER REFERENCES rec_role (id) ON DELETE SET NULL,
  name         TEXT    NOT NULL,
  phone        TEXT,
  email        TEXT,
  -- Where they came from. Worth a column of its own: after a year it is the
  -- answer to "which of the things we do to find people actually works".
  source       TEXT,                             -- walk_in | referral | agency | advert | online | other
  referred_by  TEXT,
  stage        TEXT    NOT NULL DEFAULT 'applied',
  -- applied | shortlisted | interview | offer | hired | declined | not_taken
  outcome      TEXT,                             -- why not taken, or why they said no
  applied_on   TEXT    NOT NULL DEFAULT (date('now')),
  -- Set the moment they become a member of staff, and never unset. It is the
  -- join between the two halves of somebody's history here.
  staff_id     INTEGER REFERENCES att_staff (id) ON DELETE SET NULL,
  hired_on     TEXT,
  note         TEXT,
  created_by   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_rec_candidate_role  ON rec_candidate (role_id, stage);
CREATE INDEX IF NOT EXISTS idx_rec_candidate_stage ON rec_candidate (stage, applied_on DESC);

-- ---------------------------------------------------------------------------
-- When the property is free, and who took which one
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rec_slot (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Slots are published against a vacancy, so a candidate for one job is never
  -- shown the times set aside for another.
  role_id      INTEGER REFERENCES rec_role (id) ON DELETE CASCADE,
  day          TEXT    NOT NULL,                 -- YYYY-MM-DD
  starts_at    TEXT    NOT NULL,                 -- HH:MM, the property's own clock
  minutes      INTEGER NOT NULL DEFAULT 30,
  place        TEXT,
  interviewer  TEXT,
  -- Null means free. The claim is a conditional update on this column, which
  -- is what stops two candidates taking the same half hour.
  candidate_id INTEGER REFERENCES rec_candidate (id) ON DELETE SET NULL,
  taken_at     TEXT,
  -- 'them' where the candidate chose it, or the name of whoever booked it on
  -- the phone. Worth keeping: it is the difference between a time somebody
  -- picked and a time somebody was given.
  taken_by     TEXT,
  cancelled_at TEXT,
  created_by   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rec_slot_day  ON rec_slot (day, starts_at);
CREATE INDEX IF NOT EXISTS idx_rec_slot_role ON rec_slot (role_id, day);

-- ---------------------------------------------------------------------------
-- What the interviewer thought
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rec_score (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES rec_candidate (id) ON DELETE CASCADE,
  slot_id      INTEGER REFERENCES rec_slot (id) ON DELETE SET NULL,
  rating       INTEGER,                          -- 1..5
  recommend    TEXT,                             -- yes | maybe | no
  note         TEXT,
  scored_by    TEXT,
  at           TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rec_score_candidate ON rec_score (candidate_id, at);

-- ---------------------------------------------------------------------------
-- A CV, before there is a record to hang it on
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rec_file (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES rec_candidate (id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL DEFAULT 'cv',    -- cv | certificate | reference | other
  title        TEXT    NOT NULL,
  filename     TEXT,
  mime         TEXT    NOT NULL,
  bytes        INTEGER NOT NULL,
  content      BLOB    NOT NULL,
  uploaded_by  TEXT,
  uploaded_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rec_file_candidate ON rec_file (candidate_id, kind);

-- ---------------------------------------------------------------------------
-- The link they open
-- ---------------------------------------------------------------------------

-- The same shape as an employee's link, and for the same reasons: shown once,
-- stored as a hash, expiring, cancellable, with an optional four digits told
-- to the person out loud. A candidate has no account and never will have one
-- unless they are taken on.
CREATE TABLE IF NOT EXISTS rec_invite (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id  INTEGER NOT NULL REFERENCES rec_candidate (id) ON DELETE CASCADE,
  token_hash    TEXT    NOT NULL UNIQUE,
  pin_hash      TEXT,
  message       TEXT,
  -- What the link is for. A link that only confirms a phone number should not
  -- be showing the interview diary.
  wants_slot    INTEGER NOT NULL DEFAULT 1,
  wants_details INTEGER NOT NULL DEFAULT 1,
  wants_cv      INTEGER NOT NULL DEFAULT 1,
  expires_at    TEXT    NOT NULL,
  created_by    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  opened_at     TEXT,
  revoked_at    TEXT,
  revoked_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_rec_invite_candidate ON rec_invite (candidate_id, created_at);

-- ---------------------------------------------------------------------------
-- The trail
-- ---------------------------------------------------------------------------

-- Everything that happened to one candidate, in one place and in order: moved
-- a stage, sent a link, opened it, chose a time, was scored, was taken on.
-- A hiring decision questioned a year later is answered off this table.
CREATE TABLE IF NOT EXISTS rec_event (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES rec_candidate (id) ON DELETE CASCADE,
  invite_id    INTEGER REFERENCES rec_invite (id) ON DELETE SET NULL,
  kind         TEXT    NOT NULL,
  -- Only set on a stage move, so the trail reads as a history rather than as a
  -- list of notes.
  from_stage   TEXT,
  to_stage     TEXT,
  detail       TEXT,
  actor        TEXT,
  ip           TEXT,
  agent        TEXT,
  at           TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rec_event_candidate ON rec_event (candidate_id, id);

-- How long an interview link lasts. Shorter than an employee's by default: it
-- carries a diary, and a diary three weeks old is offering times that have
-- been and gone.
INSERT OR IGNORE INTO settings (key, value) VALUES ('rec_link_days', '10');

-- What an interview is worth of the diary, when somebody publishes a morning
-- of them and does not say.
INSERT OR IGNORE INTO settings (key, value) VALUES ('rec_slot_minutes', '30');

-- Where they are held, printed on the invitation so nobody has to ask.
INSERT OR IGNORE INTO settings (key, value) VALUES ('rec_place', '');
