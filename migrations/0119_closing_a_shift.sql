-- Closing a shift at the front desk.
--
-- It used to be a Google Form: name, date, shift, eighteen questions, half of
-- them figures copied off ASSD that ASSD already knows. Now it is "My till" in
-- HIVE, where front-desk staff already have a login, and it asks only what
-- nobody else can say: whether the float was right, what is in the drawer,
-- which envelopes went to the safe, the PO for each expense, the rentals
-- counted, and whether the scale and the hair dryer are where they should be.
--
-- Insight reads these tables (it already binds this database, read-only) and
-- sets each report beside the journal, the card report and the bank. What it
-- finds comes back to the person under "To sort out", and their answers are
-- kept here.
--
-- Money is in pesewas, as Insight keeps it, so the two never round apart.

CREATE TABLE IF NOT EXISTS till_report (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The shift, as Insight names it: the day it started and morning,
  -- afternoon or night. A night shift belongs to the day it began.
  day           TEXT    NOT NULL,
  slot          TEXT    NOT NULL,
  user_id       INTEGER NOT NULL,
  name          TEXT    NOT NULL,

  float_ok      INTEGER NOT NULL,
  float_diff    INTEGER,
  float_note    TEXT,
  cash          INTEGER NOT NULL,
  to_safe       INTEGER NOT NULL,
  -- [{ no, amount }]: envelope numbers as written on them, no prefix.
  envelopes     TEXT    NOT NULL DEFAULT '[]',
  -- [{ po, paid, name, state, vendor, total, counted }]: every expense line
  -- as typed and as Odoo answered. Only the confirmed ones count; those are
  -- also in till_po, which is what stops a PO being claimed twice.
  expenses      TEXT    NOT NULL DEFAULT '[]',
  -- { padlock: { start, end } }
  rentals       TEXT    NOT NULL DEFAULT '{}',
  -- [{ id, label, ok, guest, why }]
  checks        TEXT    NOT NULL DEFAULT '[]',
  note          TEXT,
  device        TEXT,
  signed_at     TEXT    NOT NULL DEFAULT (datetime('now')),

  -- Reopened from Insight so it can be sent again. Kept, not deleted: what was
  -- signed first is part of the record.
  reopened_at   TEXT,
  reopened_by   TEXT,
  reopen_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_till_report_once
  ON till_report (day, slot, user_id) WHERE reopened_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_till_report_day ON till_report (day, slot);
CREATE INDEX IF NOT EXISTS idx_till_report_user ON till_report (user_id, day);

-- A PO paid out of the drawer. One row per PO, ever: the primary key is what
-- refuses the same PO on a second shift.
CREATE TABLE IF NOT EXISTS till_po (
  po        TEXT    PRIMARY KEY,
  report_id INTEGER,
  user_id   INTEGER NOT NULL,
  day       TEXT    NOT NULL,
  slot      TEXT    NOT NULL,
  paid      INTEGER NOT NULL,
  total     INTEGER NOT NULL,
  vendor    TEXT,
  state     TEXT,
  -- 'report' when it came with the closing report, 'answer' when it was added
  -- afterwards from To sort out.
  via       TEXT    NOT NULL DEFAULT 'report',
  at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_till_po_shift ON till_po (day, slot);

-- What somebody said about something on their list. The latest one for a key
-- is their answer; a supervisor sending it back asks for another.
CREATE TABLE IF NOT EXISTS till_answer (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  key     TEXT    NOT NULL,
  user_id INTEGER NOT NULL,
  -- explain | repay | po
  how     TEXT    NOT NULL,
  text    TEXT,
  po      TEXT,
  at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_till_answer ON till_answer (user_id, key, id);
