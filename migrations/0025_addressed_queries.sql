-- Asking a particular person, and keeping the asking between the two of you.
--
-- A question raised on a period went to everybody who could answer it, and was
-- readable by everybody who could raise one. Both were wrong, in opposite
-- directions.
--
-- ADDRESSED TO SOMEBODY
-- "Somebody senior should look at this" is not a plan. A queue addressed to a
-- permission is a queue three people can see and none of them owns, and the
-- question that gets answered is whichever one somebody happened to open. So
-- whoever raises it now names who they are asking. The queue still shows
-- everything to everybody who can answer — a manager on leave must not take
-- their questions with them — but the bell rings for the person named, and the
-- row says whose it is.
--
-- AND SEEN ONLY BY THEM
-- The reason for a question is a sentence about a colleague, written to be read
-- by one person: "absent all week and I do not want to charge his leave without
-- somebody checking". It went into a list that every rota planner and every
-- supervisor could read. That is not a queue, it is a noticeboard about people
-- who never agreed to be on it.
--
-- So a question is now visible to whoever can answer one, and to the person who
-- raised it, and to nobody else. Enforced in the query rather than on the
-- screen, because the screen is a courtesy and the API is the gate.

-- Who was asked, and who asked. Both carry a name as well as an id, and the
-- name is the record: a login can be deleted and who asked whom should survive
-- it. The ids are plain integers with no foreign key for exactly that reason —
-- the same shape as every other trail here. A constraint would make the trail
-- depend on the login still existing, which is the opposite of what a trail is
-- for, and would refuse the row outright rather than lose a name.
ALTER TABLE att_query ADD COLUMN addressed_to INTEGER;
ALTER TABLE att_query ADD COLUMN addressed_name TEXT;
ALTER TABLE att_query ADD COLUMN raised_by_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_att_query_addressed ON att_query (addressed_to, status);

-- The bell can now name a person as well as a permission. A notice with both
-- reaches the person named; one with only an audience reaches whoever holds it,
-- which is every notice written before today.
ALTER TABLE app_notices ADD COLUMN user_id INTEGER;
