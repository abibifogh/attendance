-- The property's people, taken from the Hik-Connect person list.
--
-- The employee number is the whole point of this file. It is what joins a face
-- on the wall terminal to a name in a report, and a single wrong character
-- produces somebody who is absent every day for ever while their punches pile
-- up unclaimed under a number nobody recognises. So the IDs are copied exactly
-- as Hik-Connect prints them, including the inconsistencies:
--
--   BKF001 and BFK003 — the prefix is transposed on one of them, and both are
--   reproduced as-is, because the terminal sends what it was given, not what
--   was meant.
--
--   Adm001 — lower case where every other prefix is upper case. Also as-is.
--
-- Departments are Hik-Connect's own, not a finer set invented here. Reports
-- group by department, so the shifts and the people have to speak the same
-- five words or the grouping fragments.
--
-- Two people are filed under no sub-department in Hik-Connect and have been
-- placed by their ID prefix instead: BKF002 (Dorcas Sarpei) with the other
-- BKF/BFK people in F&B, and ART004 (Emmanuel Ofori Bennie) with the other ART
-- people in Maintenance. Both are inferences and both are worth confirming.
--
-- The Hik-Connect admin account, 1714252473, is deliberately not here. It is a
-- login rather than a person, it does not work a shift, and adding it would put
-- a permanent phantom absence in every report. If it ever taps the terminal its
-- punches will be held as unrecognised, which is the right outcome.
--
-- Start dates are left empty because Hik-Connect does not carry them. That
-- matters more than it looks: annual leave accrues from the start date, and
-- until one is set nobody earns a pro-rata entitlement. They want filling in.

INSERT OR IGNORE INTO att_staff (employee_no, name, department) VALUES
  ('SPV001',  'Douglas Eshun Sekyi',   'Reception'),
  ('REP001',  'Destiny Hagar Amankwa', 'Reception'),
  ('REP002',  'Jessica Osae Korantemaa', 'Reception'),
  ('Adm001',  'Godfred Donkor',        'Reception'),

  ('SEC001',  'Abdul Hamid Iddrisu',   'Security'),
  ('SEC002',  'Robert Dotse',          'Security'),

  ('HSK001',  'Vivian Ahiadorme',      'Housekeeping'),
  ('HSK002',  'Divine Atsu Adanuvi',   'Housekeeping'),
  ('HSK003',  'Linda Attipoe',         'Housekeeping'),
  ('HSK004',  'Patience Torto',        'Housekeeping'),
  ('HSK005',  'Angela Ayima Asare',    'Housekeeping'),

  ('KIT001',  'Stephanie Owusu',       'F&B'),
  ('KIT002',  'Betty Freeman',         'F&B'),
  ('KIT003',  'Francisca Etornam Gave', 'F&B'),
  ('BKF001',  'Henry Aryee',           'F&B'),
  ('BKF002',  'Dorcas Sarpei',         'F&B'),
  ('BFK003',  'Bernard Asorkor',       'F&B'),
  ('FNB001',  'Regina Sampson',        'F&B'),
  ('BAR001',  'Chichi',                'F&B'),
  ('CRFT001', 'Doreen Aitee',          'F&B'),

  ('ART001',  'Nelson Kumadey',        'Maintenance'),
  ('ART002',  'Joshua Danso',          'Maintenance'),
  ('ART003',  'Johnson Yakanu',        'Maintenance'),
  ('ART004',  'Emmanuel Ofori Bennie', 'Maintenance');

-- Attach the punches that arrived before these people existed.
--
-- The terminal has been uploading its history since the listening host was
-- switched on, and every one of those punches has been held with no owner. The
-- app does this itself when somebody is added through the screen; a migration
-- inserts rows behind that, so it has to do the same or the backlog would sit
-- there unclaimed and every one of these people would start with no history.
UPDATE att_punches
   SET staff_id = (SELECT s.id FROM att_staff s WHERE s.employee_no = att_punches.employee_no)
 WHERE staff_id IS NULL
   AND EXISTS (SELECT 1 FROM att_staff s WHERE s.employee_no = att_punches.employee_no);
