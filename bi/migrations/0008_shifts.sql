-- Shift reconciliation: the control sheet, done from the source records.
--
-- Three uploads and four things a person types. The uploads are ASSD's detail
-- journal, the bank statement and the card terminal report; what is typed is
-- the counted cash at each hand-over, the expense sheet's total and its Odoo
-- PO numbers, and an answer to each exception.
--
-- Only what a shift needs is kept. The journal's guest names and addresses
-- never reach the server (the browser sends lines, the server keeps amounts);
-- the bank's salaries, suppliers and transfers are dropped on arrival.

-- One ASSD transaction, by its own running number. `data` is the JSON of its
-- payments, laundry lines, counts and movements. A later export replaces the
-- lines inside its own benefit-date window and keeps the rest.
CREATE TABLE IF NOT EXISTS assd_entry (
  seq        INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,
  staff      TEXT NOT NULL DEFAULT '',
  day        TEXT,
  register   TEXT,
  data       TEXT NOT NULL,
  loaded_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assd_entry_kind_day ON assd_entry (kind, day);

-- Card credits, card reversals, card commission and mobile-money receipts
-- from the bank statement. Keyed on the bank's own transaction, so loading
-- the same statement twice changes nothing.
CREATE TABLE IF NOT EXISTS bank_card_txn (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  day        TEXT NOT NULL,
  at         TEXT,
  at_exact   INTEGER NOT NULL DEFAULT 0,
  posted_at  TEXT,
  amount     INTEGER NOT NULL,
  card_day   TEXT,
  first6     TEXT,
  last4      TEXT,
  approval   TEXT,
  terminal   TEXT,
  reference  TEXT,
  loaded_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bank_card_txn_day ON bank_card_txn (day);
CREATE INDEX IF NOT EXISTS idx_bank_card_txn_card_day ON bank_card_txn (card_day);

-- Every attempt on the card terminal, approved or not, by its retrieval
-- reference number.
CREATE TABLE IF NOT EXISTS terminal_txn (
  rrn        TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  day        TEXT NOT NULL,
  terminal   TEXT,
  type       TEXT,
  kind       TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  first6     TEXT,
  last4      TEXT,
  stan       TEXT,
  code       TEXT,
  status     TEXT,
  approval   TEXT,
  approved   INTEGER NOT NULL DEFAULT 0,
  loaded_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_terminal_txn_day ON terminal_txn (day);

-- What was uploaded, when, by whom and which days it covered. Coverage is
-- what stops a payment from last week being called "never settled" against a
-- statement that ends yesterday.
CREATE TABLE IF NOT EXISTS shift_upload (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  name       TEXT,
  from_day   TEXT,
  to_day     TEXT,
  rows       INTEGER NOT NULL DEFAULT 0,
  note       TEXT,
  by_name    TEXT,
  at         TEXT NOT NULL
);

-- The cash counted at hand-over, typed by a person. `closing` is what was in
-- the drawer when the shift ended; `opening` is typed only for the first
-- shift, or to restart the chain after a gap.
CREATE TABLE IF NOT EXISTS shift_count (
  day        TEXT NOT NULL,
  slot       TEXT NOT NULL,
  opening    INTEGER,
  closing    INTEGER,
  note       TEXT,
  by_name    TEXT,
  at         TEXT NOT NULL,
  PRIMARY KEY (day, slot)
);

-- The expense sheet's total for a shift and the Odoo purchase orders behind
-- it. `odoo` is the JSON of what Odoo said about those orders when last asked.
CREATE TABLE IF NOT EXISTS shift_expense (
  day          TEXT NOT NULL,
  slot         TEXT NOT NULL,
  sheet_total  INTEGER,
  po_numbers   TEXT,
  odoo         TEXT,
  pulled_at    TEXT,
  by_name      TEXT,
  at           TEXT NOT NULL,
  PRIMARY KEY (day, slot)
);

-- A person's answer to an exception, by the exception's stable key.
CREATE TABLE IF NOT EXISTS shift_answer (
  key        TEXT PRIMARY KEY,
  answer     TEXT NOT NULL,
  note       TEXT,
  by_name    TEXT,
  at         TEXT NOT NULL
);
