-- Receipts made into draft POs: uploaded several at once, or emailed in.
--
-- Every receipt that comes in is kept here with what became of it: a draft PO
-- (complete, or with a placeholder vendor or item for the accountant to
-- change), a duplicate of one already seen, or one that could not be read and
-- waits to be filled in by hand. The file itself is kept only while it is
-- still needed here: once it is attached to its PO in Odoo, it is dropped.

CREATE TABLE IF NOT EXISTS receipt (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- SHA-256 of the file: the same picture sent twice is not made into two POs.
  hash         TEXT    NOT NULL,
  name         TEXT,
  mime         TEXT    NOT NULL,
  -- A small picture for the list, made on the phone; none for an email's.
  thumb        TEXT,
  came         TEXT    NOT NULL,          -- upload | email
  by_name      TEXT,
  from_email   TEXT,
  subject      TEXT,
  hint         TEXT,
  at           TEXT    NOT NULL,
  -- complete | check | unread | duplicate | failed | filled | dismissed
  status       TEXT    NOT NULL,
  vendor_text  TEXT,
  amount       INTEGER,
  day          TEXT,
  description  TEXT,
  vendor_name  TEXT,
  product_name TEXT,
  vendor_ok    INTEGER,
  item_ok      INTEGER,
  problem      TEXT,
  po_id        INTEGER,
  po_name      TEXT,
  po_url       TEXT,
  todo         INTEGER NOT NULL DEFAULT 0,
  same_as      INTEGER,
  done_by      TEXT,
  done_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_receipt_hash ON receipt (hash);
CREATE INDEX IF NOT EXISTS idx_receipt_at ON receipt (id DESC);

-- The file, in pieces small enough for a row each.
CREATE TABLE IF NOT EXISTS receipt_file (
  receipt_id INTEGER NOT NULL,
  part       INTEGER NOT NULL,
  data       TEXT    NOT NULL,
  PRIMARY KEY (receipt_id, part)
);

-- Every email that came to the receipts address, and what was done with it:
-- so an address set up wrong, or a sender not on the list, is seen.
CREATE TABLE IF NOT EXISTS receipt_mail (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  from_email TEXT,
  subject   TEXT,
  outcome   TEXT NOT NULL,                -- read | ignored
  said      TEXT
);
