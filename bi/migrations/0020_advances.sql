-- Expenses reported on the Google Form, sent here by a script on the form the
-- moment each is submitted. Matched to POs by number.
CREATE TABLE IF NOT EXISTS expense_report (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The form's own id for the response, so sending it twice keeps one row.
  response_id  TEXT    NOT NULL UNIQUE,
  po           TEXT,
  po_typed     TEXT,
  amount       INTEGER,
  tnt          INTEGER,
  by_name      TEXT,
  submitted_at TEXT,
  received_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expense_report_po ON expense_report (po);

-- What an admin decided about an advance: more time until a day, or closed.
CREATE TABLE IF NOT EXISTS advance_decision (
  po        TEXT PRIMARY KEY,
  until_day TEXT,
  closed_at TEXT,
  reason    TEXT,
  by_name   TEXT,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A difference somebody has already been told about, so it is said once.
CREATE TABLE IF NOT EXISTS advance_notice (
  po      TEXT    NOT NULL,
  total   INTEGER NOT NULL,
  sent_to TEXT    NOT NULL,
  at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (po, total)
);
