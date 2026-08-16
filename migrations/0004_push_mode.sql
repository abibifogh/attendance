-- How each terminal reaches us.
--
-- 'poll' is a reader program on site asking the device for its log every few
-- minutes. 'push' is the device making its own outbound request the moment
-- somebody taps, which needs nothing running anywhere.
--
-- The column exists mainly so the Terminals screen can tell the truth about
-- silence. A poller that has not called in for an hour is broken. A pushing
-- terminal that has said nothing for an hour on a Sunday afternoon is a
-- terminal nobody has walked past, which is not the same thing at all — and
-- showing both as a red warning would train everybody to ignore the red one
-- that matters.
--
-- Safe to run more than once.

ALTER TABLE att_devices ADD COLUMN mode TEXT NOT NULL DEFAULT 'push';

-- Any terminal registered before this change was set up with the poller.
UPDATE att_devices SET mode = 'poll' WHERE last_seen_at IS NOT NULL;
