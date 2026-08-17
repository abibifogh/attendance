-- Employee records: who somebody is, not just when they clocked in.
--
-- The attendance side knows a person as an employee number and a name, because
-- that is all a turnstile needs. Everything a hotel actually has to hold about
-- the people who work there — where they live, who to ring if something
-- happens, what they signed and when — lives here.
--
-- Two ideas run through the whole thing.
--
-- The first is that what somebody sends you is a claim, and what is in the
-- record is a decision. A self-service form never writes to the record. It
-- lands as a submission with a field-by-field difference against what is
-- already there, and somebody accepts it. This is the same shape as the rota
-- import and for the same reason: a system that writes first and reports
-- afterwards is one nobody dares hand to twenty-four people at once.
--
-- The second is that a signature is only worth what you can show about it. So
-- a contract keeps the exact text that was signed, a hash of that text, and a
-- sequential log of every event — sent, opened, read, signed — with the time,
-- the address it came from and the browser that did it.

-- ---------------------------------------------------------------------------
-- The record
-- ---------------------------------------------------------------------------

-- One row per person, alongside att_staff rather than inside it: attendance
-- reads att_staff on every punch and has no business dragging somebody's home
-- address through with it.
CREATE TABLE IF NOT EXISTS hr_profile (
  staff_id            INTEGER PRIMARY KEY REFERENCES att_staff (id) ON DELETE CASCADE,

  -- Personal
  preferred_name      TEXT,
  date_of_birth       TEXT,
  gender              TEXT,
  marital_status      TEXT,
  nationality         TEXT,

  -- Where they are and how to reach them
  personal_phone      TEXT,
  alt_phone           TEXT,
  personal_email      TEXT,
  address_line        TEXT,
  town                TEXT,
  region              TEXT,
  digital_address     TEXT,           -- GhanaPostGPS, e.g. GA-183-9271
  landmark            TEXT,

  -- Identification. Sensitive: shown in full only to whoever can manage
  -- records, and masked to everybody else.
  id_type             TEXT,
  id_number           TEXT,
  id_expires_on       TEXT,
  ssnit_number        TEXT,
  tin_number          TEXT,

  -- How they are paid. Sensitive for the same reason.
  pay_method          TEXT,           -- bank | momo | cash
  bank_name           TEXT,
  bank_branch         TEXT,
  account_name        TEXT,
  account_number      TEXT,
  momo_network        TEXT,
  momo_number         TEXT,

  -- Health, only what a first-aider would need in a hurry
  blood_group         TEXT,
  allergies           TEXT,
  medical_notes       TEXT,

  updated_at          TEXT,
  updated_by          TEXT
);

-- Emergency contacts and next of kin. More than one, because the first person
-- you ring does not always answer.
CREATE TABLE IF NOT EXISTS hr_contact (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id     INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL DEFAULT 'emergency',   -- emergency | next_of_kin
  name         TEXT    NOT NULL,
  relationship TEXT,
  phone        TEXT,
  alt_phone    TEXT,
  email        TEXT,
  address      TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_hr_contact_staff ON hr_contact (staff_id, sort_order);

CREATE TABLE IF NOT EXISTS hr_education (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id     INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  level        TEXT,            -- BECE, WASSCE, Diploma, Degree, Certificate…
  institution  TEXT,
  qualification TEXT,
  field        TEXT,
  finished_on  TEXT,            -- a year is enough; stored as text
  sort_order   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_hr_education_staff ON hr_education (staff_id, sort_order);

CREATE TABLE IF NOT EXISTS hr_employment (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id     INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  employer     TEXT,
  job_title    TEXT,
  from_on      TEXT,
  to_on        TEXT,
  reason_left  TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_hr_employment_staff ON hr_employment (staff_id, sort_order);

-- Scans and photographs. Held in the database rather than a separate bucket:
-- one binding, one backup, one thing to think about. The browser shrinks a
-- photograph before it is sent, and anything over the row limit is refused
-- with a reason rather than truncated.
CREATE TABLE IF NOT EXISTS hr_document (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id     INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL DEFAULT 'other',
  title        TEXT    NOT NULL,
  filename     TEXT,
  mime         TEXT    NOT NULL,
  bytes        INTEGER NOT NULL,
  content      BLOB    NOT NULL,
  expires_on   TEXT,
  uploaded_by  TEXT,
  uploaded_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hr_document_staff ON hr_document (staff_id, kind);

-- ---------------------------------------------------------------------------
-- Contracts
-- ---------------------------------------------------------------------------

-- What a contract is made from. Placeholders in double braces are filled in
-- when a contract is issued, and the result is frozen — a template edited next
-- year does not quietly change what somebody signed last year.
CREATE TABLE IF NOT EXISTS hr_template (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  kind        TEXT    NOT NULL DEFAULT 'contract',
  body        TEXT    NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS hr_contract (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id      INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  template_id   INTEGER REFERENCES hr_template (id) ON DELETE SET NULL,
  title         TEXT    NOT NULL,
  -- The exact words presented, and their hash. Between them they answer the
  -- only question that matters afterwards: what did this person actually
  -- agree to.
  body          TEXT    NOT NULL,
  body_hash     TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'draft',  -- draft|sent|opened|signed|declined|void
  fields        TEXT,                              -- JSON of what filled the placeholders

  issued_by     TEXT,
  issued_at     TEXT,
  opened_at     TEXT,
  signed_at     TEXT,

  -- The signature itself. A typed name and a drawn mark are both simple
  -- electronic signatures; either is enough, and this property takes both
  -- because a drawn one is what people expect to see on a contract.
  signer_name   TEXT,
  signature_ink TEXT,          -- a drawn mark, as an image data URI
  signer_ip     TEXT,
  signer_agent  TEXT,
  decline_note  TEXT,

  -- Countersigned by the property. A contract signed by one side is an offer.
  employer_name TEXT,
  employer_ink  TEXT,
  employer_at   TEXT,

  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hr_contract_staff ON hr_contract (staff_id, status);

-- ---------------------------------------------------------------------------
-- Links out to the person
-- ---------------------------------------------------------------------------

-- One link, one packet. It can ask for details, or carry contracts to sign, or
-- both — which is how a new starter gets a single message rather than three.
CREATE TABLE IF NOT EXISTS hr_invite (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id      INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  -- Stored as a hash, like a terminal's token: the link is shown once, when it
  -- is made, and a stolen database yields nothing that opens it.
  token_hash    TEXT    NOT NULL UNIQUE,
  -- Four digits, told to the person out loud. Optional, because a link sent
  -- over WhatsApp to a phone that person is holding is already reasonable, and
  -- a code nobody can remember is a link nobody uses.
  pin_hash      TEXT,
  wants_details INTEGER NOT NULL DEFAULT 1,
  message       TEXT,
  expires_at    TEXT    NOT NULL,
  created_by    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  opened_at     TEXT,
  finished_at   TEXT,
  revoked_at    TEXT,
  revoked_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_hr_invite_staff ON hr_invite (staff_id, created_at);

-- Which contracts a packet carries.
CREATE TABLE IF NOT EXISTS hr_invite_contract (
  invite_id   INTEGER NOT NULL REFERENCES hr_invite (id) ON DELETE CASCADE,
  contract_id INTEGER NOT NULL REFERENCES hr_contract (id) ON DELETE CASCADE,
  PRIMARY KEY (invite_id, contract_id)
);

-- What somebody sent in, held until it is looked at. Never written straight
-- into the record: see the note at the top of this file.
CREATE TABLE IF NOT EXISTS hr_submission (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id     INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  invite_id    INTEGER REFERENCES hr_invite (id) ON DELETE SET NULL,
  payload      TEXT    NOT NULL,      -- JSON, exactly as it arrived
  status       TEXT    NOT NULL DEFAULT 'pending',  -- pending|accepted|rejected|superseded
  submitted_at TEXT    NOT NULL DEFAULT (datetime('now')),
  submitted_ip TEXT,
  reviewed_by  TEXT,
  reviewed_at  TEXT,
  review_note  TEXT
);
CREATE INDEX IF NOT EXISTS idx_hr_submission_open ON hr_submission (status, submitted_at);

-- The sequential record every one of these things is judged by afterwards.
-- Append-only by convention: nothing in the app updates or deletes a row here.
CREATE TABLE IF NOT EXISTS hr_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id    INTEGER REFERENCES att_staff (id) ON DELETE CASCADE,
  invite_id   INTEGER,
  contract_id INTEGER,
  kind        TEXT    NOT NULL,   -- link_created|link_opened|contract_viewed|signed|…
  detail      TEXT,
  ip          TEXT,
  agent       TEXT,
  at_utc      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hr_event_staff ON hr_event (staff_id, at_utc);
CREATE INDEX IF NOT EXISTS idx_hr_event_contract ON hr_event (contract_id, at_utc);

-- How long a link lasts before it stops working, in days.
INSERT INTO settings (key, value) VALUES ('hr_link_days', '21')
  ON CONFLICT (key) DO NOTHING;
