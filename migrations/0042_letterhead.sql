-- Letterheads, and letters laid out on them.
--
-- WHAT WAS WRONG WITH THE OLD ONE. A letter was a box of plain text. It went
-- into the register correctly, it was signed correctly, the chain of evidence
-- under it was sound — and it did not look like a letter from this property,
-- because there was nowhere to put the letterhead and no way to lay anything
-- out. So letters kept being written in Word and uploaded, which is the one
-- outcome the register exists to prevent.
--
-- A letterhead is the printed paper the property already has: the crest, the
-- name, the address along the bottom. It is uploaded once, as an image of the
-- page, and every letter is laid out on top of it.
--
-- THE LAYOUT IS BLOCKS ON A PAGE, IN PER CENT. A block knows where it sits as
-- a percentage of the page rather than in pixels, so the same numbers draw the
-- letter on a phone, on a laptop and on A4 at three hundred dots an inch
-- without anything being recomputed on the way.
--
-- WHY THE HTML IS SANITISED ON THE WAY IN. The words of a letter are shown
-- back to somebody outside the property on the signing page. Anything stored
-- here is therefore untrusted markup by definition, and it is cleaned against
-- an allowlist as it is saved rather than as it is displayed — display happens
-- in four places and one of them will always be forgotten.

CREATE TABLE IF NOT EXISTS corr_letterhead (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT    NOT NULL,
  -- The image of the page, in the file store the rest of correspondence uses.
  file_id  INTEGER NOT NULL REFERENCES corr_file (id) ON DELETE CASCADE,

  -- The safe area, as a percentage of the page. Text is kept inside it, so
  -- nothing lands on the crest at the top or the address along the bottom.
  margin_top    REAL NOT NULL DEFAULT 22,
  margin_right  REAL NOT NULL DEFAULT 10,
  margin_bottom REAL NOT NULL DEFAULT 14,
  margin_left   REAL NOT NULL DEFAULT 10,

  -- Whether the same paper is used for a second page. Most properties have
  -- headed first sheets and plain continuation ones.
  later_pages   INTEGER NOT NULL DEFAULT 0,

  active      INTEGER NOT NULL DEFAULT 1,
  uploaded_by TEXT,
  uploaded_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE corr_letter ADD COLUMN letterhead_id INTEGER REFERENCES corr_letterhead (id) ON DELETE SET NULL;
-- The blocks, as JSON. Null on a letter written before any of this, and on one
-- that was uploaded rather than composed.
ALTER TABLE corr_letter ADD COLUMN layout TEXT;

INSERT INTO settings (key, value) VALUES ('corr_default_letterhead', '')
  ON CONFLICT (key) DO NOTHING;
