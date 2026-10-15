-- ------------------------------------------------------- Odoo activities --

-- Activities read from Odoo (never written there). Each read keeps the open
-- ones; one no longer open is marked gone, which is how a done one keeps its
-- due date for "done late".
CREATE TABLE IF NOT EXISTS odoo_activity (
  id          INTEGER PRIMARY KEY,   -- Odoo's mail.activity id
  model       TEXT,                  -- what it is on: purchase.order, account.move, …
  res_id      INTEGER,
  res_name    TEXT,
  type        TEXT,                  -- To-Do, Call, Approval, …
  summary     TEXT,
  note        TEXT,
  deadline    TEXT,
  user_id     INTEGER,               -- Odoo user it is for
  user_name   TEXT,
  partner     TEXT,                  -- the supplier, on a PO or a bill
  amount      INTEGER,
  seen_at     TEXT NOT NULL,
  read_id     TEXT,                  -- the read that last saw it open
  gone_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_odoo_activity_open ON odoo_activity (gone_at, user_id);

-- Activities marked done, from the messages Odoo writes for them.
CREATE TABLE IF NOT EXISTS odoo_activity_done (
  id          INTEGER PRIMARY KEY,   -- Odoo's mail.message id
  model       TEXT,
  res_id      INTEGER,
  res_name    TEXT,
  type        TEXT,
  user_id     INTEGER,               -- who did it, as an Odoo user
  done_at     TEXT
);

-- Odoo's own people, as last read.
CREATE TABLE IF NOT EXISTS odoo_user (
  id          INTEGER PRIMARY KEY,
  name        TEXT,
  login       TEXT,
  email       TEXT,
  partner_id  INTEGER
);

-- Who is who: an Insight account and its Odoo user, set by an admin.
CREATE TABLE IF NOT EXISTS odoo_link (
  account_id    INTEGER PRIMARY KEY,
  odoo_user_id  INTEGER NOT NULL,
  odoo_name     TEXT,
  by_name       TEXT,
  at            TEXT NOT NULL
);
