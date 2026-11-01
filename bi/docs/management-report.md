# The management report

**Reports › Management report.** A week or a month of the other systems on one page:
eight figures at the top, *Needs your attention* (the few things worth a
decision, most serious first), then a section for each system. Breakfast and
Maintenance are in it now; the front desk, the laundry, the restaurant and
Nice Place are to follow, each as a section of its own.

- **Week / Month**, and ‹ › for the one before or after. With nothing chosen:
  the last week that is over, or this month so far.
- **⤓ PDF** prints the page (the buttons are left off; breakfast and maintenance each start a page).
- **✉ Send**: see *The email* below.

## Where the figures come from

Each system works out its own figures, so the report says what that system's
own screens say. Insight only asks, and signs every request with that
system's own secret (`src/lib/link.js`, the same signature as the till link).

| Section | Asked of | Signed with |
|---|---|---|
| Breakfast: food used at cost, guests, cost per guest and what moved it, deliveries by supplier, the bakery, stock below its reorder level, counts against the books | the breakfast app, `POST /api/link/report` at its address under Accounts › Systems (or `BREAKFAST_URL`) | `SSO_SECRET_BREAKFAST` (the breakfast app holds the same value as `INSIGHT_SSO_SECRET`) |
| Maintenance: room rounds, jobs, each artisan's score (as its Productivity page works it out), the store's parts used and stock, tools out | the maintenance database's `report` function, next to its `approvals` function (or `MAINTENANCE_REPORT_URL`) | `SSO_SECRET_MAINTENANCE` (the maintenance repo's GitHub secret `INSIGHT_APPROVALS_SECRET` holds the same value) |

A system that is not linked, or cannot be reached, is said in its section and
in *Needs your attention*; the rest of the report is still made.

## The email

Nothing is sent until an admin presses **✉ Send** (it takes you to *Sending
the report* at the bottom of the page) and then **Send … now**. *Send a test
to me* sends it to whoever presses it; anybody who can open the report may
send it to themselves.

**Sending by itself** is a switch on the same card, off until an admin
switches it on. When on, the ticked ones go at 06:45 (with the daily till
summary): every Monday last week's report, on the 1st last month's, each
period once.

It goes to Insight's admins (unless unticked) and any address added there. It
carries the figures, what needs attention, both sections in short and a link
back to the page; it is HTML, not a PDF attachment (HIVE, which sends
Insight's email, attaches only CSV files).

## The Saturday report and the morning digest

Settings › Notifications › Management report, **Saturday report and morning
digest**, an admin's:

- **Saturday report.** One supervisor, chosen there, sends this week's report
  (Monday to Friday) to everybody by **10:00 every Saturday**. Choosing them
  shares the report with them. On Reports › Management report their page opens
  on this week, with **Send to everybody**: for that week only, and nobody
  else who is not an admin has it. The first send of the week counts.
  - Friday **17:00**: a reminder, to them.
  - Saturday **09:00**: a reminder, to them.
  - Saturday **10:00** and **12:00**, if it has not gone: late, to them with
    the admins copied, saying what happens at 14:00.
  - Saturday **14:00**, if it still has not gone (more than four hours late):
    **GH₵50 comes off their bonus in HIVE** (`/api/link/pay/dock`), on the
    first payroll still open, with the reason, and HIVE tells them as it does
    any deduction; they and the admins are emailed. Taken once a week, however
    often it is asked; if HIVE cannot be reached it is asked again each hour
    that Saturday.

  Sent after 10:00 but before 14:00 is late, and nothing comes off. The last
  weeks show under the setting: when it was sent and by whom, or what came off.
  An admin who must undo a deduction removes it on the month's payroll in HIVE.
- **Morning digest.** At **07:00** each supervisor gets their own Assistant
  list by email (what waits on their yes or no, what is going wrong), with the
  admins copied. Nothing waiting, no email; on the Saturday morning the person
  on duty is reminded of the report in it too.

Everything runs on an hourly schedule (`0 * * * *`, Accra's clock is UTC);
each step is kept in a log (`mgmt_duty_log`), so an hour run twice does
nothing twice.

## Who can open it

Admins see it. Anybody else sees it when an admin ticks *Management* for them
under Settings › People & access › Reports they see (see `src/routes/reportaccess.js`).

Code: `src/routes/mgmt.js`, `public/js/views/mgmt.js`, tested in
`test/mgmt.test.js`.
