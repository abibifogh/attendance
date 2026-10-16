-- ------------------------------------- Nice Place: counters read from a photo --

-- What a picture of the counters was read as, by Cloudflare's Workers AI,
-- kept by the picture's fingerprint so the same picture is read once.
-- A counter is NULL when it could not be read for certain.
CREATE TABLE IF NOT EXISTS np_read (
  hash     TEXT PRIMARY KEY,   -- SHA-256 of the picture as sent
  gb       INTEGER,
  gt       INTEGER,
  lb       INTEGER,
  lt       INTEGER,
  problem  TEXT,               -- what made a counter unreadable, in the reader's words
  model    TEXT,
  at       TEXT NOT NULL
);

-- On a reading sent from the link: what its picture was read as (JSON
-- {gb, gt, lb, lt}, NULL for one not read), or NULL when it was not read at all.
ALTER TABLE np_reading ADD COLUMN read_json TEXT;
