CREATE TABLE IF NOT EXISTS att_device_config (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_serial TEXT NOT NULL,
      kind          TEXT NOT NULL,
  path          TEXT,
    raw           TEXT,
        status        TEXT NOT NULL DEFAULT 'ok',
  fetched_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (device_serial, kind)
);
CREATE INDEX IF NOT EXISTS idx_att_device_config ON att_device_config (device_serial);
ALTER TABLE att_shifts ADD COLUMN source TEXT;
ALTER TABLE att_shifts ADD COLUMN source_ref TEXT;
