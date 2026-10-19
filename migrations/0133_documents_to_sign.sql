-- Documents to sign, prepared in three steps.
--
-- A document is still a letter in the register. What changes is how it is
-- put together and how people sign it: who signs is decided before it is
-- sent and kept as draft rows, people with the same order number sign at the
-- same time, the property can take its turn anywhere in the order, each
-- person fills in boxes placed on the pages, and the code that proves who
-- they are comes by email or by text before any of the document is shown.

-- 'v2' for a document made this way. Older letters keep working as they did.
ALTER TABLE corr_letter ADD COLUMN flow TEXT;

-- Where the property signs in the order, and who signs for it. A null step
-- means the property does not sign as part of the order.
ALTER TABLE corr_letter ADD COLUMN property_step INTEGER;
ALTER TABLE corr_letter ADD COLUMN property_user_id INTEGER;
ALTER TABLE corr_letter ADD COLUMN property_capacity TEXT;
-- What the property filled in: initials, and any name, title, text or tick
-- boxes placed for it.
ALTER TABLE corr_letter ADD COLUMN property_initials TEXT;
ALTER TABLE corr_letter ADD COLUMN property_values TEXT;

-- How it goes out.
ALTER TABLE corr_letter ADD COLUMN mail_subject TEXT;
ALTER TABLE corr_letter ADD COLUMN mail_message TEXT;
ALTER TABLE corr_letter ADD COLUMN remind_days INTEGER;
ALTER TABLE corr_letter ADD COLUMN expire_days INTEGER;

-- Each person: the group they sign in, how they are reached, what they sign
-- as, and what they filled in.
ALTER TABLE corr_recipient ADD COLUMN step INTEGER;
ALTER TABLE corr_recipient ADD COLUMN reach TEXT;          -- email | text | staff
ALTER TABLE corr_recipient ADD COLUMN user_id INTEGER;
ALTER TABLE corr_recipient ADD COLUMN capacity TEXT;
ALTER TABLE corr_recipient ADD COLUMN initials_ink TEXT;
ALTER TABLE corr_recipient ADD COLUMN field_values TEXT;
-- A short-lived pass given once the code is entered, so the document opens
-- only in the browser that proved who it was. Kept as a hash.
ALTER TABLE corr_recipient ADD COLUMN grant_hash TEXT;
ALTER TABLE corr_recipient ADD COLUMN agreed_at TEXT;

-- When whoever signs for the property was told it is their turn, so they are
-- told once.
ALTER TABLE corr_letter ADD COLUMN property_told_at TEXT;
