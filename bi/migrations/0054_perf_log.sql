-- How long Insight's requests take: slow ones, and a sample of the rest, for
-- Settings › Connections & files › Speed. Kept a week.
CREATE TABLE IF NOT EXISTS perf_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT    NOT NULL,
  path    TEXT    NOT NULL,   -- the route, e.g. /api/np/photo/:id
  ms      INTEGER NOT NULL,   -- the whole request
  db_ms   INTEGER NOT NULL,   -- of which, waiting on the database
  reads   INTEGER NOT NULL,   -- database reads and writes
  colo    TEXT                -- the Cloudflare location the Worker ran in
);
CREATE INDEX IF NOT EXISTS perf_log_at ON perf_log (at);
