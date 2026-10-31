-- Till shortages recovered in the last week of a month were pushed to the
-- month after, like a salary advance, and so were missing from the open
-- draft payslip. They come off the month they were decided in while that
-- month is still open: no payroll closed for it, not closed off by hand, and
-- nothing taken off yet.
UPDATE hr_advance
   SET start_month = substr(taken_on, 1, 7)
 WHERE purpose = 'till'
   AND status = 'approved'
   AND taken_on IS NOT NULL
   AND start_month > substr(taken_on, 1, 7)
   AND NOT EXISTS (SELECT 1 FROM hr_advance_entry e WHERE e.advance_id = hr_advance.id)
   AND NOT EXISTS (SELECT 1 FROM hr_advance_month m WHERE m.month = substr(hr_advance.taken_on, 1, 7))
   AND NOT EXISTS (
     SELECT 1 FROM pay_run r
      WHERE substr(r.month, 1, 7) = substr(hr_advance.taken_on, 1, 7)
        AND r.status = 'final'
        AND COALESCE(r.company_id, 1) = COALESCE((SELECT s.company_id FROM att_staff s WHERE s.id = hr_advance.staff_id), 1));
