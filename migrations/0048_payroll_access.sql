-- Payroll is not opened by holding a permission.
--
-- What somebody is paid is the most sensitive thing this app knows, and until
-- now one tick on a login was the whole of the protection. A tick is set once
-- and forgotten; it survives somebody changing job, and it is not obvious from
-- looking at a screen who currently holds it.
--
-- Three locks instead of one. The permission says the person is the kind of
-- person who might. A grant, made deliberately by an administrator and with an
-- end date on it, says they may at the moment. A code they have to type says
-- it is them and not somebody who found the tablet unlocked, and the unlock it
-- buys them runs out on its own.
--
-- Administrators are not granted anything: they are the ones who grant. A
-- property with one administrator must never be able to lock itself out of its
-- own payroll.
CREATE TABLE IF NOT EXISTS pay_access (
  user_id        INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,

  -- The code, kept as a fingerprint the way every other code in this app is.
  -- It lives as long as the grant does, because the unlock is what expires
  -- quickly and somebody must be able to get back in the same afternoon.
  code_hash      TEXT    NOT NULL,

  granted_by     TEXT    NOT NULL,
  granted_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  -- The day the grant itself dies. After this the code opens nothing and an
  -- administrator has to decide again.
  expires_at     TEXT    NOT NULL,

  -- The last time the code was typed, and how long that bought. A closed
  -- laptop in an office does not stay open on the payroll all week.
  unlocked_at    TEXT,
  unlocked_until TEXT,

  -- Wrong codes, so guessing is not free. Cleared by a correct one.
  tries          INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT,

  note           TEXT
);

CREATE INDEX IF NOT EXISTS idx_pay_access_expires ON pay_access (expires_at);
