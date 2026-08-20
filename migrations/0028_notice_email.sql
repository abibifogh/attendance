-- Every notification can go out by email as well as to the bell.
--
-- Until now exactly one thing was emailed: the morning digest, once a day, to
-- a list of addresses typed into the setup screen. Everything else — a
-- question raised about somebody's period, an answer coming back, a clock-time
-- change waiting on an administrator — rang a bell inside the app and nowhere
-- else. Which is fine for whoever is in the app, and useless for whoever is
-- not, and the person a notice is addressed to is very often the second one.
--
-- So a notice now also reaches its people by mail. Three rules keep that from
-- becoming the thing everybody learns to ignore.
--
-- IT GOES TO THE PEOPLE IT NAMES, AND NOBODY ELSE. A notice already carries
-- either a person or a permission. Both are resolved to actual logins with
-- actual addresses at the moment of sending, so somebody promoted this morning
-- is included and somebody who left last week is not. There is no second list
-- of recipients to maintain, and no way for the two to drift apart.
--
-- IT NEVER DELAYS ANYTHING. The mail is fired after the response has gone. A
-- provider having a bad afternoon must not make signing a day slow, and must
-- certainly not make it fail.
--
-- AND IT CAN BE TURNED OFF. One switch, because a property that finds it
-- noisy should be able to say so without an administrator editing rows.

INSERT OR IGNORE INTO settings (key, value) VALUES
  -- On, because being told is the point. Off is one press on the setup screen.
  ('notice_email', '1'),

  -- The sender. The domain has to be one the email provider has been shown to
  -- belong to you — a Gmail or Yahoo address here is rejected by the receiving
  -- side, not by us, and there is nothing this app can do about that.
  ('email_from', 'hive@niceoperation.com');

-- And the site's own address, which is what puts a working link in the mail.
-- It has never been seeded, so unless somebody typed it into the setup screen
-- every notice would arrive with no way back to the thing it is about. The
-- Worker already answers on this name — it is in wrangler.toml as the custom
-- domain — so there is nothing here for anybody to look up.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('site_url', 'https://staff.niceoperation.com');

UPDATE settings SET value = 'https://staff.niceoperation.com'
 WHERE key = 'site_url' AND (value IS NULL OR TRIM(value) = '');

-- An address that has been sitting empty since the site was set up is not a
-- deliberate choice, it is the default nobody filled in. Anything actually
-- chosen is left exactly as it is.
UPDATE settings SET value = 'hive@niceoperation.com'
 WHERE key = 'email_from' AND (value IS NULL OR TRIM(value) = '');
