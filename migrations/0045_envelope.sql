-- Sending a letter out for signature, as an envelope.
--
-- WHAT WAS MISSING. The register could already send a letter to several people
-- in an order, give each of them a link and an access code, and record who
-- signed and when. Three things it could not do, and each of them is the
-- reason somebody goes back to emailing a PDF.
--
-- It could not say WHERE on the page a person signs. Everybody's signature
-- stacked under the letter in the order they arrived, which is fine for one
-- signer on a one-page letter and wrong for a two-party agreement where the
-- signatures belong side by side over named lines.
--
-- It could not let two people sign at the same time. Strictly one after
-- another is right for an approval chain and wrong for a contract, where
-- waiting for the other side to go first is a week nobody has.
--
-- And it could not send a link without an access code. The code is the right
-- default and a poor rule: a supplier being told a six-character code down the
-- telephone for a routine acknowledgement is the friction that gets the whole
-- thing abandoned.

-- Whether the signers go one after another, or all at once.
--
-- 'order' is what every letter did before this and stays the default: the
-- second link does not open until the first person has dealt with theirs.
-- 'all' opens every link the moment they are made.
ALTER TABLE corr_letter ADD COLUMN routing TEXT NOT NULL DEFAULT 'order';

-- Whether a new letter's signers are given an access code unless somebody says
-- otherwise. On, because a link that arrives in a forwarded email and opens a
-- signable document on its own is the failure that matters here.
INSERT OR IGNORE INTO settings (key, value) VALUES ('corr_default_code', '1');
