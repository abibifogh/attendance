-- Who a feedback round was sent to, when an admin picks them rather than
-- everybody eligible. Only these are asked, reminded and shown the survey.
-- A round with no rows here was sent to everybody eligible on its day.
CREATE TABLE IF NOT EXISTS fb_asked (
  round_id  INTEGER NOT NULL REFERENCES fb_round (id) ON DELETE CASCADE,
  staff_id  INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  PRIMARY KEY (round_id, staff_id)
);

-- And who You said, we did went to: a JSON list of staff ids, or null for
-- everybody.
ALTER TABLE fb_round ADD COLUMN said_to TEXT;
