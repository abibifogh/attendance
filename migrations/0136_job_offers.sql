-- A job offer, with the contract to read and sign, before anybody is on the books.
--
-- The office fills in the job, the start date and the terms; HIVE renders the
-- contract from a template there and then, fixes the words with a hash, and
-- sends the candidate a link. They read it and accept by signing it (with a
-- code sent to them first, where one can reach them), or decline with a
-- reason. Nothing is written to att_staff here: taking them on is still the
-- one door, and it carries the signed contract onto their new record.
CREATE TABLE IF NOT EXISTS rec_offer (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id    INTEGER NOT NULL REFERENCES rec_candidate (id) ON DELETE CASCADE,
  template_id     INTEGER REFERENCES hr_template (id) ON DELETE SET NULL,
  title           TEXT    NOT NULL,
  job_title       TEXT,
  department      TEXT,
  start_date      TEXT,
  employee_no     TEXT,
  -- JSON of everything that filled the placeholders, as for a contract.
  fields          TEXT,
  message         TEXT,
  -- The exact words, fixed when the offer was made.
  body            TEXT    NOT NULL,
  body_hash       TEXT    NOT NULL,

  -- The link: checked against the hash, and sealed so a reminder can carry
  -- the same link again.
  token_hash      TEXT    NOT NULL UNIQUE,
  token_box       TEXT,
  sent_by         TEXT,                          -- email | text | link
  status          TEXT    NOT NULL DEFAULT 'sent', -- sent | accepted | declined | withdrawn
  expires_at      TEXT    NOT NULL,
  remind          INTEGER NOT NULL DEFAULT 1,
  reminded_at     TEXT,
  created_by      TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  opened_at       TEXT,

  -- The code before signing, as on a details link.
  otp_hash        TEXT,
  otp_sent_at     TEXT,
  otp_tries       INTEGER NOT NULL DEFAULT 0,
  otp_sent_to     TEXT,
  otp_verified_at TEXT,

  -- Their signature, which is their acceptance.
  signed_at       TEXT,
  signer_name     TEXT,
  signature_ink   TEXT,
  signer_ip       TEXT,
  signer_agent    TEXT,
  signer_check    TEXT,

  declined_at     TEXT,
  decline_reason  TEXT,
  decline_note    TEXT,
  withdrawn_at    TEXT,
  withdrawn_by    TEXT,

  -- The contract it became on their staff record, once they were taken on.
  contract_id     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rec_offer_candidate ON rec_offer (candidate_id, id);
CREATE INDEX IF NOT EXISTS idx_rec_offer_open ON rec_offer (status, expires_at);

-- Which offer a line on the candidate's trail is about, so the signed
-- contract can carry the same chain of events onto their staff record.
ALTER TABLE rec_event ADD COLUMN offer_id INTEGER;
