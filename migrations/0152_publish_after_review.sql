-- A rota planner who is not an administrator publishes only what an
-- administrator has approved, unchanged since. On unless switched off.
INSERT OR IGNORE INTO settings (key, value) VALUES ('rota_publish_needs_review', '1');
