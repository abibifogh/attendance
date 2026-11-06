-- Duties on a shift.
--
-- A job somebody does on top of the shift they already have: making staff
-- lunch in F&B, the common areas or the laundry in housekeeping when the
-- person whose shift that is is off. It is a tag on their shift, not a second
-- shift: no second card on the rota, no second clock-in, the hours are the
-- shift's.

CREATE TABLE IF NOT EXISTS rota_duty (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  -- Whose people it is given to. Null: anybody on the rota.
  department  TEXT,
  -- Shifts that are this duty already. Somebody on one has it by their own
  -- shift and nobody needs to be given it that day. JSON list of shift ids.
  shift_ids   TEXT    NOT NULL DEFAULT '[]',
  -- 'lunch' ties it to the Lunch list: whoever has it is told how many eat.
  kind        TEXT,
  ready_by    TEXT,                          -- 'HH:MM', or null
  -- Only people whose shift has started by ready_by can be given it.
  before_only INTEGER NOT NULL DEFAULT 0,
  steps       TEXT,                          -- one line per thing to do
  needs_daily INTEGER NOT NULL DEFAULT 1,    -- warn on a day nobody has it
  tell_before INTEGER NOT NULL DEFAULT 1,    -- tell them the evening before
  fair        INTEGER NOT NULL DEFAULT 1,    -- fill by fewest this month
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Who has it on a day, added to their shift.
CREATE TABLE IF NOT EXISTS rota_duty_day (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  duty_id   INTEGER NOT NULL REFERENCES rota_duty (id) ON DELETE CASCADE,
  day       TEXT    NOT NULL,
  staff_id  INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  done      TEXT    NOT NULL DEFAULT '[]',   -- the steps ticked off, by number
  told_at   TEXT,                            -- when the evening-before notice went
  set_by    TEXT,
  set_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (duty_id, day, staff_id)
);
CREATE INDEX IF NOT EXISTS rota_duty_day_day ON rota_duty_day (day);
CREATE INDEX IF NOT EXISTS rota_duty_day_staff ON rota_duty_day (staff_id, day);

-- The three this property asked for, ready to use. Departments and shifts are
-- matched by name, so a property that calls them something else still gets
-- the duties and links the shifts in Settings.
INSERT INTO rota_duty (name, department, shift_ids, kind, ready_by, before_only, steps, needs_daily, tell_before, fair, sort)
SELECT 'Staff lunch',
       COALESCE((SELECT department FROM att_shifts WHERE active = 1 AND (department = 'F&B' OR department LIKE '%food%') LIMIT 1), 'F&B'),
       '[]', 'lunch', '12:30', 1,
       'Cook for the number on the Lunch list
Serve in the staff room from 12:30
Clear and wash up by 14:00',
       1, 1, 1, 1
 WHERE NOT EXISTS (SELECT 1 FROM rota_duty WHERE name = 'Staff lunch');

INSERT INTO rota_duty (name, department, shift_ids, ready_by, before_only, steps, needs_daily, tell_before, fair, sort)
SELECT 'Common area',
       COALESCE((SELECT department FROM att_shifts WHERE active = 1 AND department LIKE '%housekeep%' LIMIT 1), 'Housekeeping'),
       COALESCE((SELECT json_group_array(id) FROM att_shifts WHERE active = 1 AND lower(name) LIKE '%common%'), '[]'),
       NULL, 0,
       'Lobby and reception
Corridors and stairs
Public washrooms',
       CASE WHEN EXISTS (SELECT 1 FROM att_shifts WHERE active = 1 AND lower(name) LIKE '%common%') THEN 1 ELSE 0 END,
       1, 0, 2
 WHERE NOT EXISTS (SELECT 1 FROM rota_duty WHERE name = 'Common area');

INSERT INTO rota_duty (name, department, shift_ids, ready_by, before_only, steps, needs_daily, tell_before, fair, sort)
SELECT 'Laundry',
       COALESCE((SELECT department FROM att_shifts WHERE active = 1 AND department LIKE '%housekeep%' LIMIT 1), 'Housekeeping'),
       COALESCE((SELECT json_group_array(id) FROM att_shifts WHERE active = 1 AND lower(name) LIKE '%laundry%'), '[]'),
       NULL, 0,
       'Wash, dry and fold
Stock the trolleys',
       CASE WHEN EXISTS (SELECT 1 FROM att_shifts WHERE active = 1 AND lower(name) LIKE '%laundry%') THEN 1 ELSE 0 END,
       1, 0, 3
 WHERE NOT EXISTS (SELECT 1 FROM rota_duty WHERE name = 'Laundry');
