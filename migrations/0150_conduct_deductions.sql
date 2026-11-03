-- Bonus deductions for breaking a house rule, at fixed amounts an admin sets.
-- They come off the month's bonus; somebody with no bonus to take them from
-- has them taken from salary instead. Only an admin levies one.

CREATE TABLE IF NOT EXISTS conduct_rule (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  note          TEXT,
  amount        REAL    NOT NULL,
  double_repeat INTEGER NOT NULL DEFAULT 0,   -- a second in the same month is twice the amount
  active        INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conduct_levy (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id    INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  rule_id     INTEGER REFERENCES conduct_rule (id) ON DELETE SET NULL,
  rule_name   TEXT    NOT NULL,            -- as it was called when levied
  amount      REAL    NOT NULL,            -- as it was when levied, doubled or not
  doubled     INTEGER NOT NULL DEFAULT 0,
  currency    TEXT    NOT NULL DEFAULT 'GHS',
  note        TEXT,
  day         TEXT    NOT NULL,
  month       TEXT    NOT NULL,            -- the payroll it comes off
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dropped')),
  levied_by   TEXT    NOT NULL,
  levied_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  dropped_by  TEXT,
  dropped_at  TEXT,
  drop_reason TEXT,
  reply       TEXT,                        -- what the person said about it
  reply_at    TEXT
);
CREATE INDEX IF NOT EXISTS conduct_levy_month ON conduct_levy (month, status);
CREATE INDEX IF NOT EXISTS conduct_levy_staff ON conduct_levy (staff_id, day);

INSERT OR IGNORE INTO settings (key, value) VALUES ('conduct_notify', '1');

INSERT OR IGNORE INTO conduct_rule (id, name, note, amount, double_repeat, sort_order) VALUES (1, 'Phone during working hours', 'Outside a break', 10, 1, 10);
INSERT OR IGNORE INTO conduct_rule (id, name, note, amount, double_repeat, sort_order) VALUES (2, 'Not in the uniform set out', 'Wrong clothes, no name badge', 10, 0, 20);
INSERT OR IGNORE INTO conduct_rule (id, name, note, amount, double_repeat, sort_order) VALUES (3, 'Left before the shift ended', 'Without a manager saying so', 20, 1, 30);
INSERT OR IGNORE INTO conduct_rule (id, name, note, amount, double_repeat, sort_order) VALUES (4, 'Work things used for personal benefit', 'Rooms, transport, stock, Wi-Fi codes', 50, 0, 40);
INSERT OR IGNORE INTO conduct_rule (id, name, note, amount, double_repeat, sort_order) VALUES (5, 'Ate a meal not meant for staff', 'Guest or menu food', 30, 0, 50);
INSERT OR IGNORE INTO conduct_rule (id, name, note, amount, double_repeat, sort_order) VALUES (6, 'Late back from break', 'More than 10 minutes over', 10, 0, 60);

-- The handbook draft: the list among the code of conduct, to publish.
UPDATE hb_chapter
   SET body = body || char(10) || char(10) ||
       'BONUS DEDUCTIONS' || char(10) ||
       'Breaking a house rule costs a fixed amount, taken from that month''s bonus,' || char(10) ||
       'or from salary where there is no bonus to take it from. The list and the' || char(10) ||
       'amounts are in HIVE: a phone during working hours, not wearing the uniform set' || char(10) ||
       'out, leaving before the shift ends, using work things for your own benefit,' || char(10) ||
       'and eating food not meant for staff, among others. You are told at once, with' || char(10) ||
       'the reason, and can reply in My pay.',
       updated_by = 'HIVE (bonus deductions)',
       updated_at = datetime('now')
 WHERE code = 'conduct'
   AND instr(body, 'BONUS DEDUCTIONS') = 0;
