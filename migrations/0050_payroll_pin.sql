-- A PIN of your own, asked every time the payroll is opened.
--
-- The grant and the code an administrator hands over say somebody may open the
-- payroll. Neither says the person sitting in front of the screen right now is
-- them. A code that buys eight hours is a code typed once in the morning, and
-- for the rest of the day the payroll belongs to whoever walks past the desk.
--
-- So everybody who opens the payroll now has a PIN of their own, chosen by
-- them, different from the one they sign in with, and asked for every single
-- time they open the tab. Administrators included: they are the people most
-- likely to leave a machine unlocked in an office, and the ones with the most
-- to show on it.
--
-- The grant columns become optional, because an administrator is never granted
-- anything and yet now needs a row of their own to keep a PIN in.
CREATE TABLE pay_access_new (
  user_id        INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,

  -- The administrator's code. Null for an administrator's own row, who is the
  -- one handing codes out. It is not spent by being used: it stays valid for
  -- the life of the grant, because it is also how somebody who has forgotten
  -- their PIN proves they may choose another.
  code_hash      TEXT,
  granted_by     TEXT,
  granted_at     TEXT,
  -- The day the grant dies. Null means it does not, which is only ever an
  -- administrator's own row.
  expires_at     TEXT,

  -- The PIN, kept as a fingerprint like every other secret here. Hashed under
  -- its own label so it can never be compared against a login PIN, in this
  -- database or in a copy of it.
  pin_hash       TEXT,
  pin_set_at     TEXT,

  -- The working window the PIN buys. Short, and it slides while somebody is
  -- actually working; the screen drops it the moment they leave the tab.
  unlocked_at    TEXT,
  unlocked_until TEXT,

  -- Wrong PINs and wrong codes, counted together. Cleared by a right one.
  tries          INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT,

  note           TEXT
);

INSERT INTO pay_access_new (
  user_id, code_hash, granted_by, granted_at, expires_at,
  unlocked_at, unlocked_until, tries, locked_until, note
)
SELECT user_id, code_hash, granted_by, granted_at, expires_at,
       -- Nobody carries an old unlock through this: the rule changed under
       -- them, and the first thing everyone should meet is the new question.
       NULL, NULL, 0, NULL, note
  FROM pay_access;

DROP TABLE pay_access;
ALTER TABLE pay_access_new RENAME TO pay_access;

CREATE INDEX IF NOT EXISTS idx_pay_access_expires ON pay_access (expires_at);
