-- Who actually heard that the rota was out.
--
-- Publishing told everybody at once and then forgot what it had done. The
-- answer a planner got was three numbers: told 14, no login 3, silent 2. Which
-- three, and which two, it did not say, so "Doreen never got hers" could only
-- be answered by publishing the whole fortnight again and buzzing twenty-one
-- people who had already read it.
--
-- So each person's own outcome is written down beside the publish it belongs
-- to, and a publish can be sent again to a named few.
--
-- WHAT REACHED MEANS, HONESTLY. Nothing here is a read receipt: web push has
-- none, a gateway says it accepted a text and not that a phone rang. What is
-- recorded is what the property actually did and what came back from it, which
-- is the difference between "we never had a way to tell her" and "we told her
-- and she has not looked yet". Those are different problems and only one of
-- them is fixed by sending it again.
ALTER TABLE rota_publish ADD COLUMN notify  TEXT;
ALTER TABLE rota_publish ADD COLUMN message TEXT;

CREATE TABLE IF NOT EXISTS rota_publish_told (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  publish_id INTEGER NOT NULL REFERENCES rota_publish (id) ON DELETE CASCADE,
  staff_id   INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  -- The login the alert was addressed to, and the bell entry it wrote. Null
  -- where somebody has no login at all, which is its own kind of not reached.
  user_id    INTEGER,
  notice_id  INTEGER,
  -- What their week said, so the list reads as something a planner recognises
  -- rather than a column of names.
  shifts     INTEGER NOT NULL DEFAULT 0,
  off_days   INTEGER NOT NULL DEFAULT 0,
  -- What each way out came back with: 1 accepted, 0 not tried, -1 tried and
  -- refused. Three states, because "we did not try" and "it bounced" are not
  -- the same fact and the second one is worth showing.
  buzzed     INTEGER NOT NULL DEFAULT 0,
  emailed    INTEGER NOT NULL DEFAULT 0,
  texted     INTEGER NOT NULL DEFAULT 0,
  -- How many times this person has been sent it. One at publish, and one more
  -- each time somebody presses Send again for them.
  sends      INTEGER NOT NULL DEFAULT 1,
  at         TEXT    NOT NULL DEFAULT (datetime('now')),
  last_at    TEXT,
  UNIQUE (publish_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_publish_told ON rota_publish_told (publish_id);
