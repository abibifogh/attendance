-- More than one person's record on a single login.
--
-- A login has always been one person: users.staff_id, unique, pointing at the
-- one record whose shifts, report, advances, claims and payslips the "my"
-- screens show. That is right for almost everybody and wrong for the few it is
-- wrong for, and the property has both kinds.
--
-- Two situations produce it. Somebody who exists twice on the books, because
-- the terminal was given a second employee number when a card was reissued and
-- both numbers now carry attendance. And somebody who has no phone of their
-- own, whose record is put on the phone of whoever they live with, so that
-- there is a way for them to see their own week at all.
--
-- The one record stays where it is. This is the rest of them: extra records a
-- login may open, on top of the one it belongs to. Keeping the first in
-- users.staff_id means every query in the app that asks "whose login is this"
-- still gets one answer, and nothing that already worked has to learn about
-- the second.
--
-- It grants nothing else. The screens it opens are the same five, they show
-- the same things, and each of them shows one person at a time with their name
-- on it.
CREATE TABLE IF NOT EXISTS user_staff (
  user_id  INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  staff_id INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, staff_id)
);

-- Read from the staff side when somebody leaves, so the link goes with them.
CREATE INDEX IF NOT EXISTS idx_user_staff_staff ON user_staff (staff_id);
