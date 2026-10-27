-- Buying › Suppliers. Odoo is the list of suppliers; Insight keeps a copy of
-- it (refreshed from Odoo) and only adds what Odoo does not hold.

-- Odoo's vendors as last read: name, contact, tax number, terms, bank accounts.
CREATE TABLE IF NOT EXISTS supplier_odoo (
  odoo_id      INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  match_key    TEXT    NOT NULL,
  phone        TEXT,
  email        TEXT,
  vat          TEXT,
  address      TEXT,
  terms        TEXT,
  company      INTEGER NOT NULL DEFAULT 0,
  staff        INTEGER NOT NULL DEFAULT 0,   -- a login in Odoo: usually staff, not a supplier
  banks        TEXT    NOT NULL DEFAULT '[]',
  in_odoo      INTEGER NOT NULL DEFAULT 1,   -- 0 once Odoo no longer lists them
  refreshed_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supplier_odoo_key ON supplier_odoo (match_key);

-- What Insight adds: a key supplier and its group, not a supplier at all
-- (hidden), a note, and how they are paid (MoMo, a bank account), which Odoo
-- has no place for. Payment details are for admins and supervisors only.
CREATE TABLE IF NOT EXISTS supplier_extra (
  odoo_id    INTEGER PRIMARY KEY,
  is_key     INTEGER NOT NULL DEFAULT 0,
  grp        TEXT,
  hidden     INTEGER NOT NULL DEFAULT 0,
  note       TEXT,
  pay        TEXT    NOT NULL DEFAULT '{}',
  updated_by TEXT,
  updated_at TEXT
);

-- Another spelling of an Odoo supplier, as typed in the breakfast app, the
-- maintenance store, a receipt or a drawer: its spend counts as theirs.
CREATE TABLE IF NOT EXISTS supplier_alias (
  match_key  TEXT    PRIMARY KEY,
  odoo_id    INTEGER NOT NULL,
  raw_name   TEXT,
  by_name    TEXT,
  at         TEXT    NOT NULL
);

-- Every change made here, for payment details above all.
CREATE TABLE IF NOT EXISTS supplier_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  odoo_id  INTEGER NOT NULL,
  what     TEXT    NOT NULL,
  by_name  TEXT,
  at       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supplier_log ON supplier_log (odoo_id, id);
