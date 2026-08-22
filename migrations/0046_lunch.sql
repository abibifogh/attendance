-- The weekly lunch list.
--
-- The property feeds whoever is on duty, and the kitchen has to order for it
-- before the week starts. Until now that was a piece of paper on a noticeboard
-- and somebody counting names on a Sunday night, which produces two failures
-- every week: food cooked for people who were not in, and people in with no
-- food.
--
-- WHY IT IS ONE LINK AND NOT AN ACCOUNT. Almost nobody who eats here has a
-- login, and the ones who do are not going to open an app to tick a box. So
-- it is a single address, put on the noticeboard and in the group chat, that
-- opens a page where you find your name. What it can reach is deliberately
-- almost nothing: the first names of active staff, the days each is rostered
-- next week, and this week's meals. No pay, no records, no contact details.
--
-- WHY THE DAYS COME FROM THE ROTA. Asking somebody which days they want lunch
-- invites them to answer for days they are not working, and the kitchen then
-- cooks for them. The days offered are the days the published rota says they
-- are in, so the question is only ever "are you eating on a day you are
-- already here".

-- One meal a day, for everybody. Keyed by the date rather than by a week
-- number so a menu can be set for a single day without inventing a week.
CREATE TABLE IF NOT EXISTS lunch_menu (
  day     TEXT PRIMARY KEY,
  meal    TEXT NOT NULL,
  note    TEXT,
  set_by  TEXT,
  set_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What one person said about one day. A row means they answered; `taking`
-- says which way. The absence of a row is "has not said", which is a
-- different thing from "no" and is what the chase list is built from.
CREATE TABLE IF NOT EXISTS lunch_order (
  staff_id INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  day      TEXT    NOT NULL,
  taking   INTEGER NOT NULL DEFAULT 1,
  at       TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (staff_id, day)
);
CREATE INDEX IF NOT EXISTS idx_lunch_order_day ON lunch_order (day);

-- The address the list lives at. Blank until somebody makes one, so a
-- property that does not feed its staff never has a link to leak.
INSERT OR IGNORE INTO settings (key, value) VALUES ('lunch_token_hash', '');
-- Whether the list is being run at all. Off until a link is made.
INSERT OR IGNORE INTO settings (key, value) VALUES ('lunch_on', '0');
-- The days of the week ordering is open on, as digits with Monday as 1. The
-- kitchen orders Thursday to Sunday for the week after, which is what these
-- four are; a property that orders on a different day changes them here.
INSERT OR IGNORE INTO settings (key, value) VALUES ('lunch_open_days', '4,5,6,7');
