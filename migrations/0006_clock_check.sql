-- Is the terminal's clock right?
--
-- Every punch is stamped by the device, not by this app, and the app takes that
-- stamp as gospel. So a terminal whose clock has wandered does not fail loudly:
-- it quietly rewrites who was late, and nobody finds out until somebody argues
-- about a Tuesday six weeks ago and there is no way left to settle it.
--
-- These terminals drift a few minutes a month on their own, and the correct fix
-- is NTP. But NTP lives on the device's web page, it can be switched off, and a
-- clock set by hand is common. So rather than assume, we measure.
--
-- A pushing terminal stamps an event and posts it within a second or two, which
-- makes the gap between "the time the device thinks it is" and "the time it is"
-- readable for free on every tap. Nothing extra is asked of the device.
--
-- Only pushed events can say this. A poller hands over a log that may be an
-- hour old, and comparing that to now would report the fetch delay as drift and
-- cry wolf every few minutes.

ALTER TABLE att_devices ADD COLUMN clock_offset_seconds INTEGER;
ALTER TABLE att_devices ADD COLUMN clock_checked_at TEXT;

-- How far out the clock has to be before anybody is told. Three minutes is
-- comfortably past the second or two that network delay accounts for, and
-- comfortably short of the grace period on a shift — so a warning appears well
-- before the drift is big enough to have marked anybody late who was not.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('att_clock_drift_seconds', '180');
