-- What the business was actually invoiced.
--
-- Every cost figure in this warehouse so far has come from an operational
-- system: the kitchen recording what it received, the bar recording what it
-- poured. Those are records of what people *typed*, and they are the only
-- records there were.
--
-- Odoo is the other kind. A vendor bill is a document somebody outside the
-- business sent in, that somebody inside approved, and that the books carry.
-- Setting the two side by side is a question none of the four systems could
-- ask on its own: the kitchen booked in forty crates of eggs and the supplier
-- invoiced for forty-four.

-- ------------------------------------------------------------ the accounts --

-- The chart of accounts, so spend can be grouped the way the books group it
-- rather than the way this warehouse guesses.
CREATE TABLE IF NOT EXISTS dim_account (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id  TEXT    NOT NULL,
  code       TEXT    NOT NULL,
  name       TEXT    NOT NULL DEFAULT '',
  -- expense | income | asset | liability | equity, as Odoo classifies it.
  kind       TEXT    NOT NULL DEFAULT '',
  UNIQUE (source_id, code)
);

-- -------------------------------------------------------------- the bills --

-- One vendor bill, at the grain the document exists in.
--
-- Header-level, because the questions that matter here are header-level: was
-- it paid on time, was it approved by anybody, is it the same bill as the one
-- last week with a different number. Line detail goes to fact_purchase_line
-- alongside the other systems' purchases, so a price can be compared across
-- the group.
CREATE TABLE IF NOT EXISTS fact_bill (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     TEXT    NOT NULL,
  external_id   TEXT    NOT NULL,
  -- The accounting date, which is the one the books use. Not the day it was
  -- entered: a bill keyed in three weeks late still belongs to its own month,
  -- and reporting it in the month somebody got round to it is how a good month
  -- becomes a bad one for no reason anybody can find.
  day           TEXT    NOT NULL,
  due_day       TEXT,
  supplier_id   INTEGER REFERENCES dim_supplier (id) ON DELETE SET NULL,
  line_id       TEXT    NOT NULL REFERENCES dim_line (id),

  -- The vendor's own document number, kept verbatim. Two bills carrying the
  -- same one from the same supplier is the classic duplicate-payment signal,
  -- and it cannot be spotted from Odoo's internal id, which is different by
  -- construction.
  vendor_ref    TEXT,

  -- posted | draft | cancel, and paid | partial | not_paid | reversed.
  state         TEXT    NOT NULL DEFAULT '',
  payment_state TEXT    NOT NULL DEFAULT '',

  -- Pesewas. Odoo hands out floats in the company currency; the connector
  -- converts once, on the way in.
  untaxed       INTEGER NOT NULL DEFAULT 0,
  tax           INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  residual      INTEGER NOT NULL DEFAULT 0,

  -- Whether any line traced back to a purchase order. A bill with no order
  -- behind it is not wrong, but it is spend nobody agreed to in advance, and
  -- the share of it is a number worth watching.
  from_order    INTEGER NOT NULL DEFAULT 0,

  currency      TEXT    NOT NULL DEFAULT '',
  UNIQUE (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_fact_bill_day ON fact_bill (day);
CREATE INDEX IF NOT EXISTS idx_fact_bill_supplier ON fact_bill (supplier_id, day);
CREATE INDEX IF NOT EXISTS idx_fact_bill_ref ON fact_bill (vendor_ref);

-- ------------------------------------------------- richer purchase lines --

-- fact_purchase_line already carries one line of one purchase, from whichever
-- system recorded it, precisely so a unit price can be set against the same
-- thing bought elsewhere. Odoo's bill lines belong in it for that reason.
--
-- These four add what only an accounting system knows.
ALTER TABLE fact_purchase_line ADD COLUMN account_code TEXT;
ALTER TABLE fact_purchase_line ADD COLUMN tax INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fact_purchase_line ADD COLUMN bill_id TEXT;
-- What the purchase order said, where there was one. Ordered and billed
-- differing is either a price change nobody was told about or a quantity
-- nobody checked, and both are worth a question.
ALTER TABLE fact_purchase_line ADD COLUMN ordered_qty REAL;

-- ------------------------------------------------------- the books, by month --

-- Posted expense and income, by account, by month.
--
-- The money page derives cost from operational records because that is all it
-- had. This is what the accounts actually say, and the gap between them is
-- itself a finding: an operational system records what was consumed, the books
-- record what was bought, and a business where those two disagree by a quarter
-- has a problem in one of them.
CREATE TABLE IF NOT EXISTS fact_ledger (
  month      TEXT    NOT NULL,          -- YYYY-MM
  source_id  TEXT    NOT NULL,
  account_id INTEGER NOT NULL REFERENCES dim_account (id) ON DELETE CASCADE,
  line_id    TEXT    NOT NULL REFERENCES dim_line (id),
  -- Debit less credit, in pesewas, signed the way the account's own kind
  -- expects: an expense account reads positive when money was spent.
  amount     INTEGER NOT NULL DEFAULT 0,
  entries    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, account_id, line_id)
);
CREATE INDEX IF NOT EXISTS idx_fact_ledger_month ON fact_ledger (month);

-- ------------------------------------------------------------ the source --

-- Registered switched off and unconfigured, like the others. A source that
-- appears the moment the migration runs, and fails because nobody has given it
-- an address, is a red light on the Setup screen that means nothing.
INSERT OR IGNORE INTO sources (id, label, kind, config) VALUES
  ('odoo', 'Odoo (books)', 'odoo_json2',
   '{"base":"","db":"","lineBy":"analytic","lineMap":{}}');
