# Closing a shift: HIVE for staff, Insight for the rest

Front-desk staff close their shift in **HIVE**, under **My till**, on the desk
PC or on their phone. It replaces the Google Form. Insight sets every closing
report beside the ASSD journal, the card terminal report and the bank, and
puts whatever does not agree back on that person's list in HIVE, under **To
sort out**. Admins and supervisors work it all from Insight → **Shifts**.

## Setting it up, once

1. **Join HIVE and Insight.** In GitHub, run **Actions → Set Insight's
   secrets** with Insight's address in the box. This is the same secret the
   sign-in hand-off uses; if the hand-off already works, this is done. Until
   it is, staff can still close shifts, but PO numbers cannot be checked and
   To sort out stays empty, and Insight says so at the top of its till views.
2. **Give the front desk My till.** In HIVE → Setup → Users, tick **My till**
   for each front-desk login. Their login must point at their staff record,
   or there is no pay to recover a shortage from.
3. **Make supervisors.** In Insight → Accounts, set a supervisor's Insight
   access to **Supervisor**. They then see the Shifts tab and nothing else.
   Somebody who only loads the files (the ASSD journal, the bank statement
   and the card terminal report) gets **Uploads only**: an Upload files page
   and the hub, and none of the numbers.
4. **Choose what supervisors see.** Insight → Shifts → Till settings →
   Supervisor access. Each part is Hidden, See, or See and act, the same for
   every supervisor or set per person. Day and Week are shown and Month is
   hidden to start with.
5. **Choose who is told.** Till settings → Who is told. Pick HIVE logins, and
   for each: web push, email, whether the message carries amounts, and which
   events (a shift closed, staff answered, a supervisor correction to approve).
6. **Load the journal again** for the days you want rentals checked on. Older
   uploads did not keep ASSD's article lines, which is where padlock deposits
   and refunds are read from.

## What staff are asked

| Question | Why it is still asked |
| --- | --- |
| Was your opening float correct? (and by how much, and why, if not) | Only they know what they were handed. |
| Cash in the drawer now, one total | Checked against ASSD's own closing count. |
| Did you move cash to the safe? If yes: each envelope's number (digits only) and amount | Compared with what ASSD labelled safe. Both are required once they say Yes. |
| Each expense: the PO number | Looked up in Odoo (read-only). The amount is the PO's own total from Odoo and cannot be typed over. Several PO numbers can be pasted at once ("P00412, 415, 420"). Counts only if the PO is confirmed and has not been claimed on another shift. |
| Padlocks at the start and the end | Fewer means a padlock was rented, so ASSD should have a deposit (article 405); more means one came back, so ASSD should have a refund. |
| Is the scale / hair dryer at the front desk? | A physical check. A No needs the guest who has it or an explanation before they can sign. Admins add more items under Till settings → Front desk checks. |
| Anything the supervisor should know (optional) | |

Name, date and shift come from their HIVE sign-in and the clock. ASSD's cash
and card figures, the terminal amount, laundry and the deficit or surplus come
from the files Insight already reads. They sign with their own HIVE PIN; after
that only an admin, or a supervisor given it, can reopen the report.

Towels are set up (GH₵ 40 down: article 400, the GH₵ 30 deposit, plus 551,
the GH₵ 10 rental; GH₵ 30 back) and switched off. Switch them on under Till
settings → Rentals when the desk starts counting them.

## What goes on somebody's list

A shift belongs to whoever closed it in HIVE. A shift nobody closed belongs to
the HIVE login mapped to its ASSD user under Till settings → People.

- **The drawer did not agree**: ASSD's closing count against what the drawer
  should have held.
- **Cash left the drawer with no envelope or PO**: everything ASSD moved out
  has to be in a safe envelope or covered by a confirmed PO. Adding the PO
  from To sort out clears it by itself.
- **Envelopes and POs add up to more than left the drawer.**
- **A rental count did not agree with ASSD.**
- **No closing report**, from the first day anybody closed a shift in HIVE.

A difference no bigger than the amount under Till settings → Small
differences is left off.

Staff explain, add the PO, or say they will pay it back. An admin, or a
supervisor given it, then **accepts**, records it **paid in cash**, **writes
it off**, **sends it back** for more, or **recovers it from pay**. Recovering
makes a one-month advance in HIVE, so it comes off the next payslip the way
any advance does; it is offered only once the person has said they will pay
it back. Settled items leave the person's list, and they are told.

## Supervisors' corrections and answers

A supervisor given **Correct cash movements → See and act** can correct a
movement, but it counts only once an admin approves it under Shifts →
Approvals. The same goes for a supervisor's answer to an exception and for
exceptions a supervisor reconciles together: they show as "Waiting for an
admin" and stay on the list until an admin approves them (Shifts → Approvals,
or Approve on the exception itself). Reject puts them back. An admin's own
answers clear at once. Admins chosen under Who is told hear about each one.

Supervisors never see the totals at the top of Shifts.

## The safe

Shifts → **Safe** (admins only) is the safe book. A page runs from one count of
the safe to the next, and its balance is what the safe should hold.

- **In** is read from the shifts: what ASSD says each shift moved to the safe,
  with the envelopes from that person's HIVE closing report beside it. Nobody
  types it.
- **Out** is written here, three ways:
  - **+ A PO paid from the safe**: type the PO number. It must be confirmed in
    Odoo and not already claimed by a closing report, a drawer expense or the
    safe. The amount is the PO's total.
  - **+ Paid, PO to follow**: the amount and what it paid for. It stays marked
    *waiting for a PO* until **Add its PO** is used on its row. What left the
    safe stays as written; if the PO's total differs, the row says so.
  - **+ Banked or handed over**: the amount and where it went (a bank slip,
    who received it).
- **Confirmed in Odoo, not claimed** lists the POs since the last count that
  nothing has claimed. For each: **Paid from the safe**, **Not from the safe**
  (it is not offered again), or, when a waiting payment has the same amount,
  **It is the waiting payment**.
- **Count the safe**: type what you counted. The book's verdict shows as you
  type, and when the safe holds less than the book, the waiting POs that add up
  to the difference exactly are highlighted. **Count and close this page**
  records the count, what the book said and the difference, and starts the
  next page from what was counted. The very first count only starts the book.

A HIVE closing report cannot use a PO the safe has paid: HIVE says it was paid
from the safe, not from the drawer. Entries can be removed while their page is
open; a count can be undone from **Counts**, which puts its shifts and entries
back on the open page. An entry or a count cannot be dated before the last
count.

## How the two apps talk

Over a Cloudflare service binding, so the call never leaves Cloudflare, and
every request is signed with the shared secret under a label of its own
(`bi/src/lib/link.js`, `src/lib/till-link.js`). A request older than five
minutes, or altered on the way, is refused.

| Asked by | Asks | For |
| --- | --- | --- |
| HIVE | `/api/link/till/setup` | Which checks and rentals the form asks about |
| HIVE | `/api/link/till/po` | Whether a PO is in Odoo, and confirmed |
| HIVE | `/api/link/till/issues` | One person's list |
| HIVE | `/api/link/till/recipients` | Who to tell about an event, and how |
| Insight | `/api/link/till/recover` | A shortage as a one-month advance |
| Insight | `/api/link/till/reopen` | Reopen a signed report |
| Insight | `/api/link/till/tell` | Tell people something was settled, sent back or needs approving |
| Insight | `/api/link/mail` | Send one email from HIVE's address: an invitation, or word that somebody joined (see `invitations.md`) |

Insight also reads HIVE's database directly, read-only, as it always has:
the reports, the POs claimed and the answers are HIVE's tables.
