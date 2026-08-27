-- Availability somebody asks for, and somebody else agrees to.
--
-- "I cannot work the 14th" was taking effect the moment it was typed, which
-- makes it a statement rather than a request. On a rota that is the wrong way
-- round: the property has to be able to say no, and the person has to be told
-- either way rather than finding out by looking at next week's rota.
--
-- So a day marked by the person themselves now waits. A day marked by whoever
-- builds the rota is approved as it is written — they are the approval, and
-- asking them to approve their own note would be a click that means nothing.
--
-- Everything already in the table was set under the old rule and has been
-- acted on, so it is approved: rewriting history to say a dozen people are
-- suddenly waiting on an answer would be a queue nobody asked for.
ALTER TABLE att_availability ADD COLUMN decision TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE att_availability ADD COLUMN decided_by TEXT;
ALTER TABLE att_availability ADD COLUMN decided_at TEXT;
ALTER TABLE att_availability ADD COLUMN decision_note TEXT;

CREATE INDEX IF NOT EXISTS idx_att_availability_waiting
  ON att_availability (decision, day);
