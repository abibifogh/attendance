-- Every change anybody makes in Insight, kept for good.
--
-- One row when a change is asked for (who, what, from where, the request as
-- sent, secrets taken out) and one when it is done or refused, under the same
-- request id. Nothing here is ever changed or deleted: the triggers refuse it,
-- whoever asks, so an answer taken back, a link undone or a count typed over
-- still shows what was there and who did it.
CREATE TABLE IF NOT EXISTS audit_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  TEXT    NOT NULL,
  at          TEXT    NOT NULL,
  stage       TEXT    NOT NULL,   -- asked | done | refused
  method      TEXT    NOT NULL,
  path        TEXT    NOT NULL,   -- the route, e.g. /api/shifts/link
  account_id  INTEGER,
  actor       TEXT,               -- the account's name, or how a link signed in
  via         TEXT,               -- session | link | form | public | bootstrap
  subject     TEXT,               -- the key, day or id the change is about, where the request says
  detail      TEXT                -- the request as sent (asked), or the outcome (done / refused)
);
CREATE INDEX IF NOT EXISTS idx_audit_event_request ON audit_event (request_id);
CREATE INDEX IF NOT EXISTS idx_audit_event_subject ON audit_event (subject);
CREATE INDEX IF NOT EXISTS idx_audit_event_at ON audit_event (at);
CREATE TRIGGER IF NOT EXISTS audit_event_no_update BEFORE UPDATE ON audit_event
  BEGIN SELECT RAISE(ABORT, 'The audit trail cannot be changed.'); END;
CREATE TRIGGER IF NOT EXISTS audit_event_no_delete BEFORE DELETE ON audit_event
  BEGIN SELECT RAISE(ABORT, 'The audit trail cannot be deleted from.'); END;
