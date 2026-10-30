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
4. **Choose what supervisors see.** Insight → Settings › Rules → Who sees
   what. Pick a preset for each supervisor: **Front desk supervisor** (shifts
   and closing reports without amounts; acts on staff answers, unpaid stays and
   advances, and reopens a report) or **Accounts** (amounts, bank and Odoo;
   acts on card and bank, cash movements, POs, staff answers, money out and
   advances; loads files). **Custom** sets each part by hand as Hidden, See,
   or See and act. "New supervisors start as" sets what somebody gets before
   they are given their own.
5. **Choose who is told.** Settings → Who is told. Pick HIVE logins, and
   for each: web push, email, whether the message carries amounts, and which
   messages: **shift closed** (the moment somebody signs their closing report),
   the **daily summary** (each morning at 06:45: yesterday's shifts and what
   waits for an admin), staff answered, a supervisor correction to approve.
6. **Load the journal again** for the days you want rentals checked on. Older
   uploads did not keep ASSD's article lines, which is where padlock deposits
   and refunds are read from.

## What staff are asked

| Question | Why it is still asked |
| --- | --- |
| Was your opening float correct? (and by how much, and why, if not) | Only they know what they were handed. |
| Cash in the drawer now, one total | Checked against ASSD's own closing count. |
| Did you move cash to the safe? If yes: each envelope's number (digits only) and amount | Compared with what ASSD labelled safe. Both are required once they say Yes. |
| Each expense: the PO number | One box: type a PO number, or several at once ("P00412, 415, 420"), and tap **Add**. Each is looked up in Odoo (read-only) straight away and listed with its supplier, its amount (the PO's own total, which cannot be typed over) and a chip: **✓ Counted** (approved in Odoo and reported on the expense form), **Advance** (still waiting for approval: cash given out before the purchase, counted at the requisition's amount, in this person's name), **Report on form** (approved but not on the expense form yet: it stops the report until it is), or **Cancelled** (remove it). A PO paid on another shift is **Already claimed**. Above the box, **From the last shift** lists what earlier shifts left, and each one holds up **Sign and send** (the **To close:** line says what): an advance not yet approved and reported, a **Refund** (the PO was bought for less: put the money in the drawer and tap **Done**), or a **Deficit** (bought for more: **Done** if it was paid from this drawer, or **Not on my shift**). Refunds and deficits are shown for POs paid in the last five days; older ones go to the admins in Insight. See [Advances](advances.md). |
| Padlocks at the start and the end | Fewer means a padlock was rented, so ASSD should have a deposit (article 405); more means one came back, so ASSD should have a refund. |
| Is the scale / hair dryer at the front desk? | A physical check. A No needs the guest who has it or an explanation before they can sign. Admins add more items under Settings → Front desk. |
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
the HIVE login mapped to its ASSD user under Settings → Front desk → Whose ASSD login is whose.

- **The drawer did not agree**: ASSD's closing count against what the drawer
  should have held.
- **Cash left the drawer with no envelope or PO**: everything ASSD moved out
  has to be in a safe envelope or covered by a confirmed PO. Adding the PO
  from To sort out clears it by itself.
- **Envelopes and POs add up to more than left the drawer.**
- **A rental count did not agree with ASSD.**
- **No closing report**, from the first day anybody closed a shift in HIVE.

A difference no bigger than the amount under Settings → Limits → Small
differences is left off.

Staff explain, add the PO, or say they will pay it back. An admin, or a
supervisor given it, then **accepts**, records it **paid in cash**, **writes
it off**, **sends it back** for more, or **recovers it from pay**. Recovering
makes a one-month advance in HIVE, so it comes off the next payslip the way
any advance does; it is offered only once the person has said they will pay
it back. Settled items leave the person's list, and they are told.

## Checked, or not checked yet

A difference is worked out from the files as they stand, and those can change
when somebody reviews the shift (a journal loaded again, a correction). So
until somebody has **checked** the shift, its person sees what is on it under
**Not checked yet**: shown softer, money amounts as "About GH₵…", with
"Nothing to do yet". They can **add a note** if they know why (whoever checks
the shift sees it), but cannot explain, pay back or give a PO yet, and it is
not counted on their HIVE home screen.

- **Checking a shift:** open it under Shifts, look at the closing report, the
  drawer and the payments, and press **✓ Mark this shift checked** (on the bar
  under its heading). Admins can, and so can anybody given **Check shifts**
  under Settings → Who sees what. Its people are told ("Your afternoon shift
  on Wed 7 Oct has been checked"), and their items move to **Checked: please
  sort these out**, with who checked it. **Undo** takes it back.
- **Changed since it was checked:** each difference is confirmed as it was when
  checked. If one changes afterwards, it shows as not checked yet again, and
  the shift says **Changed since it was checked** with **Check again**.
- **On the week:** each shift says ✓ Checked, Not checked, or Changed since
  checked.
- Something an admin **put on somebody's account** counts as checked: it is an
  admin's decision already.

Every shift starts as not checked, including ones from before this came in.

## Putting a difference on somebody's account

A drawer short, a drawer over or a hand-over difference belongs to whoever
held that shift's drawer. When it is really somebody else's (two people held
the drawer, a hand-over without a count, somebody covering), an admin opens it
in Front desk › Shifts › To sort out (or on the shift) and presses **Put on a staff account**:

- **Who and how much.** One person or several, front desk first. All of it is
  placed; to keep part on the shift's own person, add them as one of the lines.
- **Why.** Required: a quick reason (Both held the drawer, Handed over without
  counting, Covered this shift, Agreed with them) and/or a sentence.

**Any other difference with an amount** can go on an account the same way: a
payment on the terminal not in ASSD, a card declined, a PO total that does not
match its expenses, and so on. For these the admin also says which way it goes:

- **Deficit: they owe it.** On their account as money they owe, like a drawer short.
- **Surplus: owed to them.** On their account as money owed to them, like a drawer over.

It works on a difference with a supervisor's answer waiting for approval too:
**Put on a staff account** sits beside Approve and Reject, and moving it
decides it instead (the answer is set aside, and it leaves Approvals).

Each person gets a HIVE message (push and email) and finds their share on
**To sort out**, marked *Moved to you* with the reason, where they explain it
or say they will pay it back. It is then settled like anything else on their
list (Accept, Paid in cash, Recover from pay, Write off). The shift's own
person, if none of it is theirs any more, is told it has left their list. The
card on the shift reads "Put on staff accounts: …, Reason: …".

**Undo** takes it back off their accounts, puts it back on the shift and tells
them; it is refused once anybody's share has been settled. Under People,
**This month, per person** counts what was put on each person; tap a name for
every line on their account and why it is theirs.

## Supervisors' corrections and answers

The drawer's own exceptions (drawer short or over, hand-over counts, receipts,
movements, POs, laundry) follow **Correct cash movements**: See shows them in
the Inbox, See and act lets the supervisor answer and reconcile them. Card and
bank lines follow **Bank statement and card matching** alone.

A supervisor given **Correct cash movements → See and act** can correct a
movement, but it counts only once an admin approves it under Front desk › Shifts › To sort out →
Waiting for admin. Two exceptions count straight away, and the daily summary lists
them: a movement at or under the small-differences limit (Settings →
Limits), and cash no count labelled, labelled expenses, the safe or a split.
Changing a label a count gave, and matching duplicates or reversals, still
wait. The same goes for a supervisor's answer to an exception and for
exceptions a supervisor reconciles together: they show as "Waiting for an
admin" and stay on the list until an admin approves them (Front desk › Shifts › To sort out → Waiting for admin,
or Approve on the exception itself). Reject puts them back. An admin's own
answers clear at once. Admins chosen under Who is told hear about each one.

Supervisors never see the totals at the top of Shifts.

## A report on the wrong shift

A report is matched to its shift by day and shift. Somebody who closes after
eleven at night is offered the night by the clock, so an afternoon closed late
can land on the night row. Where ASSD has somebody on a shift with no report
and that person's report is on the shift just before or after (one ASSD has
somebody else on, or nobody), both shifts say so: the empty one offers **Move
it to this shift**, the one it landed on **Move it to …**.

Any signed report can also be moved by hand: **⇄ Move to another shift** on
its card, or **Move…** on Shifts → **Closing reports**. Choose a day (up to
two days either side of when it was signed), one of that day's shifts (each
says who ASSD has on it; one that already has a report cannot be chosen,
reopen that one first), and say why. The report and its POs move, the reason
is kept on the report ("Moved here from … by …, when, why", with **Move it
back**), and the person is told in HIVE. Admins, and supervisors allowed to
reopen a report, can move one.

**Closing reports** (a tab of Shifts) lists every report in the period,
newest first: the shift it is on, who signed it and when (with "36 min into
the night" when it was signed early in its shift or before it), who ASSD has
on that shift (✗ when it is somebody else), the drawer, and whether the shift
is checked. A report that looks misplaced is shaded, with where it may belong
and a button to move it there; a shift with no report says where its person's
report went. Filters: All, Looks misplaced, No report, Not checked.

The list is read again whenever the tab is opened (it is kept for half a
minute at most), so a report sent from HIVE while Insight is open shows without
a reload. "still open" on a row means the journal loaded stops inside that
shift and no report is filed for it.

## Whose shift it was

A shift is ASSD's from one "Beginning of Day Processing" to the next, and its
name in ASSD is the login that ran that hand-over. When somebody works on
another person's login, the name ASSD gives and the person who closed the
shift in HIVE differ. The shift's page then shows both ("ASSD login: … (did
the hand-over)" and "Closed in HIVE by …", flagged), and the week tiles show
both names. Until somebody chooses, the shift is whoever closed it in HIVE's.

**Choose whose shift it was** (admins, and supervisors allowed to reopen a
report) offers whoever closed it in HIVE, the person the ASSD login belongs to
(under Settings → Whose ASSD login is whose), or anybody else in HIVE, and asks
why. Its differences and its list in HIVE follow the person chosen, and both
people are told in HIVE; answers already given stay with whoever gave them.
**Change** chooses again; **Back to who closed it in HIVE** undoes it.

## The safe

Front desk › **Safe** (admins only) is the safe book. A page runs from one count of
the safe to the next, and its balance is what the safe should hold. Its
"Confirmed in Odoo, not claimed" list follows the days chosen at the top of
Insight.

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
- **Confirmed in Odoo, not claimed** lists the POs ordered in the days chosen
  at the top of Shifts (the day, week or month on screen) that nothing has
  claimed. For each: **Paid from the safe**, **Not from the safe**
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

### Envelopes received

Front desk › Safe › **Envelopes received** (admins, and supervisors given
"Envelopes received" under Settings → Who sees what: See to look, See and act
to mark them received) is the check that the
envelopes receptionists moved to the safe actually arrived. It is separate
from the safe book, which goes on taking every envelope as in the safe.

- **The days**: From and To, or This week, Last week, This month, and
  **Everything not received** (the last 90 days, received ones left out).
- **Four totals**: expected in the safe, received, not received yet (with the
  oldest), and received short or over.
- **One line per envelope**, grouped by day, newest first: the shift, the
  receptionist, the envelope number, what it says (their HIVE closing report),
  what ASSD moved to the safe for the shift and the difference, when it was
  received and by whom, what was counted, and short or over. A shift whose
  journal moved cash to the safe with no envelope in HIVE gets a line of its
  own ("no envelope in HIVE"), expected at what ASSD moved.
- **Marking received**: tick the envelopes, check "Counted in the safe" (it
  starts at what the envelope says; a different count asks why), choose the
  day received and who counted with you, and press **Mark as received**. Each
  received line has **Undo**.
- **Filters**: All, Not received, Received, Differences. **Spreadsheet**
  downloads the same table; **Print** prints it.

## How the two apps talk

Over a Cloudflare service binding, so the call never leaves Cloudflare, and
every request is signed with the shared secret under a label of its own
(`bi/src/lib/link.js`, `src/lib/till-link.js`). A request older than five
minutes, or altered on the way, is refused.

| Asked by | Asks | For |
| --- | --- | --- |
| HIVE | `/api/link/till/setup` | Which checks and rentals the form asks about |
| HIVE | `/api/link/till/po` | Whether a PO is in Odoo, and confirmed; whether it is on the expense form; any admin decision on it |
| HIVE | `/api/link/till/issues` | One person's list |
| HIVE | `/api/link/till/recipients` | Who to tell about an event, and how |
| Insight | `/api/link/till/recover` | A shortage as a one-month advance |
| Insight | `/api/link/till/reopen` | Reopen a signed report |
| Insight | `/api/link/till/tell` | Tell people something was settled, sent back or needs approving |
| Insight | `/api/link/till/expect` | Tell whoever is rostered on the next reception shift that a refund is coming back to the drawer |
| Insight | `/api/link/mail` | Send one email from HIVE's address: an invitation, or word that somebody joined (see `invitations.md`) |

Insight also reads HIVE's database directly, read-only, as it always has:
the reports, the POs claimed and the answers are HIVE's tables.
