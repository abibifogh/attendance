-- The HR FAQ.
--
-- The handbook is the rulebook and is acknowledged chapter by chapter. This is
-- the quick layer on top of it: what to do when you are sick, how to ask for
-- leave, what not to do on duty. Short answers that say what to do and point
-- at the screen in HIVE that does it, or at the handbook chapter it comes from.
--
-- TWO BODIES, LIKE A HANDBOOK CHAPTER. `answer` is what HR is working on;
-- `live_answer` is what staff read. Editing changes nothing on the screen
-- until Publish, so a half-rewritten answer is never in front of anybody.
--
-- Seeded with the property's reviewed set, published, so it is on the day
-- it arrives. Recognised by `code` afterwards, so installing the standard
-- set again only ever adds what is missing and never writes over an edit.
CREATE TABLE IF NOT EXISTS hr_faq (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,
  topic         TEXT    NOT NULL,
  question      TEXT    NOT NULL,
  answer        TEXT    NOT NULL DEFAULT '',
  -- Where the answer sends somebody: a JSON list of {label, path}, where path
  -- is a screen the app has. Never a URL.
  links         TEXT    NOT NULL DEFAULT '[]',
  sort_order    INTEGER NOT NULL DEFAULT 100,
  status        TEXT    NOT NULL DEFAULT 'draft',   -- draft | published | retired
  live_question TEXT,
  live_answer   TEXT,
  live_links    TEXT,
  published_at  TEXT,
  published_by  TEXT,
  created_by    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_by    TEXT,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_hr_faq_live ON hr_faq (status, topic, sort_order);

-- A question somebody asked that the FAQ did not answer. HR answers it to the
-- person, and can turn the answer into a new entry so the next person finds
-- it without asking.
CREATE TABLE IF NOT EXISTS hr_faq_question (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id    INTEGER NOT NULL REFERENCES att_staff (id) ON DELETE CASCADE,
  question    TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'open',      -- open | answered
  answer      TEXT,
  faq_id      INTEGER REFERENCES hr_faq (id) ON DELETE SET NULL,
  asked_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  answered_by TEXT,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_hr_faq_question_open ON hr_faq_question (status, id DESC);
CREATE INDEX IF NOT EXISTS idx_hr_faq_question_staff ON hr_faq_question (staff_id);

-- The reviewed set, published. The same words as src/lib/hr-faq-content.js,
-- which is also what "Add the standard questions" installs from.
INSERT OR IGNORE INTO hr_faq
  (code, topic, question, answer, links, sort_order, status,
   live_question, live_answer, live_links, published_at, published_by, created_by)
SELECT code, topic, question, answer, links, sort_order, 'published',
       question, answer, links, datetime('now'), 'HIVE', 'HIVE'
FROM (
  SELECT column1 AS code, column2 AS topic, column3 AS question, column4 AS answer,
         column5 AS links, column6 AS sort_order
  FROM (VALUES
  ('sick_cant_come_in', 'sick', 'I''m sick and can''t come in. What do I do?', '1. Before your shift starts, tell your supervisor. A call or a message. Do not just not turn up.
2. In HIVE, open My leave and ask for sick leave for the days you will be off. The office sees it straight away.
3. If you are off more than one day, get a note from the clinic or hospital. Paid sick leave needs a medical certificate.

Tell your supervisor before the shift. A day with no word is recorded as absent.', '[{"label":"Ask for sick leave","path":"att-me"},{"label":"Handbook: Leave and absence","path":"handbook"}]', 10),
  ('sick_during_shift', 'sick', 'I feel unwell during my shift. Can I go home?', 'Tell your supervisor first. They decide whether you can go and who covers. Clock out when you leave, so the hours you did are recorded. The rest of the day is marked by your supervisor, not by you.', '[{"label":"Handbook: Hours, the rota and clocking in","path":"handbook"}]', 20),
  ('sick_certificate', 'sick', 'Do I need a medical certificate?', 'For one day, no, but tell your supervisor. For two or more days, yes: bring the certificate when you return, or photograph it and send it to HR. Without one, the days are unpaid.', '[{"label":"Handbook: Leave and absence","path":"handbook"}]', 30),
  ('sick_family', 'sick', 'Someone in my family is ill or has died. What leave can I take?', 'Ask for compassionate leave in My leave and tell your supervisor. HR will talk to you about how many days. It is decided case by case and does not come off your annual leave.', '[{"label":"Ask for compassionate leave","path":"att-me"}]', 40),
  ('sick_absent_means', 'sick', 'What counts as being absent?', 'A rostered day you did not work and did not have approved leave for. One tap in with no tap out can also become an absence if nobody confirms what time you left.

Absences show on My report. Repeated absence without a reason goes to the disciplinary procedure.', '[{"label":"See my days","path":"att-my-report"}]', 50),
  ('leave_how', 'leave', 'How do I ask for annual leave?', '1. Open My leave and press Ask for leave.
2. Pick the first and last day and the type. Add a note if it helps.
3. It goes to your manager. You get a notification when it is decided, either way.

Ask as early as you can, even months ahead. You do not need to wait for the rota to be built. While it is waiting you can take it back yourself.', '[{"label":"Ask for leave","path":"att-me"}]', 60),
  ('leave_balance', 'leave', 'How much leave do I have, and how is it counted?', 'Your balance is at the top of My leave. The property gives 15 working days a year after your first 12 months.

Only rostered working days are charged. Rest days and public holidays inside your leave cost nothing.', '[{"label":"My balance","path":"att-me"}]', 70),
  ('leave_rest_days', 'leave', 'Can I take leave over my days off?', 'Yes. If you will be away, ask for it anyway so nobody calls you in. If the days are all rest days it costs you nothing.', '[{"label":"Ask for leave","path":"att-me"}]', 80),
  ('leave_how_many_off', 'leave', 'How many people can be off at once?', 'There is a limit per department. If your dates would take the department over it, HIVE tells you when you ask, so you can pick other dates rather than wait for a no.', '[]', 90),
  ('leave_vs_unavailable', 'leave', 'I can''t work a particular day next month. Is that leave?', 'No. That is unavailability: you are telling the planner before the rota is built. Open the rota, choose the week, and mark the days you cannot work. It must be in before the rota for that week is published, and only one person per department can hold a day.

Leave is for days you would otherwise be rostered and want paid.', '[{"label":"Mark unavailability","path":"att-rota"}]', 100),
  ('leave_maternity', 'leave', 'What is maternity leave here?', 'Twelve weeks on full pay, with your annual leave on top. Talk to HR as early as you can so the rota can plan around it. It is recorded by HR rather than asked for in the app.', '[{"label":"Handbook: Leave and absence","path":"handbook"}]', 110),
  ('duty_never', 'duty', 'What should I never do on duty?', '- Use your phone for personal calls, chats or social media in front of guests.
- Drink alcohol, or come to work under its influence.
- Take photos of guests, their rooms or their documents, or post anything about guests online.
- Accept cash from a guest outside the till, or keep lost property.
- Share your HIVE PIN or clock in for a colleague.
- Leave your station without telling whoever is in charge.

The handbook''s code of conduct has the full list. Serious breaches go straight to the disciplinary procedure.', '[{"label":"Handbook: Code of conduct","path":"handbook"}]', 120),
  ('duty_phone', 'duty', 'Can I use my phone on duty?', 'No. Your phone stays away while you are on duty. Use it on your break. If you need to make an urgent call, ask your supervisor for permission first.', '[{"label":"Handbook: Code of conduct","path":"handbook"}]', 130),
  ('duty_tips', 'duty', 'A guest gave me a tip or a gift. Can I keep it?', 'A tip given to you, yes. Cash for a bill goes through the till. A gift worth more than a small token, tell your supervisor so it is recorded.', '[{"label":"Handbook: Keys, cash, stock and lost property","path":"handbook"}]', 140),
  ('duty_guest_asks', 'duty', 'A guest asked me something about another guest. What do I say?', 'Nothing about them. Not whether they are staying, which room, or when they arrived. Offer to pass a message to reception. Guest information stays inside the property.', '[{"label":"Handbook: Guest confidentiality","path":"handbook"}]', 150),
  ('duty_uniform', 'duty', 'What do I wear?', 'Your department''s uniform, clean and complete. If something is damaged or missing, tell your supervisor before the shift rather than turning up without it.', '[]', 160),
  ('clock_why', 'clock', 'Why must I clock in and out every time?', 'Clocking is what turns your shift into paid hours. A day with a tap in and no tap out is held until your supervisor confirms when you left, and if nobody can, it can become an absence.

Tap in when you arrive and tap out when you leave, every shift.', '[{"label":"See my days","path":"att-my-report"}]', 170),
  ('clock_forgot_out', 'clock', 'I forgot to clock out. What now?', 'Tell your supervisor the time you left as soon as you remember. They correct it in HIVE and the day is settled. You can see which days are still waiting on My report.', '[{"label":"My report","path":"att-my-report"}]', 180),
  ('clock_late', 'clock', 'I''m going to be late. What do I do?', 'Call your supervisor or manager straight away and say when you expect to arrive, so they can cover the gap. A call, not a message, and before your shift starts rather than after.

It does not excuse the lateness, but it means nobody is left guessing.', '[]', 190),
  ('clock_my_shifts', 'clock', 'Where do I see my shifts?', 'My shifts shows this week and next, with who else is on. The bell tells you when a rota is published or changed. You can add HIVE to your phone''s home screen so it opens like an app.', '[{"label":"My shifts","path":"att-me"}]', 200),
  ('clock_swap', 'clock', 'I can''t make a shift I''m rostered on. Can I swap?', 'Open the shift under My shifts and press Give up this shift. A colleague in your department who is free can take it, and your supervisor approves. Until that happens, the shift is still yours.', '[{"label":"Give up a shift","path":"att-me"}]', 210),
  ('pay_when', 'pay', 'When am I paid, and where do I see my payslip?', 'Salaries are paid monthly after the payroll closes. Your payslip is under My payslips. The first time, you set a code so nobody else with your phone can open it.', '[{"label":"My payslips","path":"att-my-payslips"}]', 220),
  ('pay_whats_on_it', 'pay', 'What is on my payslip?', 'Basic salary, allowances, your bonus for the month, then SSNIT (5.5%) and PAYE tax taken off, any advance repayment, and what is paid to you.

The property pays the tax on your bonus, so the bonus figure is what you receive.', '[{"label":"Handbook: Pay, payslips and deductions","path":"handbook"}]', 230),
  ('pay_bonus', 'pay', 'How is my bonus worked out?', 'You are scored each month on your department''s scheme. Your score sets the bonus, and it is added on top of your fixed take-home. Ask your supervisor what the scheme measures. The figure is on your payslip.', '[]', 240),
  ('pay_wrong', 'pay', 'I think my pay is wrong. Who do I talk to?', 'Check My report first for the days counted. Then raise it with HR within the month, with the payslip and the days you mean. Mistakes are corrected on the next payroll.', '[{"label":"My report","path":"att-my-report"},{"label":"My payslips","path":"att-my-payslips"}]', 250),
  ('pay_deductions', 'pay', 'What can be deducted from my pay?', 'SSNIT and PAYE by law; an advance you agreed to repay; and a deduction from your bonus for misconduct, which you are told about on the day it is entered, with the reason.

Nothing comes off your basic salary without you being told.', '[{"label":"Handbook: Pay, payslips and deductions","path":"handbook"}]', 260),
  ('money_advance', 'money', 'Can I get a salary advance?', 'Ask under My advance: how much, why, and over how many months. HR decides. Repayments come off your pay each month and you can see the balance any time.', '[{"label":"Ask for an advance","path":"att-my-advance"}]', 270),
  ('money_medical_claim', 'money', 'How do I claim medical bills?', '1. Open My claims and press Make a claim.
2. Add each bill: amount, date, what for, and photos of the receipt and prescription (up to 5 per bill).
3. Send it. The office decides and you are told either way.

Your balance for the year is at the top of the form. Keep the paper receipts until the claim is approved.', '[{"label":"Make a claim","path":"att-my-medical"}]', 280),
  ('money_medical_balance', 'money', 'How much medical allowance do I have?', 'It is set per year and shown under My claims. Ask HR if yours looks wrong.', '[{"label":"My claims","path":"att-my-medical"}]', 290),
  ('conduct_problem', 'conduct', 'I have a problem with a colleague or manager. What do I do?', 'Try to raise it with the person first if you can. If not, or it continues, speak to your supervisor or HR.

Harassment and bullying are never something you have to sort out alone. The grievance procedure in the handbook says how it is handled and in what time.', '[{"label":"Handbook: Raising a problem","path":"handbook"},{"label":"Handbook: Dignity at work","path":"handbook"}]', 300),
  ('conduct_break_rule', 'conduct', 'What happens if I break a rule?', 'Depending on what it is: a conversation, a written warning, or for serious things, dismissal. You are told what you are said to have done, you can answer it, and you can bring a colleague. The steps are in the handbook.', '[{"label":"Handbook: Disciplinary procedure","path":"handbook"}]', 310),
  ('conduct_social', 'conduct', 'Can I post about work on social media?', 'Not about guests, colleagues, or anything inside the property. Photos of the property itself only with permission. Being proud of where you work is fine; naming guests is not.', '[{"label":"Handbook: Social media","path":"handbook"}]', 320),
  ('app_pin', 'app', 'I''ve forgotten my PIN.', 'Ask HR or an administrator to reset it. You will be given a new one and asked to change it the first time you sign in.

Never share your PIN. It is your signature on everything you do in HIVE.', '[]', 330),
  ('app_alerts', 'app', 'I''m not getting notifications on my phone.', 'Open HIVE, press the bell, and turn alerts on. On iPhone, HIVE has to be added to the home screen first. If your phone cannot take alerts, the rota and lunch still reach you by email.', '[{"label":"Turn on alerts","path":"att-me"}]', 340),
  ('app_lunch', 'app', 'How do I order lunch?', 'Under My lunch, say yes or no for each day of the week. You can ask to change up to 24 hours before the day. After that the kitchen has already ordered.', '[{"label":"My lunch","path":"att-my-lunch"}]', 350),
  ('app_who_sees', 'app', 'Who can see my details and pay?', 'Your pay: you, payroll and the administrator. Your address and personal details: HR only. Colleagues see your name, department and photo. Nobody else''s details are shown to you either.', '[{"label":"Handbook: Data protection","path":"handbook"}]', 360)
  )
);
