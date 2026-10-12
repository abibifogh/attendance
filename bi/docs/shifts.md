# Shifts

The front desk's control sheet, done from the source records instead of typed
from them. It lives on the **Shifts** tab.

## The screen

Six tabs in a row: **Shifts, Inbox, People, Safe, Files, Settings**. The
Inbox tab shows how many things wait in it. The period sits beside the tabs:
the arrows step a day, a week (Monday to Sunday) or a month at a time, and
**Latest** jumps to the newest shifts loaded. When the journal stops inside a
shift, a small note at the end of the line says which; open it for what to do.

- **Shifts**: Day, Week or Month, chosen with the switch beside the tabs.
  - **Day**: the day's three shifts as large cards, each with the drawer in
    four lines, how it came out, how guests paid and what is open; the day's
    cash, card and MoMo against what arrived, commission and laundry.
  - **Week**: every shift in the week as a tile. Green agrees, amber needs a
    look, red needs an answer. Below it, card and MoMo recorded in ASSD
    against what arrived, day by day.
  - **Month**: a calendar, each day's three shifts as coloured bars; the month
    week by week below it.
  - **Tap a shift** for its story, with **‹ Back** to the period and arrows to
    the shift before and after: the **closing report** from HIVE beside ASSD
    (drawer, safe, what left the drawer, rentals, float, front desk checks,
    and Reopen); the drawer as bars from the opening count to the closing
    count; how the shift was paid; card and MoMo on the clock; where the cash
    went, with the POs from the closing report and whether each is approved in
    Odoo and on the expense form. Expenses come from HIVE; where a closing
    report gave no PO (cash a count labelled expenses, or a movement labelled
    expenses by hand), POs can be linked here: **Link POs to these
    expenses**, typed as staff write them (4123, P04123), read from Odoo at
    once and paired with the payments by amount. A PO already on another
    shift is refused; each linked one can be unlinked (×). Labelling a
    movement as Expenses also takes PO numbers. A recount can still be typed and saved. Without the
    amounts, a supervisor sees the closing report and what does not agree.
- **Inbox**: everything somebody has to act on, as one list: what does not
  agree (drawer, card and bank), staff answers from HIVE, POs with no posted
  bill or paid differently, advances, unpaid stays, and what waits for an
  admin. Chips across the top show one kind at a time with its count. The one
  picked opens on the right with what can be done; **Previous** and **Next**
  move, and on a keyboard J and K move and 1 to 8 give an exception's answers.
  **Probably the same money** sits above the list (see below). **Show done**
  brings back what was answered or closed. **Refresh now** asks Odoo about the
  cash POs and reads the laundry system there and then. An admin can tick PO
  items and give them to a supervisor together.
- **People**: each person's shifts, cash and cards, and net drawer variance;
  then what is still with staff under To sort out in HIVE, each person's month,
  and what was settled lately.
- **Safe**: the safe book. **Files**: the three uploads.
- **Settings** (admins): who sees what, who is told, the front desk (checks,
  rentals, whose ASSD login is whose), and the limits. See `docs/till.md`.

A supervisor sees only the tabs and kinds an admin gave them, and amounts only
if they were given those (see `docs/till.md`).

### Exceptions that are one story

Two or more exceptions are often the same money seen twice: GH₵ 203 by MoMo
that reached the bank on the 2nd and was keyed in ASSD on the 4th shows up
once as money ASSD does not show and once as a payment that never arrived.
Tick each of them (**Reconcile with others**) and press **Reconcile
together**; the bar shows what the ticked ones net to, and a note is required
when they do not net to nothing. Any number can be reconciled together, and
each then counts as answered. Where an exception of the same amount pulling
the other way sits within a week, it is offered under **Possibly the same
money** with a one-tap reconcile. **Undo** opens them all again.

## What you load, and how often

All three are loaded on the Shifts tab under **Load files**, by an owner. The
files are opened in the browser. Only amounts, times and ASSD user names are
sent to Insight: guests' names and addresses are cut out of the journal on the
page, and the bank statement's salaries, suppliers and transfers are never
sent. Loading the same file twice changes nothing.

| File | Where it comes from | Notes |
| --- | --- | --- |
| ASSD detail journal | ASSD → Business Reports → *Detail Journal of every Transaction*, printed to PDF | Run it **one day past** the last shift you want. ASSD prints only the lines dated inside the benefit-date range, so a journal that ends on the 7th stops inside the 7th's last shift. |
| Card terminal report | The bank's merchant portal (TAMS), exported as CSV | Every tap, approved or declined, to the second. This is what card payments are matched on. |
| GTBank statement | GTBank internet banking → account statement → the "Excel" download (an .xls file). The Finacle XLSX export also works. | Card settlements, card reversals, commission and MoMo. The same bank row gets the same identity in either format, so loading both never counts it twice. In the Finacle export, rows the bank marked deleted or unposted are ignored. |

A weekly load is enough for the week's reconciliation. A newer journal that
overlaps an older one replaces the overlapping days and keeps the rest.

## What people type

| What | Who | When |
| --- | --- | --- |
| A recount of the drawer | Anybody who reads the numbers | Optional. ASSD's own closing count is used unless one is typed, for a spot check or when ASSD's count is wrong. |
| Expense-sheet total and Odoo PO numbers | Admin | Per shift with expenses. **Save and read from Odoo** fetches vendor, total and state for each PO. Nothing in Odoo is changed. |
| A correction to a cash movement | Anybody who reads the numbers | When a movement was labelled wrong, moved twice, or put back on another shift. |
| An answer to an exception | Admin | When one appears. |

Everything typed is signed with the name of whoever typed it.

## How a shift is worked out

- **Where shifts start and end.** ASSD's *Beginn of Day Processing* marker is
  the hand-over. Everything between two markers is one shift, held by the user
  on the marker. Two markers in a row by the same person are one shift.
- **Which slot.** Shifts run 06–14, 14–22 and 22–06, and a night belongs to the
  day it starts. ASSD has no clock, so each shift is placed by the terminal's
  clock for card payments that identify it, and by the marker's date. A night's
  marker is usually dated the next morning, and that is allowed for.
- **How it was paid.** Every payment line, by ASSD's own method: cash, card
  and MoMo (staff record MoMo as card), prepaid by bank transfer, prepaid by
  card online. Only cash goes into the drawer. Laundry paid in cash is part of
  the cash. Back-office entries on register 015 are never a shift's.
- **Counts.** ASSD's Money Count is a count of the drawer: the notes, plus a
  "Total Expenses PAID" line for receipts of things bought out of the drawer.
  A shift's first count is its opening and its last is its closing.
- **Cash moved out.** Every Cash Movement takes money from the front drawer
  (register 001) to the back office (015). ASSD records only the amount, so
  what it was comes from the Money Count done just before it: the receipts are
  expenses and the notes are cash to the safe. A movement put straight back by
  an equal one the other way on the same shift is a correction, such as 17,630
  keyed for 1,763. A movement with no count before it is shown as not
  labelled.
- **The closing report's expenses** settle only what nothing labelled: what
  the POs on the shift's closing report in HIVE paid, less what is already
  counted as expenses, is expenses, and the rest went to the safe. If they
  and the labelled movements disagree, the gap is shown on the shift rather
  than written over. (An expense sheet total typed here before this came in
  is still used for its shift.)
- **Correcting a movement.** Under "Where the cash went", Correct on any
  movement says what it really was:
  - expenses, cash to the safe, or a split of the two;
  - a duplicate of another movement on the same shift, moved twice but taken
    out once. It is left out of the drawer, which clears the surplus;
  - put back on another shift. A movement into the drawer on a later shift
    that undoes one moved out earlier: both are left out, which clears the
    surplus on the first shift and the deficit on the second.
  Every correction is signed with who made it and can be undone. Insight also
  suggests the likely ones as exceptions: the same amount moved twice on a
  shift that counted over, and money put back that matches a movement out on
  another shift. "Match them" applies the suggestion.
- **The register.** Opening count + cash taken − cash moved out = what should
  be in the drawer. The variance is the closing count minus that. It is the
  same figure ASSD books as an End cash deficit/surplus. On the first week of
  August 2026 the two agreed on every shift. Once a movement is corrected the
  two can differ, and the shift says what ASSD booked before the correction.
- **Laundry.** ASSD's laundry sales for the day are compared with the laundry
  system's figures for the same day, once the laundry system is loaded.

## How card and MoMo payments are matched

In order:

1. One ASSD line to one payment of the same amount inside the shift's hours,
   then with 90 minutes' grace either side.
2. Two or three ASSD lines paid as one payment.
3. One ASSD line paid in two to four goes within 45 minutes. Card and MoMo can
   be mixed.
4. For days the terminal report does not cover, the bank's card credits by day.

Approved terminal payments are then joined to the bank statement by approval
code and card, to check each one arrived.

## The exception groups

| Group | What it means |
| --- | --- |
| The drawer did not agree with its count | The closing count differed from what should have been in the drawer, or the next person's first count differed from the last closing count. Also here: the same amount moved out twice on a shift that counted over, and money put back that matches a movement out on another shift, each with a button to match them. |
| Recorded as paid, but the payment failed | The terminal declined the amount and never approved it afterwards, yet ASSD has it as paid by card. |
| Recorded as card or MoMo, no payment found | Nothing of that amount arrived near the shift. |
| The same card charged twice | Two approved charges to one card, same amount, within 30 minutes, and ASSD has one. |
| Keying slips | Transposed digits, one digit different, or out by a factor of ten against a payment in the same shift. |
| Keyed twice in ASSD | The same amount twice in one shift, paid once. |
| Money received that ASSD does not show | Approved on the terminal or received by MoMo during the shift, and not in ASSD. |
| Did not reach the bank, or went back out | No bank credit six days after approval, a card reversal, or a refund keyed in ASSD. |
| Explained by the matcher | The same money split differently, paid on one shift and keyed on another within a day, a line and its reversal, a cash movement keyed wrong and put back, or a bank credit with no terminal record. Shown so the explanation can be checked. |

The last shift in a journal is shown as far as the journal goes. Money taken
after the export ran is not reported as missing from ASSD.

## Laundry, shift by shift

Every shift's laundry in ASSD (article 540) is held against what the laundry
system took in the same hours (06:00–14:00, 14:00–22:00, 22:00–06:00). The
laundry system's payments and orders are read one by one on each nightly
refresh (table `laundry_txn`; order number, time and money only). A shift is
compared only once the laundry system has been read for the whole of it; a
difference is listed in the Inbox as "The laundry did not agree".

## Cash moved out with no label

A Cash Movement out of the front drawer that no count labelled as expenses or
the safe, on a shift with no closing report or expense sheet to settle it, is
listed in the Inbox. "It went to the safe" or "It was expenses" on the exception labels
it. A supervisor's label counts straight away too, since it fills in what no
count said; the daily summary lists it.

## Unpaid stays

Shifts → Inbox → **Unpaid stays** lists guests leaving in the next 24 hours who still
owe, and guests who have checked out owing (the last 60 days).

Each ASSD reservation is one transaction in the journal, with every night and
extra charged to it and every payment taken on it, each dated. Charged less
paid is what the guest owes. The nights are the room and bed articles
(numbers 100 to 289); check-out is the day after the last night, at the time
set under Settings → Limits (12:00 to start
with). Balances no bigger than the small-differences amount are left off.

Two limits come from the journal printing only the days it was exported for:

- A stay is judged only once its last night is before the last day loaded,
  so export the journal through tomorrow to see tomorrow's check-outs.
- A stay booked before the first day loaded may have been paid then. Those
  are listed apart, under "Check these in ASSD", and are not counted in the
  tab's badge. Loading the earlier journals settles them.

Journals loaded before this check existed carry no charges: load them again.
Answers go through the same approval as exceptions: a supervisor's answer
waits for an admin. Supervisors see the list and may answer by default
(Settings → Who sees what → Unpaid stays).

On a shift's page, differences still waiting for somebody are under **What
does not agree on this shift**. Those already answered, matched or explained
by the rules are listed apart, in green, under **Matched and explained**,
with Undo still there. A movement matched or labelled by hand shows as a
green ✓ note under "How it was paid" ("ASSD 216161 matched as a duplicate of
ASSD 216148"), and the expense it duplicated says so in its Details.

## What each note on a shift was made of

On a shift's page, each note under "How it was paid" opens to the lines
behind it, each marked ✓ (agrees), ✗ (does not) or · (nothing to match):

- **The drawer**: the opening count, every cash payment, every cash movement
  and how it was labelled, what the drawer should hold, and the closing count.
- **Card and MoMo**: each card line in ASSD and the terminal or MoMo payment it
  was matched to (time, card, approval code, amount), lines with nothing found,
  and payments that arrived but are not in ASSD. A line keyed and reversed in
  the same shift took no money: it is listed with a · and not counted. A line
  whose difference has been answered counts as accounted for ("7 of 8 found,
  1 answered").
- **Expenses**: each expense movement (and what the closing report settled)
  against the Odoo PO of the same amount, or several POs that add up to it;
  POs not approved in Odoo, and numbers Odoo does not know. Each PO says
  *on the form ✓* or *not on the form*, and the note itself says how many of
  the shift's POs are on the expense form ("2 of 3 on the expense form"). It
  is green only when the amount agrees with Odoo, every PO is approved, and
  every PO is on the form.
- **Laundry**: each laundry line in ASSD against the laundry system's payment
  of the same amount in the shift's hours.
