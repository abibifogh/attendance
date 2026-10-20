-- A payment from the terminal or the bank that ASSD does not show is put on
-- the shift whose hours its time falls in. One taken just after a hand-over
-- (an afternoon guest at 22:25) belongs to the shift before: an admin moves
-- it, with a reason. The move is the payment's, kept here and undone here.
CREATE TABLE IF NOT EXISTS payment_home (
  event_id   TEXT PRIMARY KEY,   -- t:<rrn> (terminal) or b:<id> (bank)
  day        TEXT NOT NULL,
  slot       TEXT NOT NULL,
  from_day   TEXT,
  from_slot  TEXT,
  why        TEXT NOT NULL,
  by_name    TEXT NOT NULL,
  at         TEXT NOT NULL
);
