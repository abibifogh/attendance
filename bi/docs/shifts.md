# Shifts

The front desk's control sheet, done from the source records instead of typed
from them. It lives on the **Shifts** tab.

## The screen

Six tabs in a row: **Shifts, Inbox, People, Closing reports, Files, Settings**. The
Inbox tab shows how many things wait in it. The period sits beside the tabs:
the arrows step a day, a week (Monday to Sunday) or a month at a time, and
**Latest** jumps to the newest shifts loaded. When the journal stops inside a
shift, a small note at the end of the line says which; open it for what to do.

- **Shifts**: Day, Week, Month or Dates, chosen with the switch beside the tabs
  (it is in the Inbox too, and there it keeps you in the Inbox).
  - **Day**: the day's three shifts as large cards, each with the drawer in
    four lines, how it came out, how guests paid and what is open; the day's
    cash, card and MoMo against what arrived, commission and laundry.
  - **Week**: every shift in the week as a tile. Green agrees, amber needs a
    look, red needs an answer. Below it, card and MoMo recorded in ASSD
    against what arrived, day by day.
  - **Month**: a calendar, each day's three shifts as coloured bars; the month
    week by week below it.
  - **Dates**: From and To, for days that cross a week or a month, such as a
    surplus and the shortage it answers a few shifts later. Up to ten days
    show as tiles, longer as a calendar; ‹ › move by the same number of days.
    This is the date range for supervisors, who do not get the one at the top
    right: as many as 62 days for whoever may see Month, 7 for whoever may see
    only Week.
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
  cash POs and reads the laundry system there and then. Exceptions, unpaid
  stays and open money to-dos can be ticked, one by one or with **Select
  all** (everything of the chip shown): **Answer N ticked** gives them all
  one answer and note (a supervisor's wait for an admin, who is told once;
  a to-do takes the note as what happened, and an admin's closes it), and an
  admin can **Give** the ticked to-dos to a supervisor.
- **People**: each person's shifts, cash and cards, and net drawer variance;
  then what is still with staff under To sort out in HIVE, each person's month,
  and what was settled lately.
- **Closing reports**: every report from HIVE and the shift it is on; one on
  the wrong shift can be moved (see `docs/till.md`).
- **Files**: the three uploads. The safe book is under Money › **Safe**.
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

A drawer short or over that is reconciled (once an admin approves it) is
settled on its shift: the drawer box turns green and says so, the shift no
longer asks for a look on its account, and the difference leaves its person's
**To sort out** list in HIVE. Its size is still shown, because it is still
what ASSD counted.

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
  on the marker. Two markers in a row by the same person are one shift when
  nothing was closed between them (begun, interrupted, begun again); somebody
  who closed their shift (End cash deficit/surplus) and began again worked a
  double, two shifts.
- **Which slot.** Shifts run 06–14, 14–22 and 22–06, and a night belongs to the
  day it starts. ASSD has no clock, so each shift is placed by the terminal's
  clock for card payments that identify it, and by the marker's date. A night's
  marker is usually dated the next morning, and that is allowed for.
- **Two sessions, one shift.** Sometimes there are more hand-overs than
  shifts: somebody logs in for a minute in the middle of another person's
  shift, or a night changes hands. The journal alone is tried first, one
  session to a shift. When that cannot fit, the HIVE closing reports decide:
  the person who signed a shift (their ASSD login, under Settings → Whose
  ASSD login is whose, or by name) and the drawer they counted (the session
  that closed on that count). Sessions on the same shift are made one: its
  counts, sales and movements add up across them, it is named after whoever
  signed it, and its page says "N ASSD sessions: …" in order. The reports'
  answer is only taken for the sessions that move together with the place
  that does not fit; every other session stays where the journal alone puts
  it, so a report filed on the wrong shift never moves a journal that fits on
  its own.
- **A payment ASSD does not show** goes on the shift whose hours its time
  falls in. One taken just after a hand-over (an afternoon guest paying at
  22:25) belongs to the shift before: an admin presses **Wrong shift? Move
  it**, picks the shift before or after, and says why. Its person answers it
  from then on; the card says where it came from, and **Put it back** undoes
  it.
- **How it was paid.** Every payment line, by ASSD's own method: cash, card
  and MoMo (staff record MoMo as card), prepaid by bank transfer, prepaid by
  card online. Only cash goes into the drawer. Laundry paid in cash is part of
  the cash. Back-office entries on register 015 are never a shift's.
- **Counts.** ASSD's Money Count is a count of the drawer: the notes and
  coins, plus a "Total Expenses PAID" line for receipts of things bought out
  of the drawer. A shift's first count is its opening and its last is its
  closing.
- **The drawer is held to its notes and coins.** Receipts are not cash.
  Opening notes and coins, plus the cash taken, less the expenses and the
  cash moved out, is what the drawer should hold; the closing count's notes
  and coins are held against it. This gives the same short or over as ASSD's
  own balance (which counts receipts as if they were cash), except where
  receipts left the drawer with no movement (below).
- **Expenses are the receipts that appear.** A receipt that appears in a
  count is spent on that shift: it is that shift's expenses, and needs a PO.
  Receipts left in the drawer at hand-over are the earlier shift's, not
  asked for twice. Under the drawer, a panel says the receipts at hand-over,
  at the end, taken out, and what is new.
- **Cash moved out.** Every Cash Movement takes money from the front drawer
  (register 001) to the back office (015). ASSD records only the amount. The
  receipts in it, read from the count before it, are paper to the back
  office, not cash; the rest is notes to the safe when the count before it
  says so. Receipts taken out and counted before the movement is keyed are
  paired with it. A movement put straight back by an equal one the other way
  on the same shift is a correction, such as 17,630 keyed for 1,763. Cash in
  a movement no count explains is shown as not labelled.
- **POs from the expense form, for a backlog.** Inbox → POs → *Link POs from
  the expense form*: choose a month and press *Find matches*. Each shift
  whose expenses have no PO (or more than its POs cover) is held against the
  form's POs paid from the cash register and not yet tied to anything: dated
  that day (a night shift: that day or the next), or, with no date, sent
  during the shift or within six hours of its end. A set of POs adding up to
  exactly what is missing is clear when it is the only one, or the only one
  sent during the shift or by the person on it; failing that, a PO that is
  exactly one of the shift's receipts is clear on its own. A PO two shifts
  could each claim goes to neither. The clear ones come ticked; *Link the
  ticked POs* links them as if typed on each shift. The rest are listed
  under *Not sure* with the POs that could be theirs, to open and decide.
- **Whose receipts a movement carried.** Receipts are followed from shift to
  shift, oldest first. When a movement carries receipts earlier shifts left
  in the drawer, a bar and a table under it list each shift they came from
  (a link to it), the person, the count they first appeared in and how much,
  with this shift's part highlighted: only that part is this shift's
  spending and needs its PO. On the earlier shift, the receipts panel says
  which later shift took them out (or that they are still in the drawer),
  and its checks show it settled once all are out. Receipts missing from the
  next shift's first count are said too.
- **Receipts that went down, with some still there.** If a count shows fewer
  receipts than the count before, no cash movement took them, and some are
  still there (say GH₵70 down to GH₵50), it reads two ways: only GH₵20 were
  handed in and nothing new was spent, or all GH₵70 were handed in and the
  GH₵50 now counted is new spending. Insight never guesses quietly. It takes
  the reading the shift's closing report fits (its expenses match one of
  them), or else the one under which the drawer agrees. If neither settles
  it, the shift gets **Receipts handed in: all, or only some?**, with one
  button for each reading; until somebody answers, only what is sure is
  counted. Whichever reading is used, the card says which and why, and the
  other button changes it.
- **A movement that is exactly its POs.** When a cash movement's amount is
  exactly some of the shift's POs (what the closing report says each took
  from the drawer, or the POs linked here), it was cash paid for them, even
  if the counts lost receipts around it. Those receipts left with no
  movement: they show as taken out with no cash movement (with whose they
  were), and the drawer over by as much is reconciled as receipts swapped for
  cash. A PO equal to a movement with no receipts in it is that movement's.
  A movement labelled by hand as the safe or a split keeps its label.
- **Receipts still in the count after a movement.** A movement keyed
  after a count with receipts in it looks like it took them out. If the
  counts after it still show them (often the same count done twice), it
  reads two ways: they stayed in the drawer and the movement was cash, or
  they went and new receipts of the same amount came in. The drawer agrees
  either way; the expenses differ. They are counted once (stayed) unless a
  person says otherwise. When some of the shift's POs add up to exactly the
  movement, it was cash paid for them: settled as stayed. Otherwise the shift
  gets **Receipts still in the count after a movement: stayed, or new?**
  with one button for each, and Undo.
- **Receipts swapped for cash.** Receipts that leave the drawer with no
  movement, the notes going up by as much, were swapped for cash put into the
  drawer: that shift reads over by as much. The Drawer over card says so and
  **Reconcile** adds the cash back; it then sits under Matched and explained,
  with Undo. Where the counts cannot show it, the amount can be typed.
- **Receipts swapped for cash, in detail.** Once reconciled, the green line's
  Details show whose receipts they were (each earlier shift a link), the
  count they first appeared in, the hand-over, the count where they left with
  no cash movement, the cash put in for them, the drawer after reconciling,
  and who reconciled it, when and why (the note typed), with Undo.
- **Keyed twice, or not paid: what else saw it.** A card or MoMo line ASSD
  has twice (paid once), with no payment found, or declined on the terminal
  shows ASSD, the terminal and, for laundry, the laundry system side by side:
  how many lines, how many paid, how many tries the terminal declined in the
  shift's hours, and how many payments of that amount the laundry system took.
  The text says what that means: laundry paid once but keyed twice (reverse
  the second line in ASSD); paid twice in the laundry system (both real, one
  paid another way or owed); a failed try keyed as well; or the laundry
  system not read yet.
- **One payment seen twice.** Laundry paid by card on the hotel terminal and
  not keyed in ASSD shows as a card payment ASSD lacks and as laundry ASSD
  lacks. When the laundry system has a card payment of the same amount, on
  the same shift, within 30 minutes of one the terminal approved, and no other
  could be it, the two are one difference: **Laundry paid by card, not in
  ASSD**, with both sides. One answer settles both; *Not the same payment*
  splits them back (with Undo). What is left of the laundry's difference, if
  anything, stays on its own.
- **Look-alikes, suggested.** Laundry ASSD does not show, and on the same
  shift a drawer over or a card payment ASSD does not show, of the same
  amount: *These look like the same GH₵…*, with *Reconcile together* (one
  click) or *Not related* (not suggested again). On the shift and in the
  Inbox.

- **The closing report's expenses** settle only what nothing labelled: what
  the POs on the shift's closing report in HIVE paid, less what is already
  counted as expenses, is expenses, and the rest went to the safe. If they
  and the labelled movements disagree, the gap is shown on the shift rather
  than written over. (An expense sheet total typed here before this came in
  is still used for its shift.)
- **Correcting a movement.** Under "Where the cash went", Correct on any
  movement says what it really was:
  - what its cash part was: expenses paid straight out, cash to the safe, or
    a split of the two (receipts in it come from the counts and are not
    changed here);
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
| A guest paid less than ASSD shows | Critical. A card or MoMo line no payment matched, and a smaller payment on the same shift that ASSD does not show: money ASSD counts as taken never came. See below. |
| A guest paid more than ASSD shows | A card or MoMo line no payment matched, and a larger payment on the same shift that ASSD does not show. See below. |
| Keying slips | Transposed digits, one digit different, or out by a factor of ten against a payment in the same shift. A payment one digit larger or smaller than its line is read as the guest paying more or less instead. |
| Keyed twice in ASSD | The same amount twice in one shift, paid once. |
| Money received that ASSD does not show | Approved on the terminal or received by MoMo during the shift, and not in ASSD. |
| Did not reach the bank, or went back out | No bank credit six days after approval, a card reversal, or a refund keyed in ASSD. |
| Explained by the matcher | The same money split differently, paid on one shift and keyed on another within a day, a line and its reversal, a cash movement keyed wrong and put back, or a bank credit with no terminal record. Shown so the explanation can be checked. |

The last shift in a journal is shown as far as the journal goes. Money taken
after the export ran is not reported as missing from ASSD.

### A guest who paid more, or less, than ASSD shows

A bill keyed in ASSD as GH₵ 300 by card, and GH₵ 420 taken on the terminal,
is one card in the Inbox: **The guest paid more than ASSD shows · GH₵ 120**,
with both sides. It is put together only when all of these hold:

- the ASSD line found no payment, and the larger payment is one ASSD does not
  show, inside the same shift's hours;
- the payment arrived within 30 minutes of the payments matched to the lines
  keyed just before and just after it (ASSD has no clock, so this is how near
  in time it is; with none matched around it, the shift's own hours);
- it is the only such pair either way on the shift: two that could be it are
  never guessed between;
- it is not out by a factor of ten or swapped digits from any line still open,
  which stay keying slips, and the line is not one keyed twice (another of
  its amount was paid), which stays "Keyed twice".

A smaller payment, under the same rules, is **The guest paid less than ASSD
shows**: critical, because money ASSD counts as taken never came. A line with
both a larger and a smaller payment near it is neither.

ASSD calls card and MoMo both "credit card", so a line may pair with either.

Answers: **Refund due to the guest** (it goes on **Refunds owed to guests** in
the Inbox, whatever days are on screen, until somebody presses **Paid back**),
**Deposit for a later stay**, **Keyed short in ASSD**, or **Not the same
payment**, which puts the two back as the matcher sees them alone and notes it
on the line. Paying less is answered **Guest owes, chasing**, **Rest paid
another way**, **Keyed too high in ASSD**, or **Not the same payment**. Both
are answered by whoever has Bank statement and card matching. In "Probably the
same money", a guest who paid less is offered beside money of the same amount
that arrived later, the rest paid on another shift.

## Odoo activities

Insight reads Odoo's activities (to-dos, calls, approvals and the like) with
the same read-only Odoo user, and never creates, changes or completes one:
that is done in Odoo. It sees every activity that user may see, which with
purchases and accounting shared is those on purchase orders and bills; give
the user read access elsewhere in Odoo to see more.

- **Who is who.** Admin › Accounts has an **Odoo user** column. Pick each
  person's Odoo login once; one with the same email in Odoo is suggested and
  linked only on **Confirm**. One Odoo user goes with one account.
- **Inbox › Odoo** (admins): every activity overdue or due today: what it is
  on (with the supplier and amount for a PO or bill), whose it is, when it
  was due, its note, the shift a PO was paid from, and **Open in Odoo**.
- **Inbox › Mine in Odoo**: what Odoo has assigned to the person signed in,
  once they are linked. A supervisor sees only their own.
- **A shift's PO table** has a **Waiting on** column when a PO has an open
  activity: what, whose, how late. Shown to admins and to supervisors who see
  Odoo.
- **People › Odoo activities** (admins): each person's open activities by when
  due, and this month's done, and how many of those were done after their due
  date. "Done late" is known for an activity Insight saw open before it was
  done; one opened and done between two reads counts as done, not late.

Odoo is asked when the Inbox opens, at most every ten minutes, and on
**Refresh now**. If it does not answer, the last read is shown and the reason
is given.

## Laundry, shift by shift

Every shift's laundry in ASSD (article 540) is held against what the laundry
system took in the same hours (06:00–14:00, 14:00–22:00, 22:00–06:00). The
laundry system's payments and orders are read one by one on each nightly
refresh (table `laundry_txn`; order number, time and money only). A shift is
compared only once the laundry system has been read for the whole of it; a
difference is listed in the Inbox as "The laundry did not agree".

## Expenses and their POs

From the first closing report in HIVE on, two things about a shift's
expenses are flagged, under Inbox → POs and on the shift, which then cannot
read as all agreeing:

- **Expenses with no PO**: the drawer paid out expenses and there is no PO at
  all (none on its closing report, none linked in Insight).
- **PO total does not match the expenses**: the POs, as Odoo has them, add up
  to more or less than what left the drawer as expenses. POs typed but not
  read from Odoo yet are not judged.

Each card has the PO box: linking the right PO (or unlinking a wrong one)
takes it off, or answer why. An answer holds while the amounts stay the
same. Shifts before the first closing report are history and are not
flagged.

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
