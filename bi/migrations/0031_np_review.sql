-- ---------------------------------- Nice Place: a counter may wait for review --

-- A picture is sent even when a counter could not be read off it. That
-- counter stays empty (NULL) until an admin or a supervisor reads it from the
-- picture and fills it in. SQLite cannot drop NOT NULL in place, so the table
-- is made again with the same columns and rows.
CREATE TABLE np_reading_new (
  day        TEXT NOT NULL,
  shift      TEXT NOT NULL,              -- 'day' | 'night'
  name       TEXT,
  gb         INTEGER,                    -- NULL: not read yet, waiting for review
  gt         INTEGER,
  lb         INTEGER,
  lt         INTEGER,
  photo_id   INTEGER,
  sent_at    TEXT NOT NULL,
  at         TEXT NOT NULL,
  edited_by  TEXT,
  checked_by TEXT,
  checked_at TEXT,
  read_json  TEXT,
  PRIMARY KEY (day, shift)
);
INSERT INTO np_reading_new (day, shift, name, gb, gt, lb, lt, photo_id, sent_at, at, edited_by, checked_by, checked_at, read_json)
  SELECT day, shift, name, gb, gt, lb, lt, photo_id, sent_at, at, edited_by, checked_by, checked_at, read_json FROM np_reading;
DROP TABLE np_reading;
ALTER TABLE np_reading_new RENAME TO np_reading;
