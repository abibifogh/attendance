ALTER TABLE att_devices ADD COLUMN mode TEXT NOT NULL DEFAULT 'push';
UPDATE att_devices SET mode = 'poll' WHERE last_seen_at IS NOT NULL;
