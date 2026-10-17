-- --------------------------------------------- Proof asked for an answer --

-- An admin (or somebody an admin allows) asks whoever gave an answer for
-- proof: a MoMo screenshot, a terminal slip, a statement. It goes to them,
-- in Insight (a supervisor's answer) or in HIVE (a staff answer from My till),
-- and they send pictures or PDFs back, or say why they cannot.
CREATE TABLE IF NOT EXISTS proof_request (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- What the answer was on: answer:<exception key> | link:<shift_link id> | issue:<till issue key>
  target        TEXT    NOT NULL,
  about         TEXT,                 -- the answer itself, in words, as it was asked about
  asked_account INTEGER,              -- an Insight account (a supervisor's answer)
  asked_hive    INTEGER,              -- a HIVE user (a staff answer from My till)
  asked_name    TEXT,
  kinds         TEXT,                 -- JSON: what to send
  note          TEXT,
  asked_by      TEXT    NOT NULL,
  asked_at      TEXT    NOT NULL,
  -- asked | sent | cannot | cancelled
  status        TEXT    NOT NULL DEFAULT 'asked',
  reply         TEXT,
  replied_at    TEXT,
  reminders     INTEGER NOT NULL DEFAULT 0,
  reminded_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_proof_target ON proof_request (target, id);
CREATE INDEX IF NOT EXISTS idx_proof_status ON proof_request (status);

-- What was sent: a picture (shrunk on the phone) or a PDF, base64.
CREATE TABLE IF NOT EXISTS proof_file (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  name       TEXT,
  type       TEXT    NOT NULL,
  data       TEXT    NOT NULL,
  at         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proof_file ON proof_file (request_id);
