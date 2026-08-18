-- Choosing what to ask for, and letting people attach the paper.
--
-- WHAT TO ASK
-- The self-service form has been the same for every property since it was
-- written: everything a person is allowed to fill in about themselves, all of
-- it optional. That is a reasonable default and a poor rule. A hotel that pays
-- everybody by mobile money has no use for a bank branch; one that has been
-- caught out by an emergency contact nobody filled in wants that one refused
-- rather than skipped.
--
-- So the property can now say, per field: ask for it, insist on it, or do not
-- ask at all. Kept in `settings` under `hr_form` as a *sparse* map of only what
-- was changed, which matters more than it looks: a field added to the code next
-- year is then asked for by default rather than silently missing from every
-- form because a plan written last year had never heard of it.
--
-- Nothing is seeded here. No setting means the standard set, which is exactly
-- what every property has had until now.
--
-- ATTACHING THE PAPER
-- A Ghana Card number typed into a box is a claim. A photograph of the card is
-- the thing the Labour Department, SSNIT and an auditor actually want to see,
-- and the person holding the card has it in their hand and a camera in the same
-- device. Until now only the office could put a file on a record, which meant
-- somebody photographing a certificate, sending it by WhatsApp, and a manager
-- saving it out and uploading it — three steps, each of which stops happening.
--
-- What arrives this way is a claim like any other. It does not go on the file:
-- it waits, is looked at, and is accepted or sent back. The doctrine the rest
-- of self-service already follows — a submission is never a record — is the
-- whole reason this is safe to open up.

-- Waiting, on the file, or turned down. Everything already stored was put there
-- by the office, and 'filed' is what that means.
ALTER TABLE hr_document ADD COLUMN status TEXT NOT NULL DEFAULT 'filed';

-- Who put it there. Kept even after a file is accepted, because "the office
-- scanned this" and "the person sent this in from their phone" are different
-- provenances and only one of them was ever seen on paper by a colleague.
ALTER TABLE hr_document ADD COLUMN source TEXT NOT NULL DEFAULT 'office';

-- Which link it came in on, so it can be shown beside the rest of what that
-- link brought in and so a revoked link's uploads can be found.
ALTER TABLE hr_document ADD COLUMN invite_id INTEGER REFERENCES hr_invite (id) ON DELETE SET NULL;

-- What the person said about it, and afterwards why it was turned down.
ALTER TABLE hr_document ADD COLUMN note TEXT;
ALTER TABLE hr_document ADD COLUMN decided_by TEXT;
ALTER TABLE hr_document ADD COLUMN decided_at TEXT;

CREATE INDEX IF NOT EXISTS idx_hr_document_waiting ON hr_document (status, uploaded_at);
CREATE INDEX IF NOT EXISTS idx_hr_document_invite ON hr_document (invite_id);
