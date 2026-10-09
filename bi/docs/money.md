# Money, from what the shifts know

The Money page adds up revenue, purchases and wages by part of the business.
Two of its figures now come from records Insight already holds for the shifts.

## The rooms' revenue, from the ASSD journal

Each reservation in the journal carries what it was charged, line by line and
day by day. Added up by the day each charge is for, that is the rooms' takings,
which no other system reports.

- **Nights** (articles 100 to 289) are always the rooms. Room-nights are counted
  too.
- **Every other article** is decided once, on the Money page under **Revenue
  from the ASSD journal**:
  - revenue of a part of the business (a minibar under Bar, say);
  - **counted by another system** (laundry has its own, so it is not counted
    twice);
  - **not revenue**: a deposit, a tax.

  A rental's deposit article (Till settings) starts as *not revenue* and the
  laundry article as *counted by another system*. Anything else starts *not
  decided*, is not counted, and the page says how much is waiting.
- It is written whenever a journal is uploaded, again each night, and again when
  an article is decided. It is only as complete as the journal loaded.

## Spending paid in cash

Every PO paid in cash is already known: a closing report's expenses (HIVE), the
drawer expenses on a shift, and the safe book. Each night, and on **Check Odoo
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
- **To chase:** cash POs with no bill, payments that are not what the PO says,
  bills with no PO, and any cash PO Odoo does not know at all.

## The to-do list

Shifts → **To-do**, for admins and supervisors. Three checks raise items each
time Odoo is asked:

| Item | Raised when | Clears itself when |
| --- | --- | --- |
| Paid in cash, no bill in Odoo | a cash PO still has no bill after 7 days (an admin can change this) | the bill is in Odoo |
| Paid is not what the PO says | what left the cash differs from the PO's total | the two agree |
| A bill with no PO | a bill in Odoo from the last 45 days has no PO | the bill is linked to a PO |

- Each new item goes to the supervisor with the fewest open, so the list shares
  itself out. A supervisor sees only their own; the tab shows how many.
- On a cash PO waiting for its bill, a supervisor can only note where it has got
  to; the bill closes it.
- On the other two, a supervisor's answer waits for an admin: **Approve** closes
  it, **Send back** returns it with the reason.
- An admin sees everything, can give an item to another supervisor, can answer
  and close one directly, or close one with **Nothing needed** and a reason. An
  item closed by a person does not come back; one that closed itself comes back
  if the problem does.
