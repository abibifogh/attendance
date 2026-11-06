-- Replies to every email HIVE sends go to the office's own inbox rather than
-- back to the sending address. It is the same "Reply to" setting as
-- Settings › Notifications › Setup, so it can be changed there later.
INSERT INTO settings (key, value) VALUES ('email_reply_to', 'michael@hostelaccra.com')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
