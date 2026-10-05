/**
 * The HR FAQ as it ships: the questions staff ask most, answered short.
 *
 * The handbook is the rulebook and is acknowledged chapter by chapter. This is
 * the quick layer on top of it: what to do when you are sick, how to ask for
 * leave, what not to do on duty. Each answer says what to do and points at
 * the screen in HIVE that does it, or the handbook chapter it comes from.
 *
 * Written in plain text, the same shape as a handbook chapter: paragraphs
 * separated by a blank line, "- " for a list, "1. " for steps. Nothing here
 * is markup, so nothing typed into an answer can become one.
 *
 * Installed once, as published, and recognised by code afterwards so that
 * reinstalling never writes over somebody's edits.
 */

export const TOPICS = [
  { key: 'sick', label: 'Sick and absent' },
  { key: 'leave', label: 'Leave' },
  { key: 'duty', label: 'On duty' },
  { key: 'clock', label: 'Clocking in and the rota' },
  { key: 'pay', label: 'Pay and payslips' },
  { key: 'money', label: 'Advances and medical' },
  { key: 'conduct', label: 'Problems and conduct' },
  { key: 'app', label: 'Using HIVE' },
];

export const TOPIC_KEYS = TOPICS.map((t) => t.key);

/**
 * Where an answer can send somebody. A path the app knows, and the words on
 * the button. Kept as a list so the editing screen offers these and nothing
 * else, and so an answer cannot link out of the app.
 */
export const LINKS = [
  { path: 'att-me', label: 'My shifts' },
  { path: 'att-my-report', label: 'My report' },
  { path: 'att-my-lunch', label: 'My lunch' },
  { path: 'att-my-payslips', label: 'My payslips' },
  { path: 'att-my-advance', label: 'My advance' },
  { path: 'att-my-medical', label: 'My claims' },
  { path: 'att-my-contracts', label: 'My contract' },
  { path: 'att-rota', label: 'Rota' },
  { path: 'swaps', label: 'Swaps' },
  { path: 'handbook', label: 'Handbook' },
];

export const LINK_PATHS = LINKS.map((l) => l.path);

const q = (code, topic, question, answer, links = []) => ({
  code, topic, question, answer: answer.trim(), links,
});
const to = (label, path) => ({ label, path });

export const DEFAULT_FAQ = [
  // Sick and absent
  q('sick_cant_come_in', 'sick', "I'm sick and can't come in. What do I do?", `
1. Before your shift starts, tell your supervisor. A call or a message. Do not just not turn up.
2. In HIVE, open My leave and ask for sick leave for the days you will be off. The office sees it straight away.
3. If you are off more than one day, get a note from the clinic or hospital. Paid sick leave needs a medical certificate.

Tell your supervisor before the shift. A day with no word is recorded as absent.`,
  [to('Ask for sick leave', 'att-me'), to('Handbook: Leave and absence', 'handbook')]),

  q('sick_during_shift', 'sick', 'I feel unwell during my shift. Can I go home?', `
Tell your supervisor first. They decide whether you can go and who covers. Clock out when you leave, so the hours you did are recorded. The rest of the day is marked by your supervisor, not by you.`,
  [to('Handbook: Hours, the rota and clocking in', 'handbook')]),

  q('sick_certificate', 'sick', 'Do I need a medical certificate?', `
For one day, no, but tell your supervisor. For two or more days, yes: bring the certificate when you return, or photograph it and send it to HR. Without one, the days are unpaid.`,
  [to('Handbook: Leave and absence', 'handbook')]),

  q('sick_family', 'sick', 'Someone in my family is ill or has died. What leave can I take?', `
Ask for compassionate leave in My leave and tell your supervisor. HR will talk to you about how many days. It is decided case by case and does not come off your annual leave.`,
  [to('Ask for compassionate leave', 'att-me')]),

  q('sick_absent_means', 'sick', 'What counts as being absent?', `
A rostered day you did not work and did not have approved leave for. One tap in with no tap out can also become an absence if nobody confirms what time you left.

Absences show on My report. Repeated absence without a reason goes to the disciplinary procedure.`,
  [to('See my days', 'att-my-report')]),

  // Leave
  q('leave_how', 'leave', 'How do I ask for annual leave?', `
1. Open My leave and press Ask for leave.
2. Pick the first and last day and the type. Add a note if it helps.
3. It goes to your manager. You get a notification when it is decided, either way.

Ask as early as you can, even months ahead. You do not need to wait for the rota to be built. While it is waiting you can take it back yourself.`,
  [to('Ask for leave', 'att-me')]),

  q('leave_balance', 'leave', 'How much leave do I have, and how is it counted?', `
Your balance is at the top of My leave. The property gives 15 working days a year after your first 12 months.

Only rostered working days are charged. Rest days and public holidays inside your leave cost nothing.`,
  [to('My balance', 'att-me')]),

  q('leave_rest_days', 'leave', 'Can I take leave over my days off?', `
Yes. If you will be away, ask for it anyway so nobody calls you in. If the days are all rest days it costs you nothing.`,
  [to('Ask for leave', 'att-me')]),

  q('leave_how_many_off', 'leave', 'How many people can be off at once?', `
There is a limit per department. If your dates would take the department over it, HIVE tells you when you ask, so you can pick other dates rather than wait for a no.`),

  q('leave_vs_unavailable', 'leave', "I can't work a particular day next month. Is that leave?", `
No. That is unavailability: you are telling the planner before the rota is built. Open the rota, choose the week, and mark the days you cannot work. It must be in before the rota for that week is published, and only one person per department can hold a day.

Leave is for days you would otherwise be rostered and want paid.`,
  [to('Mark unavailability', 'att-rota')]),

  q('leave_maternity', 'leave', 'What is maternity leave here?', `
Twelve weeks on full pay, with your annual leave on top. Talk to HR as early as you can so the rota can plan around it. It is recorded by HR rather than asked for in the app.`,
  [to('Handbook: Leave and absence', 'handbook')]),

  // On duty
  q('duty_never', 'duty', 'What should I never do on duty?', `
- Use your phone for personal calls, chats or social media in front of guests.
- Drink alcohol, or come to work under its influence.
- Take photos of guests, their rooms or their documents, or post anything about guests online.
- Accept cash from a guest outside the till, or keep lost property.
- Share your HIVE PIN or clock in for a colleague.
- Leave your station without telling whoever is in charge.

The handbook's code of conduct has the full list. Serious breaches go straight to the disciplinary procedure.`,
  [to('Handbook: Code of conduct', 'handbook')]),

  q('duty_phone', 'duty', 'Can I use my phone on duty?', `
No. Your phone stays away while you are on duty. Use it on your break. If you need to make an urgent call, ask your supervisor for permission first.`,
  [to('Handbook: Code of conduct', 'handbook')]),

  q('duty_tips', 'duty', 'A guest gave me a tip or a gift. Can I keep it?', `
A tip given to you, yes. Cash for a bill goes through the till. A gift worth more than a small token, tell your supervisor so it is recorded.`,
  [to('Handbook: Keys, cash, stock and lost property', 'handbook')]),

  q('duty_guest_asks', 'duty', 'A guest asked me something about another guest. What do I say?', `
Nothing about them. Not whether they are staying, which room, or when they arrived. Offer to pass a message to reception. Guest information stays inside the property.`,
  [to('Handbook: Guest confidentiality', 'handbook')]),

  q('duty_uniform', 'duty', 'What do I wear?', `
Your department's uniform, clean and complete. If something is damaged or missing, tell your supervisor before the shift rather than turning up without it.`),

  // Clocking in and the rota
  q('clock_why', 'clock', 'Why must I clock in and out every time?', `
Clocking is what turns your shift into paid hours. A day with a tap in and no tap out is held until your supervisor confirms when you left, and if nobody can, it can become an absence.

Tap in when you arrive and tap out when you leave, every shift.`,
  [to('See my days', 'att-my-report')]),

  q('clock_forgot_out', 'clock', 'I forgot to clock out. What now?', `
Tell your supervisor the time you left as soon as you remember. They correct it in HIVE and the day is settled. You can see which days are still waiting on My report.`,
  [to('My report', 'att-my-report')]),

  q('clock_late', 'clock', "I'm going to be late. What do I do?", `
Call your supervisor or manager straight away and say when you expect to arrive, so they can cover the gap. A call, not a message, and before your shift starts rather than after.

It does not excuse the lateness, but it means nobody is left guessing.`),

  q('clock_my_shifts', 'clock', 'Where do I see my shifts?', `
My shifts shows this week and next, with who else is on. The bell tells you when a rota is published or changed. You can add HIVE to your phone's home screen so it opens like an app.`,
  [to('My shifts', 'att-me')]),

  q('clock_swap', 'clock', "I can't make a shift I'm rostered on. Can I swap?", `
Open the shift under My shifts and press Give up this shift. A colleague in your department who is free can take it, and your supervisor approves. Until that happens, the shift is still yours.`,
  [to('Give up a shift', 'att-me')]),

  // Pay and payslips
  q('pay_when', 'pay', 'When am I paid, and where do I see my payslip?', `
Salaries are paid monthly after the payroll closes. Your payslip is under My payslips. The first time, you set a code so nobody else with your phone can open it.`,
  [to('My payslips', 'att-my-payslips')]),

  q('pay_whats_on_it', 'pay', 'What is on my payslip?', `
Basic salary, allowances, your bonus for the month, then SSNIT (5.5%) and PAYE tax taken off, any advance repayment, and what is paid to you.

The property pays the tax on your bonus, so the bonus figure is what you receive.`,
  [to('Handbook: Pay, payslips and deductions', 'handbook')]),

  q('pay_bonus', 'pay', 'How is my bonus worked out?', `
You are scored each month on your department's scheme. Your score sets the bonus, and it is added on top of your fixed take-home. Ask your supervisor what the scheme measures. The figure is on your payslip.`),

  q('pay_wrong', 'pay', 'I think my pay is wrong. Who do I talk to?', `
Check My report first for the days counted. Then raise it with HR within the month, with the payslip and the days you mean. Mistakes are corrected on the next payroll.`,
  [to('My report', 'att-my-report'), to('My payslips', 'att-my-payslips')]),

  q('pay_deductions', 'pay', 'What can be deducted from my pay?', `
SSNIT and PAYE by law; an advance you agreed to repay; and a deduction from your bonus for misconduct, which you are told about on the day it is entered, with the reason.

Nothing comes off your basic salary without you being told.`,
  [to('Handbook: Pay, payslips and deductions', 'handbook')]),

  // Advances and medical
  q('money_advance', 'money', 'Can I get a salary advance?', `
Ask under My advance: how much, why, and over how many months. HR decides. Repayments come off your pay each month and you can see the balance any time.`,
  [to('Ask for an advance', 'att-my-advance')]),

  q('money_medical_claim', 'money', 'How do I claim medical bills?', `
1. Open My claims and press Make a claim.
2. Add each bill: amount, date, what for, and photos of the receipt and prescription (up to 5 per bill).
3. Send it. The office decides and you are told either way.

Your balance for the year is at the top of the form. Keep the paper receipts until the claim is approved.`,
  [to('Make a claim', 'att-my-medical')]),

  q('money_medical_balance', 'money', 'How much medical allowance do I have?', `
It is set per year and shown under My claims. Ask HR if yours looks wrong.`,
  [to('My claims', 'att-my-medical')]),

  // Problems and conduct
  q('conduct_problem', 'conduct', 'I have a problem with a colleague or manager. What do I do?', `
Try to raise it with the person first if you can. If not, or it continues, speak to your supervisor or HR.

Harassment and bullying are never something you have to sort out alone. The grievance procedure in the handbook says how it is handled and in what time.`,
  [to('Handbook: Raising a problem', 'handbook'), to('Handbook: Dignity at work', 'handbook')]),

  q('conduct_break_rule', 'conduct', 'What happens if I break a rule?', `
Depending on what it is: a conversation, a written warning, or for serious things, dismissal. You are told what you are said to have done, you can answer it, and you can bring a colleague. The steps are in the handbook.`,
  [to('Handbook: Disciplinary procedure', 'handbook')]),

  q('conduct_social', 'conduct', 'Can I post about work on social media?', `
Not about guests, colleagues, or anything inside the property. Photos of the property itself only with permission. Being proud of where you work is fine; naming guests is not.`,
  [to('Handbook: Social media', 'handbook')]),

  // Using HIVE
  q('app_pin', 'app', "I've forgotten my PIN.", `
Ask HR or an administrator to reset it. You will be given a new one and asked to change it the first time you sign in.

Never share your PIN. It is your signature on everything you do in HIVE.`),

  q('app_alerts', 'app', "I'm not getting notifications on my phone.", `
Open HIVE, press the bell, and turn alerts on. On iPhone, HIVE has to be added to the home screen first. If your phone cannot take alerts, the rota and lunch still reach you by email.`,
  [to('Turn on alerts', 'att-me')]),

  q('app_lunch', 'app', 'How do I order lunch?', `
Under My lunch, say yes or no for each day of the week. You can ask to change up to 24 hours before the day. After that the kitchen has already ordered.`,
  [to('My lunch', 'att-my-lunch')]),

  q('app_who_sees', 'app', 'Who can see my details and pay?', `
Your pay: you, payroll and the administrator. Your address and personal details: HR only. Colleagues see your name, department and photo. Nobody else's details are shown to you either.`,
  [to('Handbook: Data protection', 'handbook')]),
];

export const FAQ_CODES = DEFAULT_FAQ.map((f) => f.code);
