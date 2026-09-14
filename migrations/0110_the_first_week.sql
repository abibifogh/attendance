-- The first week.
--
-- A new hire's first day at a hotel is a person being walked round by whoever
-- happens to be free, told six things they will not remember, and handed a
-- uniform. What they signed, what they were shown and what they were told is
-- afterwards a matter of whose memory you ask — which is exactly the question
-- that matters when something goes wrong in month three.
--
-- ORCHESTRATION, NOT A SECOND COPY. Almost everything a new hire has to do
-- already exists in this app: a contract to sign, handbook chapters to read and
-- acknowledge, documents to put on file, their own details to send in. None of
-- that is duplicated here. A step names where the proof lives and the answer is
-- read from there, so a contract signed on the Contracts tab ticks itself off
-- and cannot be ticked off by hand while unsigned.
--
-- What is genuinely new is the rest of a first week, which no table in this app
-- knew about: the tour, the uniform, the face on the terminal, the introduction
-- to the head of department, the fire exits. Those are ticked by a person,
-- because a person is the only thing that can know they happened.

CREATE TABLE IF NOT EXISTS ob_step (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Stable across a reload of the standard set, the same way a handbook
  -- chapter and a letter template are.
  code        TEXT    NOT NULL UNIQUE,
  title       TEXT    NOT NULL,
  detail      TEXT,

  -- Where the proof of this step lives.
  --   manual     somebody ticks it, and their name goes against it
  --   details    the person has sent their own particulars in and they were
  --              accepted
  --   contract   a contract has been issued and signed
  --   handbook   nothing in the handbook is still waiting on them
  --   documents  every document their file requires is held and unexpired
  -- Anything not recognised is treated as manual, which is the harmless answer:
  -- worst case somebody ticks by hand what could have ticked itself.
  source      TEXT    NOT NULL DEFAULT 'manual',

  -- Who a manual step is waiting on, which decides whose list it appears at the
  -- top of. It says nothing about who may tick it: only the office may.
  owner       TEXT    NOT NULL DEFAULT 'office',   -- office|staff

  -- Who the step is for. Nothing named means everybody, a department or a tag
  -- narrows it. The same shape the handbook uses, deliberately: a property that
  -- has learned one of them has learned both.
  departments TEXT,
  tags        TEXT,

  sort_order  INTEGER NOT NULL DEFAULT 100,
  active      INTEGER NOT NULL DEFAULT 1,

  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT,
  updated_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_ob_step_order ON ob_step (active, sort_order, id);

-- A manual step, done. Derived steps never appear here: their answer is read
-- from the contract, the handbook or the file, and writing a second copy of it
-- here is how the two come to disagree.
CREATE TABLE IF NOT EXISTS ob_done (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  step_id  INTEGER NOT NULL REFERENCES ob_step (id)   ON DELETE CASCADE,
  done_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  done_by  TEXT,
  note     TEXT,
  UNIQUE (staff_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_ob_done_staff ON ob_done (staff_id);

-- WHO IS ONBOARDING, AND NOBODY ELSE.
--
-- A row here is the whole of the answer. No row means this person is not being
-- onboarded, which is what keeps the twenty-four people already on the payroll
-- from being marched through a first week the morning this ships. A row is
-- created when somebody is added to the staff list while onboarding is on, or
-- when the office starts one by hand for somebody already here.
CREATE TABLE IF NOT EXISTS ob_state (
  staff_id    INTEGER PRIMARY KEY REFERENCES att_staff (id) ON DELETE CASCADE,
  started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  started_by  TEXT,
  -- Stamped the moment every step that applies is done, and by whoever settles
  -- somebody in early. Set means the app stops landing them on the welcome and
  -- stops counting them as new.
  finished_at TEXT,
  finished_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_ob_state_open ON ob_state (finished_at);

-- Off until somebody turns it on, like the handbook and the directory. A
-- checklist appearing on twenty-four phones because a button was pressed once
-- is the thing this design exists to avoid.
INSERT OR IGNORE INTO settings (key, value) VALUES ('onboarding_on', '0');

-- The two welcomes. Blank means that one is not shown, so a property with one
-- owner and no managing director gets one card rather than an empty second.
INSERT OR IGNORE INTO settings (key, value) VALUES ('ob_owner_name', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('ob_owner_role', 'Owner');
INSERT OR IGNORE INTO settings (key, value) VALUES ('ob_owner_words', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('ob_md_name', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('ob_md_role', 'Managing Director');
INSERT OR IGNORE INTO settings (key, value) VALUES ('ob_md_words', '');
