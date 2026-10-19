-- A one-time code before anybody signs, and the property's PIN or password
-- before it countersigns.
--
-- A contract signed from a details link now asks for a six-digit code sent to
-- the person's own email or phone, as a letter does. How the signer showed it
-- was them is kept with the signature.
ALTER TABLE hr_invite ADD COLUMN otp_hash TEXT;
ALTER TABLE hr_invite ADD COLUMN otp_sent_at TEXT;
ALTER TABLE hr_invite ADD COLUMN otp_tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hr_invite ADD COLUMN otp_sent_to TEXT;
ALTER TABLE hr_invite ADD COLUMN otp_verified_at TEXT;

-- 'email code', 'text code', 'link code' or empty.
ALTER TABLE hr_contract ADD COLUMN signer_check TEXT;
ALTER TABLE corr_recipient ADD COLUMN signer_check TEXT;
