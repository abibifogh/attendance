-- Stock from Odoo: every line of every confirmed PO, offered to the breakfast
-- store and the Maintenance store, and what became of it.
CREATE TABLE IF NOT EXISTS stock_line (
  line_id      INTEGER PRIMARY KEY,          -- Odoo purchase.order.line id
  po           TEXT,
  po_id        INTEGER,
  supplier     TEXT,
  confirmed_on TEXT,
  product_id   INTEGER,
  uom_id       INTEGER NOT NULL DEFAULT 0,
  product      TEXT,
  uom          TEXT,
  qty          REAL,
  price        REAL,
  app          TEXT,                          -- breakfast | maintenance | none, or NULL while not placed
  state        TEXT NOT NULL DEFAULT 'new',   -- new | ask | none | recorded | expected | received | already | cancelled | kept | waiting
  item         TEXT,
  store_qty    REAL,
  store_unit   TEXT,
  unit_cost    REAL,
  received     REAL,
  received_by  TEXT,
  received_at  TEXT,
  note         TEXT,
  first_seen   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_line_state ON stock_line (state);
CREATE INDEX IF NOT EXISTS idx_stock_line_product ON stock_line (product_id, uom_id);
CREATE INDEX IF NOT EXISTS idx_stock_line_po ON stock_line (po_id);

-- Odoo products somebody said are not stock for either store.
CREATE TABLE IF NOT EXISTS stock_product (
  product_id INTEGER NOT NULL,
  uom_id     INTEGER NOT NULL DEFAULT 0,
  product    TEXT,
  by_name    TEXT,
  at         TEXT NOT NULL,
  PRIMARY KEY (product_id, uom_id)
);

-- Stock when the PO is confirmed, from POs confirmed on 4 November 2026 on.
INSERT OR IGNORE INTO settings (key, value) VALUES ('stock_feed', '{"mode":"confirmed","from":"2026-11-04"}');
