-- The monthly PAYE bands from September 2026.
--
-- The Income Tax (Amendment) Act, 2026 (Act 1178), as the GRA announced it:
-- effective 1 September 2026, the monthly bands for individuals are
--
--   first   588.00    nil
--   next     80.00     5%
--   next    100.00    10%
--   next  2,900.00    17.5%
--   next 16,000.00    25%
--   next 30,332.00    30%
--   exceeding 50,000  35%
--
-- August and every month before it keep the bands they were worked on. A tax
-- table has a month it starts in (0075), so this is a new row from 2026-09
-- rather than a change to the one in force: a month reopened later answers
-- from its own figures. Everything else in the table, SSNIT, the tiers and the
-- 5% bonus rate, carries on from the row before, because the Act did not move
-- it.

-- What the property was using, captured as the table for every month before
-- this one, where nothing has been dated yet. Without it every earlier month
-- would fall through to the new bands. The figures are the settings where the
-- property set them and the published 2026 ones where it did not, which is
-- exactly what the payroll was reading.
INSERT INTO pay_rates (from_month, label, bands, ssnit_employee, ssnit_employer,
                       tier1, tier2, bonus_rate, bonus_share, bonus_cap_basis, set_by)
SELECT
  '0000-01',
  COALESCE(NULLIF((SELECT value FROM settings WHERE key = 'pay_bands_label'), ''), 'GRA monthly bands, 2026'),
  COALESCE(NULLIF((SELECT value FROM settings WHERE key = 'pay_bands'), ''),
    '[{"width":490,"rate":0},{"width":110,"rate":0.05},{"width":130,"rate":0.1},{"width":3166.67,"rate":0.175},{"width":16000,"rate":0.25},{"width":30520,"rate":0.3},{"width":null,"rate":0.35}]'),
  COALESCE(CAST(NULLIF((SELECT value FROM settings WHERE key = 'pay_ssnit_employee'), '') AS REAL), 0.055),
  COALESCE(CAST(NULLIF((SELECT value FROM settings WHERE key = 'pay_ssnit_employer'), '') AS REAL), 0.13),
  COALESCE(CAST(NULLIF((SELECT value FROM settings WHERE key = 'pay_tier1'), '') AS REAL), 0.135),
  COALESCE(CAST(NULLIF((SELECT value FROM settings WHERE key = 'pay_tier2'), '') AS REAL), 0.05),
  COALESCE(CAST(NULLIF((SELECT value FROM settings WHERE key = 'pay_bonus_rate'), '') AS REAL), 0.05),
  COALESCE(CAST(NULLIF((SELECT value FROM settings WHERE key = 'pay_bonus_share'), '') AS REAL), 0.15),
  CASE WHEN (SELECT value FROM settings WHERE key = 'pay_bonus_cap_basis') = 'annual' THEN 'annual' ELSE 'monthly' END,
  'HIVE, before the September 2026 bands'
WHERE NOT EXISTS (SELECT 1 FROM pay_rates);

-- The new bands from September, on the rest of the figures in force in August.
INSERT INTO pay_rates (from_month, label, bands, ssnit_employee, ssnit_employer,
                       tier1, tier2, bonus_rate, bonus_share, bonus_cap_basis, set_by)
SELECT
  '2026-09',
  'GRA monthly bands, from September 2026 (Act 1178)',
  '[{"width":588,"rate":0},{"width":80,"rate":0.05},{"width":100,"rate":0.1},{"width":2900,"rate":0.175},{"width":16000,"rate":0.25},{"width":30332,"rate":0.3},{"width":null,"rate":0.35}]',
  p.ssnit_employee, p.ssnit_employer, p.tier1, p.tier2, p.bonus_rate, p.bonus_share, p.bonus_cap_basis,
  'HIVE, from the GRA notice on Act 1178'
FROM pay_rates p
WHERE p.from_month <= '2026-08'
ORDER BY p.from_month DESC
LIMIT 1
ON CONFLICT (from_month) DO UPDATE SET
  label = excluded.label, bands = excluded.bands, set_by = excluded.set_by, set_at = datetime('now');

-- The settings follow the newest table, the same as saving one on the screen
-- does, so every screen that shows "the figures" shows the ones in force.
INSERT INTO settings (key, value)
  SELECT 'pay_bands', bands FROM pay_rates WHERE 1 ORDER BY from_month DESC LIMIT 1
  ON CONFLICT (key) DO UPDATE SET value = excluded.value;
INSERT INTO settings (key, value)
  SELECT 'pay_bands_label', label FROM pay_rates WHERE 1 ORDER BY from_month DESC LIMIT 1
  ON CONFLICT (key) DO UPDATE SET value = excluded.value;
