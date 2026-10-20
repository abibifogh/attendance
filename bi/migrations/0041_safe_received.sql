-- Envelopes moved to the safe, marked received by an admin: one row per
-- envelope (a shift can send several), or per shift where ASSD moved cash to
-- the safe and no HIVE report gave an envelope (`envelope_no` is '').
-- Separate from the safe book: this is the check that the envelope arrived.
CREATE TABLE IF NOT EXISTS safe_received (
  day          TEXT    NOT NULL,
  slot         TEXT    NOT NULL,
  envelope_no  TEXT    NOT NULL DEFAULT '',
  expected     INTEGER NOT NULL,          -- pesewas: what the envelope said (or ASSD, with no envelope), when received
  counted      INTEGER NOT NULL,          -- pesewas counted in the safe
  received_on  TEXT    NOT NULL,          -- the day it was received
  with_name    TEXT,                      -- counted with
  why          TEXT,                      -- said when the count is not what was expected
  by_name      TEXT    NOT NULL,
  at           TEXT    NOT NULL,
  PRIMARY KEY (day, slot, envelope_no)
);
CREATE INDEX IF NOT EXISTS idx_safe_received_on ON safe_received (received_on);
