-- Letters: the register, who signs them, and the proof that they did.
--
-- A hotel writes letters. To a supplier about a debt, to the Labour Department
-- about a dispute, to a guest about a complaint, to a bank about a mandate. In
-- most small properties they live in a Word folder and a sent-items box, and
-- six months later nobody can say what was sent, when, who signed it, or
-- whether the reply ever came.
--
-- What a correspondence register is for is answering those four questions. So
-- every letter here has a reference the moment it exists, a named recipient, a
-- state you can see at a glance, and a chain of events behind it.
--
-- THE CHAIN
-- ---------
-- The event log is hash-linked. Each row carries the hash of the row before it
-- and its own hash over that plus its own contents, so a row that is edited or
-- removed breaks every hash after it and the letter reports itself as altered.
-- An audit trail that can be quietly rewritten is not an audit trail, and this
-- is the cheapest honest way to make one that cannot be.

-- ---------------------------------------------------------------------------
-- Reference numbers
-- ---------------------------------------------------------------------------

-- A reference is allocated when a letter is created and never reused, so a gap
-- in the sequence is a question worth asking rather than a bug.
CREATE TABLE IF NOT EXISTS corr_series (
  code        TEXT    PRIMARY KEY,
  label       TEXT    NOT NULL,
  prefix      TEXT    NOT NULL,
  year        INTEGER NOT NULL,
  next_number INTEGER NOT NULL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 1
);

INSERT INTO corr_series (code, label, prefix, year, next_number) VALUES
  ('ADM', 'General administration', 'SN/ADM', CAST(strftime('%Y', 'now') AS INTEGER), 1),
  ('HR',  'Staff and employment',   'SN/HR',  CAST(strftime('%Y', 'now') AS INTEGER), 1),
  ('FIN', 'Suppliers and accounts', 'SN/FIN', CAST(strftime('%Y', 'now') AS INTEGER), 1),
  ('GST', 'Guests',                 'SN/GST', CAST(strftime('%Y', 'now') AS INTEGER), 1)
  ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Who letters go to
-- ---------------------------------------------------------------------------

-- Not att_staff. Most correspondence leaves the building: a supplier, a bank,
-- the Labour Department, a guest, a lawyer. A member of staff can be a party
-- too, and then staff_id points back at them so the two records stay joined.
CREATE TABLE IF NOT EXISTS corr_party (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT    NOT NULL DEFAULT 'other',  -- supplier|authority|guest|staff|bank|other
  name         TEXT    NOT NULL,
  organisation TEXT,
  job_title    TEXT,
  email        TEXT,
  phone        TEXT,
  address      TEXT,
  staff_id     INTEGER REFERENCES att_staff (id) ON DELETE SET NULL,
  note         TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_by   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_corr_party_name ON corr_party (active, name);

-- ---------------------------------------------------------------------------
-- Files
-- ---------------------------------------------------------------------------

-- The same pieces-of-a-file arrangement the personnel records use, and for the
-- same reason: a scanned letter is routinely larger than a database row will
-- hold. Separate from hr_document because that one belongs to a member of
-- staff by definition, and a letter to a supplier belongs to nobody.
CREATE TABLE IF NOT EXISTS corr_file (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  filename    TEXT,
  mime        TEXT    NOT NULL,
  bytes       INTEGER NOT NULL,
  sha256      TEXT    NOT NULL,
  content     BLOB    NOT NULL,
  parts       INTEGER NOT NULL DEFAULT 1,
  uploaded_by TEXT,
  uploaded_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS corr_file_part (
  file_id INTEGER NOT NULL REFERENCES corr_file (id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL,
  content BLOB    NOT NULL,
  PRIMARY KEY (file_id, seq)
);

-- ---------------------------------------------------------------------------
-- The letters themselves
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS corr_letter (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  reference     TEXT    NOT NULL UNIQUE,
  series        TEXT    REFERENCES corr_series (code) ON DELETE SET NULL,
  direction     TEXT    NOT NULL DEFAULT 'outgoing',   -- outgoing | incoming
  subject       TEXT    NOT NULL,

  -- A letter is either written here or written elsewhere and uploaded. Both
  -- are ordinary letters in the register; only one of them has words in the
  -- database, and the screens read `source` rather than guessing from nulls.
  source        TEXT    NOT NULL DEFAULT 'composed',   -- composed | uploaded
  body          TEXT,
  body_hash     TEXT,
  template_id   INTEGER REFERENCES hr_template (id) ON DELETE SET NULL,
  file_id       INTEGER REFERENCES corr_file (id) ON DELETE SET NULL,

  party_id      INTEGER REFERENCES corr_party (id) ON DELETE SET NULL,
  -- Kept beside the party so a letter still reads correctly years after
  -- somebody tidied the address book.
  addressed_to  TEXT,
  address       TEXT,

  status        TEXT    NOT NULL DEFAULT 'draft',
  -- draft | awaiting_signature | signed | sent | closed | void | filed

  -- Signed for the property. A stored signature is applied only by the person
  -- it belongs to, after they have proved who they are again.
  signed_by     TEXT,
  signed_title  TEXT,
  signature_ink TEXT,
  signed_at     TEXT,
  stamp_id      INTEGER,
  stamped_at    TEXT,

  sent_at       TEXT,
  sent_via      TEXT,          -- email | hand | post | courier | whatsapp
  sent_note     TEXT,
  response_due  TEXT,
  closed_at     TEXT,
  closed_note   TEXT,

  -- A reply belongs to the letter it answers, so a thread reads in order.
  replies_to    INTEGER REFERENCES corr_letter (id) ON DELETE SET NULL,

  created_by    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_corr_letter_status ON corr_letter (status, created_at);
CREATE INDEX IF NOT EXISTS idx_corr_letter_party  ON corr_letter (party_id, created_at);
CREATE INDEX IF NOT EXISTS idx_corr_letter_due    ON corr_letter (response_due) WHERE response_due IS NOT NULL;

-- Anything sent with the letter: a schedule, an invoice, a photograph.
CREATE TABLE IF NOT EXISTS corr_enclosure (
  letter_id INTEGER NOT NULL REFERENCES corr_letter (id) ON DELETE CASCADE,
  file_id   INTEGER NOT NULL REFERENCES corr_file (id) ON DELETE CASCADE,
  PRIMARY KEY (letter_id, file_id)
);

-- ---------------------------------------------------------------------------
-- Asking somebody outside to sign
-- ---------------------------------------------------------------------------

-- One row per person the letter goes to for signature, in the order they are
-- to sign it. Only the earliest unsigned one has a live link: a document that
-- can be counter-signed before it is signed is a document nobody can reason
-- about afterwards.
CREATE TABLE IF NOT EXISTS corr_recipient (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  letter_id     INTEGER NOT NULL REFERENCES corr_letter (id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL DEFAULT 1,
  role          TEXT    NOT NULL DEFAULT 'signer',   -- signer | approver | copy
  party_id      INTEGER REFERENCES corr_party (id) ON DELETE SET NULL,
  name          TEXT    NOT NULL,
  organisation  TEXT,
  email         TEXT,
  phone         TEXT,

  token_hash    TEXT    UNIQUE,
  -- An access code, in the sense every e-signing product uses the phrase: a
  -- short secret told to the recipient by another channel, entered before the
  -- document opens at all.
  code_hash     TEXT,
  -- A one-time code emailed at the moment of signing, where an address is
  -- known. A link can be forwarded; a code sent to the address on file and
  -- typed back within a few minutes is much harder to be somebody else for.
  otp_hash      TEXT,
  otp_sent_at   TEXT,
  otp_tries     INTEGER NOT NULL DEFAULT 0,
  verified_at   TEXT,

  expires_at    TEXT,
  status        TEXT    NOT NULL DEFAULT 'pending',  -- pending|opened|signed|declined|revoked
  opened_at     TEXT,
  signed_at     TEXT,
  signer_name   TEXT,
  signature_ink TEXT,
  signer_ip     TEXT,
  signer_agent  TEXT,
  decline_note  TEXT
);
CREATE INDEX IF NOT EXISTS idx_corr_recipient_letter ON corr_recipient (letter_id, seq);

-- ---------------------------------------------------------------------------
-- Signatures and the company stamp
-- ---------------------------------------------------------------------------

-- One stored signature per user, and it belongs to them. Nobody else can
-- apply it — not an administrator, not the person who set the system up. A
-- stored signature that anybody with a login can stamp onto a letter is a
-- forgery machine, and the whole value of holding one is that it is not.
CREATE TABLE IF NOT EXISTS corr_signatory (
  user_id       INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  display_name  TEXT    NOT NULL,
  job_title     TEXT,
  signature_ink TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
);

-- The company stamp. An image, applied beside a signature and recorded when it
-- is. Small enough to keep as a data URI rather than in pieces.
CREATE TABLE IF NOT EXISTS corr_stamp (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT    NOT NULL,
  image       TEXT    NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  uploaded_by TEXT,
  uploaded_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- The chain
-- ---------------------------------------------------------------------------

-- Hash-linked, and that is the whole point. `hash` is taken over the previous
-- row's hash together with this row's own contents, so removing a row or
-- editing one breaks every hash after it and the letter reports itself as
-- altered. Nothing in the app updates or deletes a row here.
CREATE TABLE IF NOT EXISTS corr_event (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  letter_id INTEGER NOT NULL REFERENCES corr_letter (id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  kind      TEXT    NOT NULL,
  actor     TEXT,
  detail    TEXT,
  ip        TEXT,
  agent     TEXT,
  at_utc    TEXT    NOT NULL,
  prev_hash TEXT    NOT NULL,
  hash      TEXT    NOT NULL,
  UNIQUE (letter_id, seq)
);

-- How long a signing link lasts, in days.
INSERT INTO settings (key, value) VALUES ('corr_link_days', '14')
  ON CONFLICT (key) DO NOTHING;
