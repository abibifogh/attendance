-- ---------------------------------------------------------------------------
-- The staff handbook
-- ---------------------------------------------------------------------------
--
-- A hotel's rules live in three places: a Word file on somebody's laptop, a
-- printout in the office that is two versions old, and whatever the supervisor
-- on duty remembers. When something goes wrong the question is always the same
-- and never answerable: was this person ever told, and told what exactly.
--
-- So a chapter is a row, and it carries TWO bodies.
--
-- `body` is what an administrator is working on. `live_body` is what staff are
-- reading. Editing one does nothing to the other, and Publish is the single
-- moment they meet. This is the rota's draft-and-publish over again, for the
-- same reason: half-written words in front of the property are worse than no
-- words at all.
--
-- `asks` is what a chapter wants back from the person reading it:
--   read   nothing. A reference page.
--   ack    a tick, recorded against their name.
--   sign   their name and a drawn mark, like a contract.
--
-- An acknowledgement is against a VERSION AND A HASH of the exact words. A
-- chapter republished with changes moves to the next version, and everybody is
-- asked again, because "he acknowledged the handbook" is not an answer when
-- the handbook has been rewritten since.

CREATE TABLE IF NOT EXISTS hb_chapter (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Stable across renames, so a seeded chapter can be recognised and never
  -- installed twice over the top of somebody's edits.
  code        TEXT    NOT NULL UNIQUE,
  title       TEXT    NOT NULL,
  -- One line under the title on the list, so somebody can find the right
  -- chapter without opening four.
  summary     TEXT,
  body        TEXT    NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 100,

  asks        TEXT    NOT NULL DEFAULT 'read',    -- read | ack | sign

  -- Who it is for. Null on both is everybody. A JSON array of department names,
  -- of staff tags, or both: the charter for team leads is a tag, the kitchen's
  -- food safety rules are a department, and most of it is neither.
  departments TEXT,
  tags        TEXT,

  status      TEXT    NOT NULL DEFAULT 'draft',   -- draft | published | retired

  -- What staff are actually reading, frozen at the moment it was published.
  version     INTEGER NOT NULL DEFAULT 0,
  live_body   TEXT,
  live_title  TEXT,
  live_hash   TEXT,
  live_asks   TEXT,
  published_at TEXT,
  published_by TEXT,

  created_by  TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_by  TEXT,
  updated_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_hb_chapter_live ON hb_chapter (status, sort_order);

-- One row per person per version. The unique index is the whole of the
-- "have they" question: a second tick on the same words is the same tick.
CREATE TABLE IF NOT EXISTS hb_ack (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id  INTEGER NOT NULL REFERENCES hb_chapter (id) ON DELETE CASCADE,
  staff_id    INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  -- A fingerprint of the exact words, kept beside the version so a record can
  -- be checked rather than believed.
  hash        TEXT,
  asked       TEXT    NOT NULL DEFAULT 'ack',     -- what it wanted at the time

  -- A signature, where the chapter asked for one. Same two forms a contract
  -- takes: a typed name, and a drawn mark for the ones people expect to see.
  signer_name TEXT,
  signature_ink TEXT,
  signer_ip   TEXT,
  signer_agent TEXT,

  at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hb_ack_once
  ON hb_ack (chapter_id, staff_id, version);
CREATE INDEX IF NOT EXISTS idx_hb_ack_staff ON hb_ack (staff_id);

-- Off until somebody puts something in it. An empty handbook link on every
-- phone is a link that teaches people the app has nothing to say.
INSERT OR IGNORE INTO settings (key, value) VALUES ('handbook_on', '0');
