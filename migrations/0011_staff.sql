-- The property's people, taken from the Hik-Connect person list.
--
-- The names here are made up. The live database was loaded with the real ones
-- when this first ran; the employee numbers and departments are as they were.
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
-- placed by their ID prefix instead: BKF002 (Dinah Sowah) with the other
-- BKF/BFK people in F&B, and ART004 (Ebenezer Opoku Bonsu) with the other ART
-- people in Maintenance. Both are inferences and both are worth confirming.
--
-- The Hik-Connect admin account is deliberately not here. It is a
-- login rather than a person, it does not work a shift, and adding it would put
-- a permanent phantom absence in every report. If it ever taps the terminal its
-- punches will be held as unrecognised, which is the right outcome.
--
-- Start dates are left empty because Hik-Connect does not carry them. That
-- matters more than it looks: annual leave accrues from the start date, and
-- until one is set nobody earns a pro-rata entitlement. They want filling in.

INSERT OR IGNORE INTO att_staff (employee_no, name, department) VALUES
  ('SPV001',  'Duncan Essien Sackey',   'Reception'),
  ('REP001',  'Deborah Hilda Ampofo', 'Reception'),
  ('REP002',  'Janet Ofosu Kyerewaa', 'Reception'),
  ('Adm001',  'Gideon Dadzie',        'Reception'),

  ('SEC001',  'Alhassan Hamza Isahaku',   'Security'),
  ('SEC002',  'Rudolf Dogbe',          'Security'),

  ('HSK001',  'Veronica Agbenyega',      'Housekeeping'),
  ('HSK002',  'Delali Awuku Ametewee',   'Housekeeping'),
  ('HSK003',  'Lydia Amegashie',         'Housekeeping'),
  ('HSK004',  'Priscilla Tetteh',        'Housekeeping'),
  ('HSK005',  'Augustina Abla Adjei',    'Housekeeping'),

  ('KIT001',  'Sylvia Owusu',       'F&B'),
  ('KIT002',  'Bertha Forson',         'F&B'),
  ('KIT003',  'Felicia Enyonam Gbeho', 'F&B'),
  ('BKF001',  'Harold Armah',           'F&B'),
  ('BKF002',  'Dinah Sowah',         'F&B'),
  ('BFK003',  'Benjamin Asamoah',       'F&B'),
  ('FNB001',  'Rosemary Sackitey',        'F&B'),
  ('BAR001',  'Cecilia',                'F&B'),
  ('CRFT001', 'Dolly Ayitey',          'F&B'),

  ('ART001',  'Nathaniel Kudjoe',        'Maintenance'),
  ('ART002',  'Josiah Darkwa',          'Maintenance'),
  ('ART003',  'Joseph Yeboah',        'Maintenance'),
  ('ART004',  'Ebenezer Opoku Bonsu', 'Maintenance');

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
