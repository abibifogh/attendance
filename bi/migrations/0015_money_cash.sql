-- Money, from what the shifts already know.
--
-- Two things the Money page could not see. The rooms' own takings, which are
-- in no system but ASSD; and spending paid in cash, from the drawer or the
-- safe, against a PO nobody has billed in Odoo yet. Both are read from records
-- Insight already holds: the ASSD journal, the closing reports, the drawer
-- expenses and the safe book.

-- Each ASSD article (its three-digit number) and the part of the business its
-- charges are revenue of. `line_id` is a dim_line id, or:
--   'none'      not revenue: a deposit, a tax, a transfer;
--   'elsewhere' revenue another system already reports (the laundry system).
-- NULL until somebody decides. Nights (100 to 289) are always the rooms and
-- are not listed here.
CREATE TABLE IF NOT EXISTS assd_article (
  code     TEXT PRIMARY KEY,
  name     TEXT NOT NULL DEFAULT '',
  line_id  TEXT,
  by_name  TEXT,
  at       TEXT
);

-- A PO paid in cash, from the drawer or the safe, with what Odoo says about it.
-- Rebuilt from the closing reports, the drawer expenses and the safe book each
-- time Odoo is asked; nobody types here.
CREATE TABLE IF NOT EXISTS cash_po (
  po          TEXT PRIMARY KEY,
  vendor      TEXT,
  paid_from   TEXT NOT NULL,            -- drawer | safe
  paid_day    TEXT NOT NULL,
  paid        INTEGER NOT NULL,         -- pesewas that left the cash
  source      TEXT,                     -- where it was written: a closing report, a shift, the safe
  po_total    INTEGER,
  po_state    TEXT,
  ordered_on  TEXT,
  in_odoo     INTEGER NOT NULL DEFAULT 1,
  billed      INTEGER NOT NULL DEFAULT 0,
  bills       TEXT,                     -- JSON: [{ name, state, day }]
  lines       TEXT,                     -- JSON: [{ line, amount }] what the PO bought, by part of the business
  checked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_cash_po_day ON cash_po (paid_day);

-- The to-do list that comes out of the checks: a cash PO still not billed, a
-- payment that is not what its PO says, a bill with no PO behind it. Each is
-- given to a supervisor; their answer waits for an admin.
CREATE TABLE IF NOT EXISTS money_todo (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key           TEXT NOT NULL UNIQUE,   -- unbilled:P00412 | differs:P00412 | nopo:<bill id>
  kind          TEXT NOT NULL,
  ref           TEXT NOT NULL,
  day           TEXT,
  amount        INTEGER,
  detail        TEXT,                   -- JSON
  assignee_id   INTEGER,
  assignee_name TEXT,
  state         TEXT NOT NULL DEFAULT 'open',   -- open | answered | closed
  answer        TEXT,
  answered_by   TEXT,
  answered_at   TEXT,
  sent_back     TEXT,                   -- an admin's reason for sending an answer back
  closed_by     TEXT,
  closed_at     TEXT,
  closed_why    TEXT,
  opened_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_money_todo_state ON money_todo (state, assignee_id);
