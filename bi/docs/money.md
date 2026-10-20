# Money, from what the shifts know

Reports › **Overview** (it was the Money page) adds up revenue, purchases and wages by part of the business.
Two of its figures now come from records Insight already holds for the shifts.

## The rooms' revenue, from the ASSD journal

Each reservation in the journal carries what it was charged, line by line and
day by day. Added up by the day each charge is for, that is the rooms' takings,
which no other system reports.

- **Nights** (articles 100 to 289) are always the rooms. Room-nights are counted
  too.
- **Every other article** is decided once, on Reports › Overview under **Revenue
  from the ASSD journal**:
  - revenue of a part of the business (a minibar under Bar, say);
  - **counted by another system** (laundry has its own, so it is not counted
    twice);
  - **not revenue**: a deposit, a tax.

  A rental's deposit article (Shifts → Settings → Front desk) starts as *not revenue* and the
  laundry article as *counted by another system*. Anything else starts *not
  decided*, is not counted, and the page says how much is waiting.
- It is written whenever a journal is uploaded, again each night, and again when
  an article is decided. It is only as complete as the journal loaded.

## Spending paid in cash

Every PO paid in cash is already known: a closing report's expenses (HIVE), the
drawer expenses on a shift (every PO number typed there, whether or not it was
looked up in Odoo; `2433` is read as `P02433`), and the safe book. Each night, and on **Check Odoo
now**, Insight asks Odoo about each one (read-only): is it billed, and what did
it buy, by part of the business.

- **Not billed yet:** what left the cash is counted in Purchases on the day it
  left, on the PO's own part of the business (its analytic account, through the
  Odoo line map; *admin* when it has none). When the bill is posted, the bill
  counts instead, so nothing is counted twice. On a part of the business still
  read from an operating system (the kitchen's own records), it is not added,
  for the same reason.
- **How the spending was paid:** Odoo's bills by their date and unbilled cash
  by the day it left, split into *from the drawer*, *from the safe*, and *by
  bank or on credit* (the rest), by supplier and by part of the business.
  A cash PO Odoo does not know at all is named under it.
- **What to chase** is not repeated here: it is in Shifts → **Inbox → POs**.

## The to-do list

Shifts → **Inbox → POs**, for admins and supervisors (an answered item waits
under **Waiting for admin**). Two checks raise items each
time Odoo is asked:

| Item | Raised when | Clears itself when |
| --- | --- | --- |
| PO with no posted bill in Odoo | a PO confirmed in Odoo still has no posted bill 7 days after the cash left the drawer or the safe, or, for any other PO ordered in the last 90 days, after it was ordered; a draft bill is named on the item | the bill is posted in Odoo |
| Paid is not what the PO says | what left the cash differs from the PO's total | the two agree |

Both numbers are an admin's, under Shifts → Settings → Limits: **PO without a
posted bill** after [7] days, and **look for POs over the last** [90] days
(7 to 730). A changed look-back asks Odoo again when saved; a shorter one closes
the items for POs ordered before it ("Ordered before the N-day look-back"), and
a longer one brings them back. POs paid in cash are chased whatever the
look-back.

Bills with no PO are no longer raised; the items they had raised were closed.

- Each new item goes to the supervisor with the fewest open, so the list shares
  itself out. A supervisor sees only their own; the tab shows how many.
- Nothing is typed on an item: each is put right in Odoo (the bill posted, the
  PO corrected, the bill linked to its PO) and clears itself on the next check.
  An answer given before this changed still waits for an admin: **Approve**
  closes it, **Send back** returns it with the reason.
- The items sit in the Shifts **Inbox** with everything else to act on: a
  short line each on the left (oldest first), everything about the one picked
  on the right, with **Previous** and **Next**. The **POs** chip shows them
  alone.
- **Refresh now**, at the top of the Inbox, asks Odoo again for everybody who
  has a list, supervisors included, so a bill posted a minute ago clears its
  item straight away (the same as the button on Reports › Overview), and reads the
  laundry system for the last three days up to today (an admin sets how many,
  1 to 60, under Settings → Limits), so a finished shift's laundry is compared
  without waiting for the nightly run. Only the laundry system's own figures
  are replaced. It needs Insight's key for the laundry (the repository secret
  `INSIGHT_LAUNDRY_TOKEN`, then **Set Insight's secrets**); without it the
  laundry is never read, and Refresh now says so.
- An admin can tick several PO items and give them to one supervisor at once.
- An admin sees everything, can give an item to another supervisor, or close
  one with **Nothing needed** and a reason. An
  item closed by a person does not come back; one that closed itself comes back
  if the problem does.

## Wages: estimated during the month, the payslips at the end

**During the month**, before its pay run is finalised, wages are estimated from
each person's pay in HIVE:

- a salaried person costs their monthly pay divided by the number of days in
  that month, on every day of it, worked or not (GH₵2,100 in a 30-day month is
  GH₵70 a day), from the day that pay began; somebody who has left is costed up
  to the last day they worked;
- anybody paid by the day or by the hour costs their rate for the time they
  worked;
- both carry the employer's 13% SSF on top, as the payslip will (GH₵2,100 a
  month is GH₵79.10 a day in a 30-day month);
- anybody with no pay recorded is costed at the default hourly cost in Setup,
  and the note under the Money table says how much of the bill that is.

**At the end of the month**, once HIVE's pay run for it is **finalised**, the
estimate is replaced by the actual payslips: gross pay (with allowances and
bonus) plus the employer's SSF. A payslip is monthly and the page is daily, so
each department's payslips are spread over the month's days by the hours that
department worked each day (by the line's hours if the department has none
recorded, evenly if the line has none). The whole month adds up to the payslips
exactly; a week inside it shows that week's share.

The note under the Money table says which months are payslips and which are
estimates. The nightly read looks two months back for pay runs, so a month
finalised late is still picked up. The estimate has no allowances or bonus, so
a month can still move a little when its payslips arrive. People paid outside
HIVE's payroll are not in a paid month's wages.

## Prepaid stays

Reports → **Prepaid stays** shows a month of reservations, by the month the
guest arrived (the first night charged; a reservation with no night belongs to
the day it was keyed). For each: its ASSD reservation number and rooms, the
stay and nights, what it was charged, what was prepaid and how (bank transfer
or card online, with the day the prepayment was keyed in ASSD), what was paid
at the desk, the balance, and **Prepaid in full**, **Part prepaid** or **Not
prepaid**. Above it: how many arrived and what they were charged, the prepaid
total and its share, how the month was paid, and the prepaid share of the six
months to it. **Download CSV** gives the whole month. Guests are identified by
reservation number and room only: their names are taken out of the journal
before it leaves the browser.

**Monthly prepaid summary.** An admin adds the addresses, any address, on the
same page. On the 5th of every month, with the morning summary (06:45 Accra),
the month before goes to each of them through HIVE's email: the figures, every
prepaid reservation, and all the month's reservations as a CSV attached. Each
month is sent once by the 5th.

- **Only a whole month goes by itself.** If the journals loaded do not cover
  every day of the month, the 5th does not send it. Instead each admin gets an
  email saying the month is waiting and which days are loaded, and the page
  shows the same prompt at the top. Load the rest under Shifts → Files, then
  press **Send … to everyone**; or send it as it is.
- **Send … to everyone** sends the month on screen to all the addresses at any
  time. It asks first if the month is not complete, or was sent already.
- **Send a test to me** sends the month on screen to the admin pressing it.

The page says when a month is not complete, and which days the journals cover.
