-- The finished, signed copy of a contract or a letter, kept as a PDF, and
-- its fingerprint, so anybody can check a copy is genuine at /verify.
ALTER TABLE hr_contract ADD COLUMN final_hash TEXT;
ALTER TABLE hr_contract ADD COLUMN final_document_id INTEGER;
ALTER TABLE corr_letter ADD COLUMN final_hash TEXT;
ALTER TABLE corr_letter ADD COLUMN final_file_id INTEGER;

-- Every fingerprint HIVE has issued a signed copy under. Looked up by the
-- hash alone; nothing about the document is shown unless the hash matches.
CREATE TABLE IF NOT EXISTS verify_hash (
  hash        TEXT    PRIMARY KEY,
  kind        TEXT    NOT NULL,          -- contract | letter
  ref_id      INTEGER NOT NULL,
  reference   TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  signers     TEXT,                      -- names, comma separated
  completed_at TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
