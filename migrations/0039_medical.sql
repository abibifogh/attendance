-- The medical allowance, and claims against it.
--
-- A property gives each qualifying member of staff so much a year towards
-- medical bills. What happens without an app is a drawer of receipts, a figure
-- somebody keeps in their head, and an argument in November about whether the
-- pharmacy bill in March was counted.
--
-- THREE TABLES, BECAUSE THERE ARE THREE DIFFERENT FACTS
--
--   What somebody is entitled to this year, which the office sets.
--   What they have asked for, which they submit and somebody decides.
--   The bills behind each claim, which are the evidence for it.
--
-- Keeping the receipts separate from the claim is the part that earns its
-- keep: a claim is usually two or three bills from different weeks, the total
-- is the sum of them rather than a number somebody typed, and a claim approved
-- for less than was asked can still be shown against the bills it came from.
--
-- THE BALANCE IS NOT STORED. It is the opening balance less what has actually
-- been approved. The same reasoning as the advances ledger beside this: a
-- stored balance is a figure with no argument behind it, and this is exactly
-- the kind of figure people need to be able to argue with.
--
-- WHO MAY SEE IT. hr_pay, like the wages and the advances. What somebody spends
-- at a hospital is the most private thing in this database.

CREATE TABLE IF NOT EXISTS hr_medical_allowance (
  staff_id  INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  year      INTEGER NOT NULL,

  -- What the year is worth to them, and what was left when the app started
  -- keeping the record. Usually the same figure; they differ where somebody
  -- had already claimed on paper before any of this existed, which is the
  -- ordinary case in the first year.
  allowance REAL    NOT NULL,
  opening   REAL    NOT NULL,

  note      TEXT,
  set_by    TEXT,
  set_at    TEXT    NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (staff_id, year)
);

CREATE TABLE IF NOT EXISTS hr_medical_claim (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id  INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  year      INTEGER NOT NULL,

  -- What was asked for, and what was allowed. Both, always: a claim cut down
  -- on approval is a conversation somebody will want the record of.
  amount    REAL    NOT NULL,
  approved  REAL,

  what      TEXT,

  -- requested | approved | rejected | withdrawn
  status    TEXT    NOT NULL DEFAULT 'requested',

  asked_at    TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by  TEXT,
  decided_at  TEXT,
  decision    TEXT
);

CREATE INDEX IF NOT EXISTS idx_hr_medical_claim_staff ON hr_medical_claim (staff_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_hr_medical_claim_status ON hr_medical_claim (status);

-- The bills. Ten at most per claim, which the app enforces rather than the
-- database: the limit is a judgement about what somebody will sit and
-- photograph on a phone, not a rule about what is true.
--
-- The picture itself goes in hr_document, which already knows how to hold a
-- file too big for one row. Here is only what the bill says.
CREATE TABLE IF NOT EXISTS hr_medical_receipt (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id    INTEGER NOT NULL REFERENCES hr_medical_claim (id) ON DELETE CASCADE,
  what        TEXT,
  amount      REAL    NOT NULL DEFAULT 0,
  spent_on    TEXT,
  document_id INTEGER REFERENCES hr_document (id) ON DELETE SET NULL,
  at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hr_medical_receipt ON hr_medical_receipt (claim_id);

INSERT OR IGNORE INTO settings (key, value) VALUES
  -- What a qualifying person gets in a year, as a starting point for the
  -- screen that sets them. Zero means the property has not decided yet, and
  -- the screen says so rather than offering a made-up figure.
  ('medical_allowance_default', '0');
