-- Closing a shift in HIVE, and settling what does not agree here.
--
-- Staff close their shift in HIVE, where they already have a login; this app
-- reads those reports from HIVE's database and holds everything an admin
-- decides about them: what the closing form asks, what a supervisor may see,
-- who is told when a shift is closed, and how each difference was settled.

-- ------------------------------------------------------- front desk checks --

-- Things staff look for at the front desk at the end of every shift. A "No"
-- has to come with the guest who has it or an explanation.
CREATE TABLE IF NOT EXISTS till_check (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT    NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 100,
  created_by TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO till_check (id, label, sort) SELECT 1, 'Scale', 10
  WHERE NOT EXISTS (SELECT 1 FROM till_check WHERE id = 1);
INSERT INTO till_check (id, label, sort) SELECT 2, 'Hair dryer', 20
  WHERE NOT EXISTS (SELECT 1 FROM till_check WHERE id = 2);

-- ----------------------------------------------------------------- rentals --

-- Things rented at reception against a deposit. Staff count them at the start
-- and the end of a shift; a change is matched to the deposits and refunds ASSD
-- booked under the article number. Money is in pesewas.
CREATE TABLE IF NOT EXISTS till_rental (
  id      TEXT    PRIMARY KEY,
  label   TEXT    NOT NULL,
  unit    TEXT    NOT NULL,
  article TEXT    NOT NULL,
  deposit INTEGER NOT NULL,
  refund  INTEGER NOT NULL,
  active  INTEGER NOT NULL DEFAULT 0,
  sort    INTEGER NOT NULL DEFAULT 100
);
-- Padlocks: article 405, GH₵ 30 down and GH₵ 30 back.
INSERT OR IGNORE INTO till_rental (id, label, unit, article, deposit, refund, active, sort)
  VALUES ('padlock', 'Padlocks', 'padlock', '405', 3000, 3000, 1, 10);
-- Towels: GH₵ 40 down (article 400, the GH₵ 30 deposit, and 551, GH₵ 10 rent)
-- and GH₵ 30 back. Set up and switched off until the property starts counting.
INSERT OR IGNORE INTO till_rental (id, label, unit, article, deposit, refund, active, sort)
  VALUES ('towel', 'Towels', 'towel', '400', 4000, 3000, 0, 20);

-- ------------------------------------------------------------ who is told --

-- HIVE logins to tell, and how. HIVE sends the push and the email: it already
-- holds the phones and the addresses.
CREATE TABLE IF NOT EXISTS till_notify (
  hive_user_id INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  push         INTEGER NOT NULL DEFAULT 1,
  email        INTEGER NOT NULL DEFAULT 1,
  amounts      INTEGER NOT NULL DEFAULT 1,
  on_closed    INTEGER NOT NULL DEFAULT 1,
  on_answer    INTEGER NOT NULL DEFAULT 1,
  on_approval  INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------------------------------- supervisor access --

-- What a supervisor may do with each part of the Shifts screen: 0 hidden,
-- 1 see, 2 see and act. Account 0 is every supervisor without their own row.
CREATE TABLE IF NOT EXISTS till_access (
  account_id INTEGER NOT NULL,
  area       TEXT    NOT NULL,
  level      INTEGER NOT NULL,
  PRIMARY KEY (account_id, area)
);
INSERT OR IGNORE INTO till_access (account_id, area, level) VALUES
  (0, 'day', 1), (0, 'week', 1), (0, 'month', 0),
  (0, 'reports', 1), (0, 'money', 1), (0, 'moves', 2),
  (0, 'answers', 2), (0, 'money_out', 0), (0, 'reopen', 0), (0, 'net', 0),
  (0, 'bank', 0), (0, 'odoo', 1), (0, 'files', 0);

-- -------------------------------------------------------------- the people --

-- Whose ASSD login is whose HIVE login. Only needed for a shift nobody closed:
-- a closed shift belongs to whoever closed it.
CREATE TABLE IF NOT EXISTS till_people (
  assd_user    TEXT    PRIMARY KEY,
  hive_user_id INTEGER,
  by_name      TEXT,
  at           TEXT
);

-- ---------------------------------------------------------- how it settled --

-- What was decided about a difference on somebody's list. The latest row for a
-- key and a person is the decision; "back" sends it back to them.
CREATE TABLE IF NOT EXISTS till_resolution (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key          TEXT    NOT NULL,
  hive_user_id INTEGER NOT NULL,
  outcome      TEXT    NOT NULL,
  amount       INTEGER,
  note         TEXT,
  advance_id   INTEGER,
  by_name      TEXT,
  at           TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_till_resolution ON till_resolution (key, hive_user_id, id);

-- -------------------------------------------- corrections that need a yes --

-- A supervisor's correction to a cash movement waits for an admin. Applied
-- corrections are the ones that count; the rest are shown and left out.
ALTER TABLE shift_movement ADD COLUMN status TEXT NOT NULL DEFAULT 'applied';
ALTER TABLE shift_movement ADD COLUMN decided_by TEXT;
ALTER TABLE shift_movement ADD COLUMN decided_at TEXT;

-- ------------------------------------------ exceptions reconciled together --

-- Two or more exceptions that are one story told twice: GH₵ 203 by MoMo that
-- reached the bank on the 2nd and was keyed in ASSD on the 4th shows up once
-- as money ASSD does not show and once as a payment that never arrived.
-- Reconciled together, every one of them counts as answered.
CREATE TABLE IF NOT EXISTS shift_link (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  -- JSON array of exception keys.
  keys    TEXT    NOT NULL,
  note    TEXT,
  by_name TEXT,
  at      TEXT    NOT NULL
);
