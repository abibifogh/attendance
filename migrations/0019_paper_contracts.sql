-- Contracts that were signed on paper, and files too big for one row.
--
-- Everybody already working here signed something, on paper, years ago. Those
-- contracts are the ones that matter most — they are the only record of what
-- was agreed with most of the staff — and until now there was nowhere to put
-- them but the "documents" pile, where they sat beside a photocopied ID with
-- nothing saying they were a contract at all.
--
-- So a contract can now be either kind. An electronic one holds the words and
-- the signature; a paper one holds the scan and says who signed it and when.
-- Both appear in the same list, both satisfy the same file requirement, and
-- the certificate says plainly which sort it is looking at — because the
-- evidence behind them is not the same, and a screen that implied it was would
-- be worse than one that showed nothing.

-- Where the contract came from, and the scan if it came in on paper.
ALTER TABLE hr_contract ADD COLUMN origin TEXT NOT NULL DEFAULT 'electronic';
ALTER TABLE hr_contract ADD COLUMN document_id INTEGER REFERENCES hr_document (id) ON DELETE SET NULL;
-- Which requirement in the personnel-file checklist a signed copy ticks off.
ALTER TABLE hr_contract ADD COLUMN satisfies TEXT;
-- Recorded on a paper contract: who filed the scan, and when they did it. Not
-- the same fact as who signed it, and worth keeping apart.
ALTER TABLE hr_contract ADD COLUMN filed_by TEXT;
ALTER TABLE hr_contract ADD COLUMN filed_at TEXT;

-- Templates carry the code of the standard one they came from, so the set can
-- be offered again later without duplicating what is already there, and so a
-- signed copy knows which requirement it answers.
ALTER TABLE hr_template ADD COLUMN code TEXT;
ALTER TABLE hr_template ADD COLUMN satisfies TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_template_code ON hr_template (code) WHERE code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Files larger than a row
-- ---------------------------------------------------------------------------

-- D1 will not hold a row larger than about two megabytes, and a scanned
-- five-page contract is routinely more than that. A photograph can be shrunk
-- in the browser; a PDF cannot, and refusing it would send somebody back to
-- keeping the contracts in a filing cabinet.
--
-- So a file is stored in pieces. The first piece stays in hr_document.content,
-- which is where every file already is and which keeps small ones exactly as
-- they were; the rest go here in order. Reading a document is the first piece
-- followed by these.
CREATE TABLE IF NOT EXISTS hr_document_part (
  document_id INTEGER NOT NULL REFERENCES hr_document (id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  content     BLOB    NOT NULL,
  PRIMARY KEY (document_id, seq)
);

-- How many pieces a file is in. One means it is entirely in the row itself,
-- which is true of everything stored before today.
ALTER TABLE hr_document ADD COLUMN parts INTEGER NOT NULL DEFAULT 1;
