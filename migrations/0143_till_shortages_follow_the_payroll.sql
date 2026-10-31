-- 0142 left a till shortage on the next month when its own month had been
-- confirmed on the Advances page. That confirmation is not the payroll: while
-- the month's payroll is a draft, a shortage decided in it comes off it.
UPDATE hr_advance
   SET start_month = substr(taken_on, 1, 7)
 WHERE purpose = 'till'
   AND status = 'approved'
   AND taken_on IS NOT NULL
   AND start_month > substr(taken_on, 1, 7)
   AND NOT EXISTS (SELECT 1 FROM hr_advance_entry e WHERE e.advance_id = hr_advance.id)
   AND NOT EXISTS (
     SELECT 1 FROM pay_run r
      WHERE substr(r.month, 1, 7) = substr(hr_advance.taken_on, 1, 7)
        AND r.status = 'final'
        AND COALESCE(r.company_id, 1) = COALESCE((SELECT s.company_id FROM att_staff s WHERE s.id = hr_advance.staff_id), 1));
