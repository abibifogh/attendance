# The management report

**Reports › Management.** A week or a month of the other systems on one page:
eight figures at the top, *Needs your attention* (the few things worth a
decision, most serious first), then a section for each system. Breakfast and
Maintenance are in it now; the front desk, the laundry, the restaurant and
Nice Place are to follow, each as a section of its own.

- **Week / Month**, and ‹ › for the one before or after. With nothing chosen:
  the last week that is over, or this month so far.
- **⤓ PDF** prints the page (the buttons are left off).
- **✉ Email it** sends the period on screen to you; an admin can also send it
  to everybody on the list.

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

Every Monday morning (06:45, with the daily till summary) last week's report;
on the 1st, last month's. To Insight's admins and any address added under
*Who gets it* at the bottom of the page; either can be switched off. Each
period goes once. The email carries the figures, what needs attention, both
sections in short and a link back to the page; it is HTML, not a PDF
attachment (HIVE, which sends Insight's email, attaches only CSV files).

Code: `src/routes/mgmt.js`, `public/js/views/mgmt.js`, tested in
`test/mgmt.test.js`.
