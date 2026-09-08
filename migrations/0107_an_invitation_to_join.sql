-- An invitation to join, and the person chooses how they will sign in.
--
-- Until now a login was made with its credentials already in it: whoever
-- created the account typed a PIN and then had to get that PIN to the person,
-- by saying it across a desk or putting it in a message. Both are the same
-- problem — the thing that opens the account travels through somebody else's
-- hands, and it is a thing the person never chose and will not remember.
--
-- So the account can be made empty and the person invited into it. They open a
-- link sent to their own address and set their own way in. WHICH WAY IS THEIRS
-- TO PICK. A housekeeper on a corridor tablet wants six digits she can key with
-- one hand; whoever does the wages wants an email address and a password their
-- browser already knows. Neither is right for the other, and the app has no
-- business deciding which of them somebody is.
--
-- ONE USE, AND NOT FOR LONG. The token is the whole of the link, so only its
-- fingerprint is kept here: a copy of this database opens nothing. It is spent
-- the moment credentials are set, and it expires on its own besides, because an
-- invitation still live in a mailbox six months later is a way into the
-- property that nobody is thinking about any more.
CREATE TABLE IF NOT EXISTS user_invite (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Where it was sent. Kept because it is the address a password sign-in would
  -- use, and because "who was this sent to" is the question afterwards.
  email      TEXT    NOT NULL,
  token_hash TEXT    NOT NULL UNIQUE,
  expires_at TEXT    NOT NULL,
  created_by TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Whether the provider took it. A link made and never sent is worth telling
  -- apart from one sent and ignored.
  sent_at    TEXT,
  opened_at  TEXT,
  used_at    TEXT,
  -- 'pin' or 'password'. What they picked, for the account list to say.
  chose      TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_invite_user ON user_invite (user_id, created_at DESC);
