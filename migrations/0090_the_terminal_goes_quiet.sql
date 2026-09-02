-- The stretches when nothing was heard from a terminal.
--
-- A day with a shift on the rota and no punch against it reads as an absence,
-- which is right when the terminal was working and badly wrong when it was
-- not: one unplugged poller and the whole property is absent by lunchtime,
-- and nobody is told. So the watcher keeps a record of each stretch of
-- silence, and any shift that began inside one is held for a decision rather
-- than marked absent. The row outlives the outage on purpose: punches the
-- terminal lost while it was down never arrive, and those days still need a
-- person to say what happened.
--
-- Times are in the property's own clock, 'YYYY-MM-DD HH:MM', the same form
-- as everything the rota reasons in. `to_at` is empty while the terminal is
-- still quiet. `told_at` is when the administrators were last reminded, so a
-- terminal that stays down for a weekend is mentioned again every few hours
-- rather than once on Friday night.
CREATE TABLE IF NOT EXISTS att_device_quiet (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES att_devices (id) ON DELETE CASCADE,
  from_at   TEXT    NOT NULL,
  to_at     TEXT,
  told_at   TEXT,
  due       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS att_device_quiet_open ON att_device_quiet (device_id, to_at);

-- How long a terminal may say nothing before it counts as quiet. Sixty
-- minutes covers a poller that runs every five and a terminal that heartbeats
-- on its own. Zero switches the watch off.
INSERT OR IGNORE INTO settings (key, value) VALUES ('att_terminal_quiet_minutes', '60');
