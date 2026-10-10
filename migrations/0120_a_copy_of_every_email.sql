-- A standing copy of every email HIVE sends.
--
-- The property asked for one address to be copied on everything: the owner,
-- who has no shift and often no login, and wants to see what the house is
-- being told. Kept as a setting, changed under Notifications, and never used
-- on the two emails that carry a credential (the account invitation and a
-- signing code).
INSERT OR IGNORE INTO settings (key, value) VALUES ('email_cc', '["michael@hostelaccra.com"]');
