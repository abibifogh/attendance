-- The handbook brought up to date with the late charge, the deductions now
-- in the contract, bonus deductions (amounts read from the list in Settings),
-- accepting a contract by typing a full name, and Your say. Drafts only: each
-- changed chapter shows as changed and is published by the office when ready.
-- Each change applies only where the words it replaces are still there, so a
-- chapter somebody has rewritten is left alone.

UPDATE hb_chapter SET body = replace(body, 'IT IS NOT YOUR WHOLE CONTRACT
Your contract of employment is a separate document and it comes first. This
handbook sits underneath it and explains how we run the place day to day.', 'IT IS NOT YOUR WHOLE CONTRACT
Your contract of employment is a separate document and it comes first. This
handbook sits underneath it and explains how we run the place day to day. Where
your contract points to the handbook, as it does for the late charge and the
bonus deductions, the amounts are the ones written here.

YOUR CONTRACT
Your contract comes to you in HIVE. Read it on your phone and accept it by
typing your full name exactly as it appears on the contract: that typed name is
your signature. Then come in and sign two paper copies with the person signing
for the company, and keep one. If anything in it looks wrong, tell the office
before you accept it.

YOUR SAY, EVERY QUARTER
Four times a year HIVE asks you a few short questions about your work, your team
and the place. It takes a few minutes. Answer honestly: what staff say is read
by management, and what we decide to do about it is shared with you afterwards,
under Your say.'),
       updated_by = 'HIVE (handbook update, November 2026)', updated_at = datetime('now')
 WHERE code = 'welcome' AND instr(body, 'IT IS NOT YOUR WHOLE CONTRACT
Your contract of employment is a separate document and it comes first. This
handbook sits underneath it and explains how we run the place day to day.') > 0 AND instr(body, 'YOUR CONTRACT') = 0;

UPDATE hb_chapter SET body = replace(body, 'You are entitled to a break of at least half an hour in a shift of more than
five hours. Take it. Your supervisor will tell you when it fits the service.', 'You are entitled to a break of at least half an hour in a shift of more than
five hours. Take it. Your supervisor will tell you when it fits the service.
Coming back more than ten minutes late from a break is one of the house rules in
the code of conduct.'),
       updated_by = 'HIVE (handbook update, November 2026)', updated_at = datetime('now')
 WHERE code = 'hours' AND instr(body, 'You are entitled to a break of at least half an hour in a shift of more than
five hours. Take it. Your supervisor will tell you when it fits the service.') > 0 AND instr(body, 'late from a break') = 0;

UPDATE hb_chapter SET body = replace(body, 'shifts, and a manager reads it before deciding. A clock-in corrected to on
time, or a day excused, takes the charge away.', 'shifts, and a manager reads it before deciding. A clock-in corrected to on
time, or a day excused, takes the charge away. It never takes your pay for a
month below nothing; a charge that does not fit waits for the next payroll.'),
       updated_by = 'HIVE (handbook update, November 2026)', updated_at = datetime('now')
 WHERE code = 'hours' AND instr(body, 'shifts, and a manager reads it before deciding. A clock-in corrected to on
time, or a day excused, takes the charge away.') > 0 AND instr(body, 'waits for the next payroll') = 0;

UPDATE hb_chapter SET body = replace(body, 'WHAT COMES OFF
PAYE income tax, at the rates the Ghana Revenue Authority sets.
Your SSNIT contribution of 5.5 per cent, with the property paying 13 per cent on
top of your salary.
Anything you have agreed to in writing: a salary advance being repaid, a loan,
or the late charge (GHS 20 for clocking in fifteen minutes or more after your
shift starts, unless a manager waives it; see Hours, the rota and clocking in).
Nothing else is deducted without your written agreement, except where the law
requires it. Section 70 of the Labour Act, 2003 (Act 651) is the rule here.', 'WHAT COMES OFF
PAYE income tax, at the rates the Ghana Revenue Authority sets.
Your SSNIT contribution of 5.5 per cent, with the property paying 13 per cent on
top of your salary.
And the deductions you agreed to in writing in your contract:
- a salary advance or loan being repaid, on the schedule agreed when you took it;
- a till or cash shortage you are responsible for, or the cost of uniform,
  keys or equipment not returned when you leave;
- the late charge: GHS 20 for each shift you clock in fifteen minutes or more
  after it starts, unless a manager waives it (see Hours, the rota and clocking
  in);
- a bonus deduction for breaking a house rule, at the amounts listed in the code
  of conduct.
Nothing else is deducted without your written agreement, except where the law
requires it. Section 70 of the Labour Act, 2003 (Act 651) is the rule here.

HOW A DEDUCTION REACHES YOU
Before a shortage, a late charge or a bonus deduction is taken, you are told
what it is for, and you can reply in HIVE. A manager reads your reply before it
is decided, and it can be dropped or waived. Each one is named on your payslip.
No deduction takes your pay for a month below nothing: what does not fit waits
for the next payroll. Any increase to these amounts is written here at least a
month before it applies.

YOUR BONUS
Where you have a bonus, it depends on how you and the business did that month,
and it is shown separately on your payslip. Bonus deductions come off the bonus
first; only where there is no bonus to take them from do they come off salary.'),
       updated_by = 'HIVE (handbook update, November 2026)', updated_at = datetime('now')
 WHERE code = 'pay' AND instr(body, 'WHAT COMES OFF
PAYE income tax, at the rates the Ghana Revenue Authority sets.
Your SSNIT contribution of 5.5 per cent, with the property paying 13 per cent on
top of your salary.
Anything you have agreed to in writing: a salary advance being repaid, a loan,
or the late charge (GHS 20 for clocking in fifteen minutes or more after your
shift starts, unless a manager waives it; see Hours, the rota and clocking in).
Nothing else is deducted without your written agreement, except where the law
requires it. Section 70 of the Labour Act, 2003 (Act 651) is the rule here.') > 0;

-- The short note added after the signature block comes out, and the full list
-- goes in among the rules, before what happens if they are broken.
UPDATE hb_chapter SET body = replace(body, '

BONUS DEDUCTIONS
Breaking a house rule costs a fixed amount, taken from that month''s bonus,
or from salary where there is no bonus to take it from. The list and the
amounts are in HIVE: a phone during working hours, not wearing the uniform set
out, leaving before the shift ends, using work things for your own benefit,
and eating food not meant for staff, among others. You are told at once, with
the reason, and can reply in My pay.', '')
 WHERE code = 'conduct' AND instr(body, '

BONUS DEDUCTIONS
Breaking a house rule costs a fixed amount, taken from that month''s bonus,
or from salary where there is no bonus to take it from. The list and the
amounts are in HIVE: a phone during working hours, not wearing the uniform set
out, leaving before the shift ends, using work things for your own benefit,
and eating food not meant for staff, among others. You are told at once, with
the reason, and can reply in My pay.') > 0;

UPDATE hb_chapter SET body = replace(body, 'WHAT WE DO IF THIS IS BROKEN',
         'BONUS DEDUCTIONS
Breaking one of these house rules costs a fixed amount, taken from that month''s
bonus, or from salary where there is no bonus to take it from:
' || COALESCE((SELECT group_concat(line, char(10)) FROM (
         SELECT '- ' || name
                || CASE WHEN COALESCE(note, '') <> '' THEN ' (' || lower(substr(note, 1, 1)) || substr(note, 2) || ')' ELSE '' END
                || ': GHS ' || printf('%g', amount)
                || CASE WHEN double_repeat = 1 THEN ', doubled for a second in the same month' ELSE '' END AS line
           FROM conduct_rule WHERE active = 1 ORDER BY sort_order, id)), '') || '
Only an administrator can levy one. You are told at once, with the reason, and
can reply under My pay, Deductions; it can be dropped if your reply shows it
should not stand. It is not a substitute for the disciplinary procedure: a
serious or repeated breach can still lead to it. Any increase to these amounts
is written here at least a month before it applies.

' || 'WHAT WE DO IF THIS IS BROKEN'),
       updated_by = 'HIVE (handbook update, November 2026)', updated_at = datetime('now')
 WHERE code = 'conduct' AND instr(body, 'WHAT WE DO IF THIS IS BROKEN') > 0 AND instr(body, 'BONUS DEDUCTIONS') = 0;
