-- Joining up a new starter, and chasing what is still waiting.
--
-- HIVE now sends a details link itself, by email and text, and reminds the
-- person until it is done. The same goes for contracts and letters waiting on
-- a signature. Links are only ever stored as hashes, so a reminder carries a
-- fresh link and the one before it stops working.

ALTER TABLE hr_invite ADD COLUMN sent_at TEXT;
ALTER TABLE hr_invite ADD COLUMN sent_to TEXT;
ALTER TABLE hr_invite ADD COLUMN reminded_at TEXT;
ALTER TABLE hr_invite ADD COLUMN reminders INTEGER NOT NULL DEFAULT 0;
-- The link that took over from this one when a reminder went out.
ALTER TABLE hr_invite ADD COLUMN replaced_by INTEGER;
-- Whether HIVE may send it again by email and text when reminding.
ALTER TABLE hr_invite ADD COLUMN by_email INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hr_invite ADD COLUMN by_text INTEGER NOT NULL DEFAULT 0;

ALTER TABLE corr_recipient ADD COLUMN reminded_at TEXT;
ALTER TABLE corr_recipient ADD COLUMN reminders INTEGER NOT NULL DEFAULT 0;
-- When the person was last told it is their turn, so it is said once.
ALTER TABLE corr_recipient ADD COLUMN turn_told_at TEXT;

-- When each step of a first week is due, in days from the start date: -1 is
-- the day before, 0 the first day, 5 the end of the first week, 30 the end of
-- the first month. Empty means no date.
ALTER TABLE ob_step ADD COLUMN due_days INTEGER;
ALTER TABLE ob_state ADD COLUMN chased_on TEXT;
