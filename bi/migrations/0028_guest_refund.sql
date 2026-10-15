-- ------------------------------------------------- refunds owed to guests --

-- A guest who paid more by card or MoMo than ASSD shows, answered "Refund due
-- to the guest": kept here, with what was paid, until somebody says it was
-- paid back. Only the answer decides whether it is owed: a row whose answer
-- was changed or taken back is not listed.
CREATE TABLE IF NOT EXISTS guest_refund (
  key           TEXT PRIMARY KEY,   -- the paid-more exception's key
  day           TEXT NOT NULL,
  slot          TEXT NOT NULL,
  assd_user     TEXT,
  seq           INTEGER,            -- the ASSD line
  amount        INTEGER NOT NULL,   -- what is owed back: paid − ASSD
  assd          INTEGER,            -- what ASSD shows
  paid          INTEGER,            -- what arrived
  method        TEXT,               -- card or momo
  last4         TEXT,
  paid_at       TEXT,               -- when the payment arrived
  paid_back_by  TEXT,
  paid_back_at  TEXT
);
