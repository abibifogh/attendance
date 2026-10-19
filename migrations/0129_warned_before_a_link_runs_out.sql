-- When the office was warned that a signing link is about to run out with
-- the letter still unsigned, so it is said once.
ALTER TABLE corr_recipient ADD COLUMN expiry_warned_at TEXT;
