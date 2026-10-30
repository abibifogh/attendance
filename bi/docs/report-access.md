# Who sees which reports

**Settings › People & access › Reports they see.** Admins and owners see every report. For
everybody else an admin ticks the report pages they may open: Brief,
Management, Overview, Yardstick, Prepaid stays, Tills & collections, Labour,
Guests, Buying, Nice Place. A ticked page appears in their Reports menu;
nothing else is opened to them.

- A **supervisor** keeps Shifts as set under Settings › Rules, and gets the
  ticked reports as well.
- An **uploader** keeps the files, and gets the ticked reports as well.
- Somebody with **only the hub** who is given a report gets Insight as
  **Reports only**: the ticked reports and nothing else (no Shifts, no money,
  no approvals). Taking their last report away takes Insight away again. An
  owner can also choose *Reports only* under Accounts.

Reading a report is all a ticked report gives. What a report page lets an
admin change (its settings, who is emailed, a reading put right, refreshing
from Odoo) stays an admin's.

How it is checked: every endpoint a report page reads is named with its report
in `src/routes/reportaccess.js`; anybody who is not an admin is refused any
other `insight` endpoint. Tested in `test/reportaccess.test.js`.
