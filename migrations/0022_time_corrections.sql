-- Putting a clock time right, and being able to prove who did.
--
-- Until now a clock time could only be changed as part of settling a day, and
-- settling a day needs the permission that also approves leave. So whoever
-- builds the rota — the person who actually notices that Kofi's Tuesday
-- clock-out reads 17:02 when the kitchen closed at 21:00 — had to ask somebody
-- else to type it in. That is how corrections stop happening.
--
-- Three rules hold this together.
--
-- THE PUNCH IS STILL A FACT. Nothing here touches `att_punches`. What the
-- terminal saw is what the terminal saw, for ever. A correction is an opinion
-- recorded beside it, and every report shows both.
--
-- THE RULES STILL DECIDE THE DAY. Correcting a time is not the same as ruling
-- on a day. Extending a clock-out to 21:00 says "this is when they left"; it
-- does not say "and therefore this day is present". The verdict is recomputed
-- from the corrected times exactly as it would have been from the punches, so
-- the lateness, the hours and the overtime all follow on their own.
--
-- AND IT IS ON THE RECORD. Every change lands in the table below with what
-- stood before it, what stands after, who did it, why, and from where. The
-- administrators are told each time it happens.

CREATE TABLE IF NOT EXISTS att_time_edit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id    INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  day         TEXT    NOT NULL,

  -- What the terminal itself recorded, copied in at the moment of the edit.
  -- Stored rather than looked up later so the trail still reads correctly
  -- after a re-import changes what the punches say.
  observed_in  TEXT,
  observed_out TEXT,

  -- The correction that stood before this one. Null on the first edit, which
  -- is the common case and is exactly what "it had not been touched" means.
  was_in      TEXT,
  was_out     TEXT,

  -- The correction that stands after it. Both null is a correction removed —
  -- the day handed back to the punches.
  now_in      TEXT,
  now_out     TEXT,

  -- Never optional. A time change without a reason is a time change nobody can
  -- defend three months later in front of somebody's payslip.
  reason      TEXT    NOT NULL,

  actor       TEXT    NOT NULL,
  actor_id    INTEGER,
  ip          TEXT,
  at_utc      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_att_time_edit_when  ON att_time_edit (at_utc DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_att_time_edit_staff ON att_time_edit (staff_id, day);
