-- Asking the kitchen to change a lunch that has already gone in.
--
-- WHAT WAS MISSING. Everything about the lunch list happened on one address
-- outside the app: find your name, tick four boxes, and that was the last you
-- saw of it. A member of staff signed into HIVE had no way of finding out what
-- they had said. They could open the link again while the window was open, and
-- once it shut there was no screen anywhere that would tell them, so the
-- answer to "am I down for Thursday?" was to ask somebody in the kitchen.
--
-- AND A SHUT WINDOW IS NOT A CLOSED QUESTION. Plans change after Sunday
-- evening. Somebody swaps onto a shift, somebody is travelling on the
-- Wednesday, somebody who said no now needs a plate. The list being shut is
-- the right answer to "can you edit the count yourself" and the wrong answer
-- to "can this be changed at all": the kitchen changes it every week, by being
-- told in a corridor, and nothing written down.
--
-- So it is asked for, in the app, against a day, and it waits. While the
-- window is open a member of staff still changes their own answer outright,
-- because nothing has been ordered yet and making them queue for a change to
-- a number nobody has read would be ceremony. Once it is shut, the order has
-- gone to the kitchen and the kitchen decides.
CREATE TABLE IF NOT EXISTS lunch_change (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id      INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  day           TEXT    NOT NULL,
  -- What they are asking for, not what they said before. A request is only
  -- ever "put me down" or "take me off", and storing the target rather than a
  -- direction means a request answered late does the right thing whatever has
  -- happened to the order in between.
  want          INTEGER NOT NULL,
  note          TEXT,
  asked_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  -- waiting | approved | declined | withdrawn
  decision      TEXT    NOT NULL DEFAULT 'waiting',
  decided_by    TEXT,
  decided_at    TEXT,
  decision_note TEXT
);

-- One open request per person per day. Asking twice for the same Thursday is
-- changing your mind about the Thursday, not two things for the kitchen to
-- answer, and a queue with both in it is a queue that can be answered two
-- different ways.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lunch_change_open
  ON lunch_change (staff_id, day) WHERE decision = 'waiting';

CREATE INDEX IF NOT EXISTS idx_lunch_change_waiting
  ON lunch_change (decision, day);
