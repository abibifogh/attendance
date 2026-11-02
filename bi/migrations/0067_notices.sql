-- Notifications in Insight: an inbox for each person, push to their phone or
-- computer, and the kitchen's store-room requests from the breakfast app
-- (src/routes/notices.js, src/lib/webpush.js, src/routes/storereq.js).

-- One notification for one person. Everything Insight emails a person is here
-- too, with where to go; read or not, urgent or not. `key` keeps one thing
-- told once (a reminder about it updates the row, it does not add another).
CREATE TABLE IF NOT EXISTS notice (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  key        TEXT,
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  urgent     INTEGER NOT NULL DEFAULT 0,
  at         TEXT NOT NULL,             -- first told
  last_at    TEXT NOT NULL,             -- last told (a reminder moves it)
  times      INTEGER NOT NULL DEFAULT 1,
  read_at    TEXT,
  done_at    TEXT                       -- the thing it was about is finished
);
CREATE INDEX IF NOT EXISTS idx_notice_account ON notice (account_id, read_at, last_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notice_key ON notice (account_id, key) WHERE key IS NOT NULL;

-- Each browser or phone that said yes to notifications, for one person.
CREATE TABLE IF NOT EXISTS push_sub (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  device     TEXT,
  at         TEXT NOT NULL,
  last_ok    TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_sub_account ON push_sub (account_id);

-- Insight's own key for push (VAPID), made the first time it is needed. Its
-- own table, not settings, so nothing that lists settings can show it.
CREATE TABLE IF NOT EXISTS push_key (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  public_key  TEXT NOT NULL,
  private_jwk TEXT NOT NULL,
  at          TEXT NOT NULL
);

-- The kitchen's requests to the store room, as Insight last saw them in the
-- breakfast app: who was told, when, and when they stopped being reminded.
CREATE TABLE IF NOT EXISTS store_request (
  id           INTEGER PRIMARY KEY,     -- the breakfast app's store_requests.id
  ref          TEXT NOT NULL,           -- R-0143
  department   TEXT,
  status       TEXT NOT NULL,
  asked_by     TEXT,
  asked_at     TEXT,
  needed       TEXT,
  lines        TEXT,                    -- JSON: name, unit, asked
  told_id      INTEGER,                 -- who was told
  emailed_at   TEXT,
  last_push_at TEXT,
  pushes       INTEGER NOT NULL DEFAULT 0,
  closed_at    TEXT,
  seen_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_store_request_status ON store_request (status);
