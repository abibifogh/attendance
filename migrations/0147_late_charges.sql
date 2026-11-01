-- Late charges: a fixed sum off salary for clocking in a set number of
-- minutes or more after the shift starts, unless an administrator waives it.
--
-- One row per person per day. `status`:
--   open    found, not looked at yet; comes off pay unless waived
--   kept    an administrator kept it
--   waived  an administrator waived it, with a reason
--   void    the lateness no longer stands (the clock-in was corrected, or the
--           day was excused); it comes back as open if the lateness returns
-- `month` is the payroll it comes off: the first one still open from the day.
CREATE TABLE IF NOT EXISTS late_charge (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id      INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  day           TEXT    NOT NULL,
  shift_id      INTEGER,
  shift_name    TEXT,
  starts_at     TEXT,
  ends_at       TEXT,
  clock_in      TEXT,
  minutes_late  INTEGER NOT NULL DEFAULT 0,
  amount        REAL    NOT NULL,
  currency      TEXT    NOT NULL DEFAULT 'GHS',
  month         TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'kept', 'waived', 'void')),
  -- What they said about it, from My day.
  reason_kind   TEXT,
  reason        TEXT,
  reason_at     TEXT,
  -- The administrator's answer.
  decided_by    TEXT,
  decided_at    TEXT,
  decision_note TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (staff_id, day)
);

CREATE INDEX IF NOT EXISTS late_charge_month ON late_charge (month, status);
CREATE INDEX IF NOT EXISTS late_charge_status ON late_charge (status, day);

-- Somebody the charge does not apply to, set on their record.
ALTER TABLE att_staff ADD COLUMN late_charge_exempt INTEGER NOT NULL DEFAULT 0;

-- When they accepted the rule in the app. Charges apply either way; this is
-- the written agreement on file.
ALTER TABLE att_staff ADD COLUMN late_rule_accepted_at TEXT;

-- The rule. On, GHS 20 at 15 minutes, from the shifts of 2 November 2026.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('late_charge_on', '1'),
  ('late_charge_amount', '20'),
  ('late_charge_minutes', '15'),
  ('late_charge_from', '2026-11-02'),
  ('late_charge_notify', '1');

-- The handbook: the late charge under clocking in, and among what comes off
-- pay. In the draft only, the same as any wording change. Publishing it is
-- what records a new version and asks everybody to acknowledge it again.
UPDATE hb_chapter
   SET body = replace(body,
         'holding your section until you get there.',
         'holding your section until you get there.' || char(10) || char(10) ||
         'THE LATE CHARGE' || char(10) ||
         'Clocking in fifteen minutes or more after your shift starts costs GHS 20, taken' || char(10) ||
         'from your pay in the next payroll unless a manager waives it. It is charged' || char(10) ||
         'once per shift, however late. Your phone tells you five minutes into the shift' || char(10) ||
         'if nothing has been recorded, and again at fifteen. You can say why in My' || char(10) ||
         'shifts, and a manager reads it before deciding. A clock-in corrected to on' || char(10) ||
         'time, or a day excused, takes the charge away.'),
       updated_by = 'HIVE (the late charge)',
       updated_at = datetime('now')
 WHERE code = 'hours'
   AND instr(body, 'holding your section until you get there.') > 0
   AND instr(body, 'THE LATE CHARGE') = 0;

UPDATE hb_chapter
   SET body = replace(body,
         'Anything you have agreed to in writing: a salary advance being repaid, a loan.',
         'Anything you have agreed to in writing: a salary advance being repaid, a loan,' || char(10) ||
         'or the late charge (GHS 20 for clocking in fifteen minutes or more after your' || char(10) ||
         'shift starts, unless a manager waives it; see Hours, the rota and clocking in).'),
       updated_by = 'HIVE (the late charge)',
       updated_at = datetime('now')
 WHERE code = 'pay'
   AND instr(body, 'Anything you have agreed to in writing: a salary advance being repaid, a loan.') > 0;

-- The contracts on file as templates: the late charge among the deductions
-- the employee consents to. Contracts already signed are not touched.
UPDATE hr_template
   SET body = replace(body,
         '    sum to which the Employee has consented in writing.',
         '    sum to which the Employee has consented in writing, and the late arrival' || char(10) ||
         '    charge set out in the Staff Handbook (at present GHS 20 for each shift on' || char(10) ||
         '    which the Employee clocks in fifteen (15) minutes or more after its scheduled' || char(10) ||
         '    start), which the Company may waive and to which the Employee consents.')
 WHERE instr(body, 'sum to which the Employee has consented in writing.') > 0
   AND instr(body, 'late arrival') = 0;

UPDATE hr_template
   SET body = replace(body,
         '    written consent of the Employee or a requirement of law.',
         '    written consent of the Employee or a requirement of law, save that the' || char(10) ||
         '    Employee consents to the late arrival charge set out in the Staff Handbook' || char(10) ||
         '    (at present GHS 20 for clocking in fifteen minutes or more after a shift' || char(10) ||
         '    starts), which the Company may waive.')
 WHERE instr(body, 'written consent of the Employee or a requirement of law.') > 0
   AND instr(body, 'late arrival') = 0;
