-- Fixed assets, as Insight finds them in Odoo (src/routes/fixedassets.js).
--
-- Each thing that may be a fixed asset, once: an asset record from Odoo's
-- Assets app, a line posted to a fixed asset account, or a new purchase that
-- looks like an asset (its name and its cost). An admin decides each: it is
-- an asset (added to the equipment register in Maintenance, one entry per
-- unit, each with its NCA tag), or it is not (and that product is not asked
-- about again).

CREATE TABLE IF NOT EXISTS fa_item (
  key              TEXT PRIMARY KEY,           -- line:<Odoo move line id> | asset:<Odoo account.asset id>
  kind             TEXT NOT NULL,              -- purchase | account | odoo_asset
  name             TEXT NOT NULL,
  product          TEXT,                       -- the product, as "not an asset" remembers it
  qty              REAL NOT NULL DEFAULT 1,
  unit_cost        INTEGER NOT NULL DEFAULT 0, -- minor units, before tax
  amount           INTEGER NOT NULL DEFAULT 0,
  supplier         TEXT,
  day              TEXT,
  doc              TEXT,                       -- the Odoo document: a bill, a journal entry, an asset
  account_code     TEXT,
  account_name     TEXT,
  on_asset_account INTEGER NOT NULL DEFAULT 0,
  why              TEXT,                       -- JSON: why a purchase was picked out
  state            TEXT NOT NULL DEFAULT 'review', -- review | registered | not_asset
  units            TEXT,                       -- JSON: what went on the register (tag, name, room)
  decided_by       TEXT,
  decided_at       TEXT,
  seen_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fa_item_state ON fa_item (state, day);

-- Products an admin said are not fixed assets: new purchases of them are not asked about.
CREATE TABLE IF NOT EXISTS fa_not_asset (
  product TEXT PRIMARY KEY,
  by_name TEXT,
  at      TEXT NOT NULL
);

-- Every NCA tag given, so a number is never given twice.
CREATE TABLE IF NOT EXISTS fa_tag (
  n    INTEGER PRIMARY KEY,
  key  TEXT NOT NULL,
  name TEXT NOT NULL,
  at   TEXT NOT NULL
);
