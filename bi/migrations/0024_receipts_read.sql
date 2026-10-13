-- How a person read a Money Count whose receipts went down with no Cash
-- Movement and some still there: 'all' (every receipt before it was handed
-- in, and the ones now counted are new) or 'some' (only the difference was
-- handed in, nothing new). Keyed by the count's ASSD number.
CREATE TABLE IF NOT EXISTS shift_receipts_read (
  count_seq INTEGER PRIMARY KEY,
  reading   TEXT NOT NULL,
  by_name   TEXT,
  at        TEXT NOT NULL
);
