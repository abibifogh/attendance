-- Nice Place, the public washroom: what the four door counters read at the end
-- of each shift (with a picture of them), and the revenue reported for it.

-- The people who send the readings, chosen from a list on the open link.
CREATE TABLE IF NOT EXISTS np_staff (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

-- The picture of the counters, as sent (a JPEG, base64).
CREATE TABLE IF NOT EXISTS np_photo (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  type  TEXT NOT NULL,
  data  TEXT NOT NULL,
  at    TEXT NOT NULL
);

-- The counters at the end of a shift. GB gents bath, GT gents toilet, LB
-- ladies bath, LT ladies toilet. Each counts a movement, so in and out is 2.
CREATE TABLE IF NOT EXISTS np_reading (
  day        TEXT NOT NULL,
  shift      TEXT NOT NULL,              -- 'day' | 'night'
  name       TEXT,
  gb         INTEGER NOT NULL,
  gt         INTEGER NOT NULL,
  lb         INTEGER NOT NULL,
  lt         INTEGER NOT NULL,
  photo_id   INTEGER,
  sent_at    TEXT NOT NULL,              -- first sent
  at         TEXT NOT NULL,              -- last changed
  -- Typed or corrected in Insight rather than sent from the link.
  edited_by  TEXT,
  -- Somebody looked at the picture and the numbers match it.
  checked_by TEXT,
  checked_at TEXT,
  PRIMARY KEY (day, shift)
);

-- The revenue reported for a shift, from the monthly income workbook:
-- amounts in GH₵ minor units, adults and children apart, per facility.
CREATE TABLE IF NOT EXISTS np_revenue (
  day            TEXT NOT NULL,
  shift          TEXT NOT NULL,
  toilet_adult   INTEGER,
  toilet_child   INTEGER,
  toilet_total   INTEGER,
  shower_adult   INTEGER,
  shower_child   INTEGER,
  shower_total   INTEGER,
  staff          TEXT,
  uploaded_by    TEXT,
  uploaded_at    TEXT NOT NULL,
  PRIMARY KEY (day, shift)
);

-- What somebody said about a shift that does not add up.
CREATE TABLE IF NOT EXISTS np_answer (
  day     TEXT NOT NULL,
  shift   TEXT NOT NULL,
  answer  TEXT NOT NULL,
  note    TEXT,
  by_name TEXT,
  at      TEXT NOT NULL,
  PRIMARY KEY (day, shift)
);
