-- What was texted, and what the gateway said back.
--
-- The same reason push_log and email_log exist: notifications are the thing
-- people forget, and without a record there is nothing to look at when
-- somebody says they were never told. Texts cost money as well, so the count
-- is worth having on its own.
CREATE TABLE IF NOT EXISTS sms_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  kind       TEXT NOT NULL,
  day        TEXT,
  recipients TEXT,
  sent       INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL,
  detail     TEXT
);

CREATE INDEX IF NOT EXISTS idx_sms_log_at ON sms_log (at DESC);
