-- Inviting somebody to Insight.
--
-- Until now an owner added a person and then typed a password for them, which
-- means the owner knew it, and so did whoever it was sent to over WhatsApp.
-- An invitation lets the person choose their own: the owner sets who they are
-- and what they may reach, and a one-time link lets them in to finish it.
--
-- The account itself is made when the invitation is, with no password, so the
-- grid shows them straight away and their access is decided in one place.
-- This table is only the links.

CREATE TABLE IF NOT EXISTS invitations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- SHA-256 of the token in the link. The token itself is never kept, for the
  -- same reason the hand-off codes are not: a copy of this database should not
  -- be a set of working ways in.
  token_hash      TEXT    NOT NULL UNIQUE,
  note            TEXT,
  invited_by_id   INTEGER,
  invited_by_name TEXT,
  invited_by_email TEXT,
  sent_via        TEXT    NOT NULL DEFAULT 'email',   -- email | link
  email_error     TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT    NOT NULL,
  opened_at       TEXT,
  -- At most one of these four ends a link.
  used_at         TEXT,
  withdrawn_at    TEXT,
  replaced_at     TEXT,
  -- The person opened a link that no longer worked and asked for a new one.
  asked_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_invitations_account ON invitations (account_id, id DESC);
