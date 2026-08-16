-- What the terminal says about itself.
--
-- Chiefly its attendance bands: the time windows a device in automatic mode
-- uses to decide whether a tap is a check-in, a check-out or a break. Those
-- bands come down from wherever the shifts were configured — Hik-Connect, the
-- device's own menus, iVMS — so they are an echo of shifts somebody has already
-- set up, and re-typing those into this app is exactly the chore worth removing.
--
-- Kept raw rather than parsed into columns. Two reasons, and the second is the
-- real one. ISAPI's shapes differ between models and firmware, so a schema
-- fixed today is a schema wrong after the next update. And when the parse turns
-- out to be wrong — which it will, on some model nobody here has seen — the fix
-- has to be possible without going back to the device, which means the original
-- has to still be here.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS att_device_config (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_serial TEXT NOT NULL,
  -- Which ISAPI endpoint this came from, so a firmware that answers three of
  -- the five probed does not look like a failure.
  kind          TEXT NOT NULL,
  path          TEXT,
  -- The response body, verbatim.
  raw           TEXT,
  -- Set when the device answered but not with anything usable. Kept as a row
  -- rather than dropped, because "asked and got a 404" and "never asked" are
  -- different problems with different fixes.
  status        TEXT NOT NULL DEFAULT 'ok',
  fetched_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (device_serial, kind)
);

CREATE INDEX IF NOT EXISTS idx_att_device_config ON att_device_config (device_serial);

-- Where a shift came from, so a re-sync updates the one it created last time
-- instead of adding a second copy beside it. Null for a shift somebody typed in
-- themselves, which is left alone by every sync.
ALTER TABLE att_shifts ADD COLUMN source TEXT;
ALTER TABLE att_shifts ADD COLUMN source_ref TEXT;
