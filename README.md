# HIVE

**Human Information & Verification Engine** — everything a hotel has to know
about the people who work in it, and everything it has to be able to prove.

It began as an attendance app. The terminal at the staff entrance knows one
thing and knows it very well: that a face was recognised at 07:03. Everything a
manager actually wants is downstream of that — was 07:03 late, is a missing
evening tap an absence or a forgotten one, how many days has this person worked
this month, and how much leave is left.

It does considerably more than that now:

| | |
|---|---|
| **Attendance** | Punches from the terminal, turned into days, hours, lateness and absence |
| **Rota** | Standing patterns, rotations, and a week imported from a CSV or a printed schedule |
| **Leave** | Requests, approvals, entitlement and balances |
| **Sign-off** | Settling periods a day at a time, and asking somebody when you are not sure |
| **People** | Personnel records, documents, contracts signed on a phone, and what a file must contain |
| **Letters** | The correspondence register, signatures asked for and given, and a hash-linked record of both |

Runs entirely on Cloudflare: a Worker serves both the app and the API, with a D1
(SQLite) database behind it. Served at **staff.niceoperation.com**.

> The repository, the Worker and the address are all still called *attendance*
> or *staff*. That is deliberate. Renaming them buys nothing anybody can see and
> costs a re-attached custom domain, a rebound database and a broken deploy —
> and every signing link already sent out points at the address as it is.

---

## The guide is in the app

**Guide**, last in the menu, open to anybody signed in. It is the handbook, and
it shows the reader their own job.

One document, filtered — not six, one per role. A property of twenty-four people
has managers who cover a supervisor's morning and administrators who build the
rota when the planner is away; six separate guides means five of them go stale
and the one somebody reads is whichever they were handed on their first day.
Here every section names the permission it belongs to, and a supervisor opens
eight sections where an administrator opens eighteen.

What is left out is still **named** at the bottom, with a one-line summary and
the permission it needs. Hiding a feature is useful; hiding the fact that it
exists is not — somebody who does not know the sign-off screen exists cannot ask
to be given it, and goes on doing by hand the thing it was built for.

Content lives in `public/js/guide-content.js` as data: paragraphs, steps, lists,
tables, notes and warnings, and nothing else. `test/guide.test.js` holds it to
its own rules — every section names a real permission, every role opens on
something it can use, every block is a kind the screen can actually draw, and
every permission somebody can be granted is described somewhere. A handbook is
the one part of a system nobody notices going wrong.

## Guides

| | |
|---|---|
| **[The HIVE Handbook](https://claude.ai/code/artifact/a92878aa-a0d3-4b70-b23e-9662efb1615f)** | Every screen, every button, and why each behaves the way it does |
| **[Role guides](https://claude.ai/code/artifact/8a873fa9-cd26-4efc-b1e5-8b78d2c6956f)** | Six short ones — planner, supervisor, manager, wages, administrator, and the staff member with no login. Pick yours and ignore the rest |

---

## The one idea worth knowing

**A punch is a fact. A day is an opinion.**

Punches from the terminal are the record and are never edited. Late, early,
absent, hours worked, days worked and leave taken are all *derived* from them,
against the rota, the leave book and the rules in setup — so all of it can be
worked out again at any time.

That is why correcting a rota in September fixes June's report rather than
leaving two versions of the truth, and why changing a grace period does not
require anybody to go back and re-enter a month.

---

## What it does

### Today — the morning screen

The only screen most people open, and they open it every morning. What needs a
decision first, then absences, then lateness, then everybody who simply turned
up and did their job.

**A shift that has not started is not an absence.** The night porter due at
22:00 shows as *Not due yet* all day, in grey, and somebody halfway through a
shift shows as *On shift since 06:02* rather than sitting in "waiting on a
decision" all afternoon. Both only ever apply to today — every earlier day is
judged exactly as it always was — and grace is counted in, so nobody due at
06:00 with five minutes' grace is called late at 06:03.

Without this the morning screen is a page of red about people who are not due
for another twelve hours, and the one real absence on it goes unread. The same
clock reaches the stored day, so the absence notice and the run-of-three alarm
behind it do not go out about somebody whose shift is still ahead of them.

**A missing punch is held, not counted absent.** The terminal marks a day absent
when either tap is missing, because it has no way to ask anybody. This does: the
day waits for a supervisor to confirm what time the person left, and the
confirmation is recorded with their name on it. Crediting nothing for a shift
somebody actually worked is the more expensive mistake.

The terminal's own behaviour is still available as a setting, as is crediting
the scheduled shift automatically and flagging it.


**Download the ones to deal with** takes the day's absences, lateness and
unfinished days as a spreadsheet — names, departments, shifts, clock times, what
each one needs, and who settled it if anybody has — sorted with the ones waiting
on a decision first, because most people never sort it themselves. **Last 7 days**
does the same across the week. Reachable with the permission that opens the
screen rather than the reports one: everything in the file is already on the
page, so gating it behind the payroll export would only mean whoever does the
chasing has to ask somebody else for a copy of what they are looking at.

### Reports

| Screen | What it answers |
|---|---|
| **Person, any period** | The slip that gets handed over. A plain-English line at the top saying what happened and what to do differently, the clock times under it as evidence, and the leave balance beside it. Prints as a PDF. |
| **Week** | Names down the side, Monday to Sunday across. Finds the pattern a daily list hides — the person late three Mondays running, the section short every weekend. |
| **Month** | Days worked, hours, overtime, absences, leave taken and leave left, per person. The sheet that goes to whoever does the wages. Exports as CSV. |

Overtime is not shown anywhere on this report. It is measured from the shift end
with no threshold behind it, so every evening somebody stays ten minutes past
reads as overtime — a number that means nothing here and gets asked about. On a
single day the absences tile goes too: the status and the note above already say
what happened, and "Absences: 1" underneath is the same fact a third time.

Every row on a person's report carries **Correct** — or **Settle** where the day
is still waiting — so a discrepancy is fixed where it is noticed. Somebody going
through a month before payroll finds a Tuesday marked absent that was not, and
changes it there, rather than remembering the date, going to Today, paging back
and finding them in a list of everybody. Absent becomes present, the shift is
confirmed, the clock times are supplied where the terminal saw none. It is
recorded against the person making the decision, the punches are never altered,
and **Undo** puts the day back to whatever the rules make of it.

Whatever period is on screen can be signed off — a day, a week, a month, or any
range picked by hand. The day table carries the button in its header, beside the
column of Correct buttons. The two belong together: somebody goes through a
period putting days right, and then has to say what it came to. Sending them to
another screen to find the same person in a list of twenty-four is how the
second half stops happening. The header shows where the period stands before it
is pressed — square, so many over, or already signed — and **Reopen** undoes it.

Days already inside a signed period are marked **✓ signed** in the day-by-day
table, with who signed it and what was charged on hover. Sign-off is per period
rather than per day, so without that a settled month looks exactly like one
nobody has touched and the same fortnight gets gone through twice. Correcting
such a day is still allowed — errors surface after payroll too — but the dialog
says plainly that the correction will not move what was already charged, and
that the period has to be reopened and signed again for that.

**No two signed spans for one person may share a day.** Sign off a week at a day
short and then the month at three days short, and four days would come off for
three days of absence — nothing in the arithmetic would notice, and by the time
the person did there would be no way to tell which charge was the mistake. So
the overlapping span is named, by date, and the sign-off refused; reopen it and
the wider one is free.

It is the same form the leave screen uses, shared rather than copied: it moves
somebody's leave, and two versions of it would drift.

**The leave box is left off the printout**, and so is the *Leave left* tile at
the top of the page — one tick box governs both, or the figure would go out on
paper while the box explaining it stayed behind. A slip handed to one person is
read by whoever is standing next to them, and how much leave they have left is
nobody else's business. Where a signed-off month has added or taken days,
that shows as its own tile — *Days charged* or *Days given back* — with a line
saying which months it came from. A balance that quietly differs from the
entitlement is the kind of thing people notice on payday.

### Sign-off — settling up as you go

**Sign-off** is the screen whoever builds the rota opens on a Monday. Pick a
window — yesterday, last week, a fortnight, a month, or two dates by hand —
and it lists everybody with days in it that nothing has signed off, worst
first.

**Signing is per day.** A fortnight with three days nobody can explain used to
be all-or-nothing: sign the lot, or leave eleven settled days waiting on three.
So the three held up everything and nothing got signed. Now every day carries a
tick; tick the ones you have looked at, and the rest stay on the list to be
dealt with on their own.

**Nothing starts ticked**, and that is deliberate. Signing a period off moves
days against somebody's leave, so a screen that arrived with everything selected
would ask for one press to do it — including for the days nobody had read yet.
The tick is the reading, and it has to be given rather than taken away. The tick
in the heading still takes the whole list in one press, so the ordinary week
where everything is fine costs two presses instead of one: the cheap case gets
one extra press and the expensive case stops happening by accident. The button
names what it would sign, and is disabled until something is chosen.

**A day left out is not a day signed.** The record stores the span plus the days
it deliberately excluded, and every screen that says "signed" subtracts them —
the outstanding list, and the ✓ on the person's own report. Reading the dates
alone would mark the three days nobody could explain as settled along with the
eleven that were, which is the opposite of what leaving them out meant and hides
them from the person going back to deal with them.

**The charge offered is for the days ticked**, not for the window they sit in.
Ticking three days of a fortnight and being handed the fortnight's over/under is
how eleven days of somebody's leave move by accident, because almost nobody
edits a number the screen looks confident about.

**A flag says what it means on hovering it.** The counts on a question read
`3 under`, `1 over`, and four of them fit on one line because of it, but nobody
new to the screen can tell what "under" is. Hovering one gives the word and the
sentence behind it — *Whole shift missed: counts against them when the period is
signed* — from the same list the day rows are flagged against, so the two can
never drift apart.

**The list is three lists**: what has been answered and is back with you, what
there is to do, and — collapsed at the bottom — what is waiting on somebody
else. The grouping is **by day, not by person**: asking about a Thursday nobody
can explain does not put that person's other four days beyond reach, and parking
somebody's whole week because one day of it carries a question is the surest way
to stop anybody ever asking.

**Clearing the easy ones** is one press, and it shows you the list first —
every person, every day, each tickable, so anything you would rather look at
yourself comes back out before anything is signed. A button that signs
ninety-six days has to be able to say which ninety-six. The filter has three settings —
everybody, only those with something wrong, only those with nothing wrong — and
above the list sits a count of every day with nothing wrong with it and a button
that signs all of them. It works per day, not per person, so somebody with one
unexplained Thursday still has their other four days cleared and the Thursday
stays on the list alone. Nothing flagged goes through it, nothing with a
clock-time change waiting goes through it, and nothing is charged against
anybody's leave — a clean day is by definition neither an extra day nor a missed
one. It runs one ordinary sign-off per person rather than through a bulk
endpoint, so each keeps its own record, its own audit line and its own overlap
check.

**Undoing one** is *Reopen*, in the "already signed" list under each person on
the sign-off screen — and on their own record, and on the Leave screen. The days
go back on the list and whatever was charged stops counting; nothing decided
about the days themselves is undone.

> **The rule about overlaps had to change for that to work.** It was *no two
> signed spans may share a day*, checked on the raw dates. It is now *no two
> signed spans may share a day either of them actually signed* — otherwise the
> three days a month deliberately left out could never be settled by anybody,
> because the month itself would refuse them. The comparison moved out of SQL
> and into code for exactly this reason.

**Today is never on the list.** A shift that has not finished cannot be signed
off, and charging an absence against somebody who is upstairs making a bed is
the mistake that rule exists to prevent.

**Two more days that cannot be ticked**, and both for the same reason — the
figures are not settled yet:

- **A day somebody has asked a question about.** Asking is somebody saying out
  loud that they do not understand a day. Signing it while the answer is still
  coming settles it against the very figures that were doubted and quietly
  makes the question pointless. The day comes back when the question is
  answered, or when whoever raised it withdraws it.
- **A day with a clock-time change waiting on an administrator.** Somebody has
  already said the times on that day are wrong, and approving the change moves
  them. Signing first means signing a figure the app itself expects to change.

Both are refused by the API and not merely greyed out on the screen — the menu
is a courtesy, the API is the gate. The one exemption is an administrator
signing a period *as* the answer to the question about it, which is not slipping
past the rule but the rule being satisfied.

The digest carries three lists: **waiting on you** (days nobody has settled,
each with what the rules made of it), **absent**, and **late** — the latecomers
worst first, each with how many minutes they owe. The minutes are counted from
the shift's start rather than from the end of grace: somebody twenty minutes
late owes twenty minutes, not fifteen. Whether somebody *counts* as late is
still the rules' own verdict, so a minute inside grace is not on the list; a
digest naming half the property every morning is one nobody reads by Friday.

What makes the digest send at all is unchanged — a day nobody can settle, or an
absence. Lateness rides along with it rather than triggering it.

### The rota: draft, published, past

Saving and telling people were the same event, which meant a planner could not
think out loud. Now a saved cell is a **draft** — dashed border — and *Publish*
turns the window solid, logs who published what and when, and tells each member
of staff the rota just changed something for. Changing a published day makes it a draft again
(somebody is planning around the old version, and a cell cannot change under
them while claiming to be the version they saw), and the app immediately offers
to republish — asking each time whether to notify or go quietly, because a
quiet that becomes a default is how staff end up planning around a rota nobody
told them changed. Past days are greyed.

**Everybody it affects is told, one at a time, on their phone.** A rota going
out used to be one announcement to the whole house: the rota for these two weeks
has been published. Everybody then had to open the app and go looking to find
out whether it meant them, and for most of them it did not, which is how a
notice becomes a notice people stop reading. Each person now gets their own: how
many shifts they have, when the first one is, and whether any of it is a change
to something they had already been told, with whatever the planner wrote at the
bottom. It pushes to their phone, because a published rota is the one thing
staff genuinely need to be interrupted for. Somebody with nothing in that window
hears nothing at all.

*Tell everybody* adds the house announcement on top, and that one does not push:
the people it is actually about have already had a buzz, and two for one rota is
how somebody comes to turn them off. Anybody on the rota with no login cannot be
reached, so the planner is told how many that was rather than left assuming the
whole kitchen knows.

Two views of the same window: **People** (rows are people — where assignment
happens) and **Positions** (rows are shifts, cells are who is on them — "who is
opening on Saturday" read directly). One, two or four weeks; a calendar picker
that snaps to Mondays; department and tag filters; a conflicts chip that counts
who the plan is overworking and opens Workload.

**The people grid reads as a grid.** Lines down the columns as well as across
the rows, so a shift is a box on a day rather than text floating in a band, and
every cell is the same size as a card on the positions view — an empty Tuesday
and a Tuesday with a shift on it are the same Tuesday. Beside each name is a
face: the passport photograph where one is on file, and otherwise the person's
initials on a colour taken from their name, stable so the same person is the
same colour every week. Under the name is what this window already has them
down for, which is the number being weighed every time a cell is filled and
which used to live on the Workload screen, nowhere near the decision. The photo
endpoint returns the picture and nothing else — no name, no record, no other
kind of document — and only to somebody who can already see that person on a
rota.

**A shift opens from either view.** The dropdown answers *what is this person
on*, which is one of the two questions somebody has in front of a cell.
Clicking anywhere else on the card answers the other — *who is on this shift,
and should it be somebody else* — with the same dialog the positions view
opens. Reassigning from there moves the shift and marks both cells, the one it
left and the one it went to, as unsaved.

**Reading the rota without being able to touch it.** A head of department, an
owner, whoever answers the phone on a Saturday: there are people who need to
know who is on and have no business moving anybody. *See the rota* is that, and
only that. It opens the same grid the planner builds on — both views, any span,
the department filter, and *Save as PDF* to pin it up — with nothing on it that
can be pressed. No dropdowns, no dragging, no publish, no copying a week, no
importing, no standing patterns; the Pattern column is not even drawn.

What it withholds is what a planner reads while deciding rather than the rota
itself: availability and the reason somebody gave for it, the Sunday counts, the
special-meal mark, the count of days waiting to be published and of requests
waiting to be answered. That is stripped in the answer, not on the screen — the
endpoint sends a reader the days, the shifts and the names and stops — because a
permission that only hides is a curtain. Dashed and solid still mean draft and
published, since "this may change" is exactly what a reader needs to know.

It is granted under *Users & data*, either as the *Rota, read only* role or by
ticking *See the rota*, and like *My shifts* it is a leaf: unlike every other
attendance permission it does not drag the Today screen along behind it.
Building the rota carries reading it, so a planner needs only the one they had.

**A shift is dragged from one box to another.** Half of building a week is
"that one, but on Wednesday" or "give Ama's Saturday to Kofi", and both used to
mean two dropdowns: find the cell, set it to Off, find the other cell, pick the
shift out of a list of thirty. Picking it up and putting it down says the same
thing in one gesture, in both views — across days on one person's row, down onto
somebody else's, or from one position to another.

**The drop asks.** The gesture is genuinely ambiguous: it means *this shift lives
here now* and *another one of these, here as well*, and a tool that guesses is a
tool that quietly loses a shift somebody meant to keep. So the answer is asked
for at the point of the drop, in two words — Move it, Copy it — with what is
about to happen said back first: what the shift is, whose day it is landing on,
and what it is going to sit beside. Escape and Cancel leave everything where it was, and
answering the question writes it: Move it and Copy it save the change there
and then, because somebody who has answered has decided, and a decision lost
to a tab closing is the worst thing this screen can do to anybody. It is a mouse gesture
and nobody's only way of doing this: every cell still opens its dropdown and
every card its dialog, which is what a phone uses, because dragging across a
fourteen-column grid with a thumb is not a thing anybody wants to do.

**Saying yes to a question saves it.** Answering a drop with Move it or Copy
it, and pressing Apply on a shift card, write the change immediately rather
than holding it for a press further up the page. Saved is not published: the
count on the Publish button goes up and one press at the end sends the week, so
nothing reaches anybody's phone until it is meant to. Everything else still
waits for Save, because filling a fortnight one dropdown at a time is a hundred
round trips, and a bar at the bottom says how many changes are waiting.

**A day that already has a shift keeps it.** Dropping a second shift on it puts
the two side by side and marks the day as a double, rather than quietly taking
the first one off. The gesture says *this one as well, here*; it says nothing
about removing anything, and a whole shift disappearing from the week for it is
not something anybody would ask for. Taking a shift off is its own action, on
the card itself. Dropping a shift somebody already has that day changes nothing:
that is the same promise written down twice.

**A period can be taken back off.** Starting a fortnight again, undoing an
import that came in wrong, emptying a month somebody built against the wrong
week: all of them meant opening every cell and setting it to Off, and ninety
clicks is not a way of doing something, it is a reason to build the rota
somewhere else. *Clear a period* takes a stretch of dates in one go, and asks
what "empty" means — because on a rota with standing patterns behind it there
are two answers and they look nothing alike. Clearing back to the pattern takes
the decisions off and lets the usual week show through, which is what undoing
means. Clearing to nothing writes a day off on every day, which is what an empty
period means; it skips a day that is already empty, so it never writes three
hundred rows to say nothing happened.

A shift standing on a day with nobody on it stays. That is the shape of the
week rather than an assignment — the record of what the day still needs — and
clearing the people off must not take it with them, or the week comes back
apparently no longer needing anybody. There is a tick box for taking those off
as well. Published days are likewise left alone unless it is asked for, because
people have planned their lives around those. Approved leave is never touched.
A department or tag filter narrows it to whoever was on screen, and every day
cleared leaves its own entry in *What changed*.

**Who works it** is a list rather than a dropdown. It had grown into a wall of
sentences: a name, then every department and named shift that person is set up
for, then whatever they were already on — twenty-four of those with the one
thing anybody is looking for buried at the front of each line. The detail moves
off the line and under it. A name reads as a name; what stands in the way reads
as one short phrase beneath, in the colour that says whether it matters. The
groups carry counts, so *eight people are already on something* is answered by
looking. Hours for the window sit beside the reason in plain grey, because they
are a fact about the week rather than a verdict on it. There is a search box,
because twenty-four names is past the point where scanning beats typing. Nobody
is hidden — somebody out of department or already on a shift is still offered,
with the reason, because a planner covering a gap with whoever is standing there
is a real Saturday.

**Shifts that run together, and shifts that stand in for a pair.** A shift
could already say who it runs *instead of* — five breakfasts that differ by half
an hour are one morning written five ways, so once a day settles on one the rest
are not wanted. What it could not say is the other half of how a service gets
split: Bistro shift 1 and Bistro shift 2 are one service cut in two, so either
both of them run or neither does, and the single Bistro is what runs instead of
the pair. Putting all three in one alternates group would have said exactly the
wrong thing — it would have made the two halves rule each other out. So a shift
now says who it runs *with* as well, and alternates deliberately ignores anybody
in the same pair.

The pair is settled before the shift that replaces it, because otherwise which
arrangement a day gets is decided by nothing more than the order the shifts came
out of the database. The split is the arrangement and the single is the
stand-in, which is how the property actually runs it. Where one half cannot be
staffed the draft says so and names the shift it goes with, so *Bistro shift 2
is short* reads as *the split Bistro is short*, which is the question a planner
has to answer.

**The special meal** is on the last Friday of every month, and that column is
marked so a planner knows which day they are looking at. On it, anybody who was
off *last* month's is marked too — so they go on this one, rather than the same
people eating together every month. The mark stays after they have been
rostered: it is a fact about last month rather than a gap, and on a cell with a
shift in it, it is the reason they are on it. A standing pattern counts as
having been there, leave and a rostered day off both count as having missed it,
and somebody who was not hired yet has missed nothing.

**Availability** is the fact a planner needs before the dropdown: days somebody
cannot work (or asked to work), with the reason, shown in the cell. Not leave —
nothing approved, nothing spent — and rostering over it stays possible, with
the mark staying put. Some conflicts are deliberate, and a grid that hides them
is lying.

**Availability a member of staff asks for waits for approval.** What somebody
sends from their own screen is a request, not a fact about the week, and a day
that takes itself off the rota the moment it is typed hands the shape of the
week to whoever types fastest. It arrives as *asked for*, the bell rings for
whoever plans the rota, and the rota screen carries a count of what is waiting.
Approving it makes it the mark a planner sees in the cell and tells the person
it was approved; turning it down tells them that, with whatever reason was
given. A planner writing availability on somebody's behalf is already the
decision, so it goes straight in.

**Staff can put a picture to their name.** A grid of thirty names is read by
face long before it is read by name, and everybody who has used Humanity looks
for the face first. It is uploaded from *My picture* on the staff screen,
shrunk in the browser before it is sent so a phone photo does not arrive as
four megabytes, and it shows in the circle beside the name on the people grid.
Anybody without one keeps their initials, centred in the circle.

**A shift that runs into the night carries a moon.** `☾` sits beside the time
on any shift that ends at or before it starts, or ends at midnight. Reading
`22:00 to 06:00` and working out that it crosses the night is a thing the eye
should not have to do twice a row.

**The rota exports, drafts and all.** *Export* writes the period on screen out
as a CSV, one line per shift, with the date, the weekday, the employee number,
the name, the department, the shift and its hours, and the state of the row:
published, draft, off, pattern or leave. Waiting for Publish before anything
can leave the screen is what sends a planner back to a spreadsheet, so a draft
exports with the word *draft* on it rather than not at all.

**Sundays** are marked where somebody is over them. A rota read a week at a
time hid this completely: one Sunday on screen says nothing about the other
three. So the count is taken over the whole calendar month a Sunday belongs to,
however little of that month is open, and the cell says how many of them that
person is on — `⊙ 3/5 Sundays`.

**It is said on the empty Sundays too.** A mark that waits until somebody is
already on the shift arrives after the decision it exists to inform. On a cell
with nobody on it, it reads as *this person has already done three of this
month's Sundays* — which is the thing worth knowing while the cell is still
empty. Nothing here waits for Publish either: a rota is decided when it is
saved. The same is true of the special-meal mark below.

**It counts what actually happened, not only what the rota says.** A Sunday
already gone is not a plan any more. Reading the count off the rota alone meant
every Sunday somebody worked before the rota was kept here, or whose rows a
Clear took off afterwards, came back as a Sunday they had off, and the count
said one of four on a month somebody spent at work. Anybody who turned up and
clocked in was working that day, whatever is left on the rota for it. Days
still ahead are read from the rota and the standing pattern, as before.

**It trips on Sundays worked, not on Sundays lost.** Asking whether anybody has
been left without one at all only fires once every Sunday is gone, which is a
month too late to move them. Two in a month is where this property draws the
line, and it is *Sundays worked in a month* under Setup → Workload, so it can
be drawn somewhere else or switched off. Standing patterns count, because
somebody who works every Sunday by pattern and has no roster rows at all is the
plainest case and the one a count over the roster table alone would miss. Leave
is a Sunday off.

**Today is a column, not a shade.** A fortnight is fourteen columns that look
alike, and the first thing anybody does on this screen is find the day they are
standing in. Today's column carries a rail down both sides, a coloured header
and the word itself, on both the people and the positions view.

**The gap for a second shift sits under the card, not inside it.** A second
shift is another card on the day. A button drawn inside the box said the
opposite: that whatever it made belonged to the shift above it.

**Every card on the positions grid is the same height.** A card whose height
depended on the length of somebody's name made a row that stepped up and down
across the week, and the eye reads that as meaning something — it does not.
"Francisca Etornam Gave" is three lines and "Chichi" is one, and the shift is
the same shift. Each line now has a fixed allowance and anything longer is cut
with an ellipsis, with the whole of it on the card's tooltip and in the dialog
behind it. The allowance steps with the span like the type does: two lines each
for the shift and the person where there is room, one each at four weeks, where
a card is a colour block with a name on it.

The one thing still allowed to change a card's height is the optional name
somebody has given that shift, because that is a line the card would not
otherwise have and its absence is the ordinary case. Measured across a week of
real data: seven different card heights before, one after, plus the taller one
carrying a name.

The type steps with the span. A fortnight gives a day half the room a week
does and four weeks a third of that again, so one size for "narrow" was always
going to crush something: the position cards were being handed the fortnight's
type at four weeks and printing one person's name over the next day's. Cards
wrap inside their own box at every width now, and the size steps down as the
columns do.

Where the grid scrolls inside its own box, it keeps its place. Saving a change
and being returned to the top is twenty names to scroll past again, and it was
the row further down that somebody was working on.

Both grids fit one screen. A week keeps its hours line and its larger text; a
fortnight or four weeks drops to fixed columns and gives up what the eye can do
without. Neither runs off the side of a laptop, and the day row stays pinned to
the top of the grid while it scrolls. On a handset the columns go back to their
own widths and the page scrolls sideways, because seven columns squeezed into a
phone is seven columns nobody can read.

**Tags** — keyholder, trainee, speaks French — are free-form on the person and
filterable on the rota, because a fixed vocabulary would be somebody's guess at
what matters on this property.

### Workload — whether the rota is survivable

The rota screen answers *is anybody on Security on Sunday*. It never answered
*has Kofi had a day off this fortnight*, and that is the question that ends
with somebody handing in their notice.

**Workload** reads the plan rather than the record, because the point is to see
it while it can still be changed, and it reads the fortnight a rota is actually
built in. Two lists, kept apart because they are two different problems and
averaging them hides both: who is being worked hardest, and who is being left
out.

**The floor is the law.** Ghana's Labour Act 2003 (Act 651) sets eight hours a
day and forty a week (s.33, nine on a day where another is shorter, s.34),
twelve consecutive hours between working days (s.35), and forty-eight
consecutive hours in every seven (s.36). Every finding cites its section, and a
property can tighten any of them. On top of that sit this trade's rules of
thumb — days in a row, nights, how often somebody is flipped between nights and
days — which are marked as the property's own rather than the law's.

**Nothing is ever blocked.** A hotel has nights when somebody simply has to
cover, and an app that refuses to record what happened gets worked around on
paper, at which point it knows nothing at all. It says so loudly, names the
rule, and leaves the decision with whoever's name is on it.

**Rest is not automatically a kindness**, so the second list is as long as the
first: somebody rostered under what the month expected is being paid for days
nobody scheduled; somebody who never gets a weekend while their department gets
every other one is being carried by them; and leave nobody takes is a bill
quietly running up. All three read as "resting" on a screen that only counts
overwork.

A mark against the name on the rota grid itself carries the same findings, so
the moment a plan gives somebody eleven days straight is the moment it is still
a plan.

> **One thing worth knowing about the arithmetic.** The weekly-rest figure
> measures gaps between actual shifts and then asks which seven-day stretches
> they touch. Measuring *inside* a rolling window instead clips an ordinary
> Friday-to-Monday weekend at the boundary — calling 64 hours 34 — and reports
> a property in breach every week of its life. A warning that cries wolf on a
> normal rota is the one people switch off.

### Every screen is live

These screens are read as boards. Somebody leaves Today open on the office
computer, a supervisor has Rota on a phone, a member of staff has My shifts on
theirs — and a stale screen and a fresh one are indistinguishable, which is the
whole problem.

This used to be a timer: every screen brought itself up to date once a minute,
whether or not anything had happened. Wrong on both sides. A rota two people
were building at the same time was a minute behind all day, and a phone left on
a counter with nothing going on made fourteen hundred requests a day to be told
so. **The timer is gone.** Every signed-in browser holds one socket open to the
server, and the server says when something changed. The other screens answer it
within the second, and sit completely still the rest of the time — no requests
at all while nothing is happening.

**What travels is the fact that something changed, and nothing else.** A message
is a topic name and a timestamp: no rows, no names, no numbers. The screen that
hears it re-asks the API through the same permission-checked endpoints it always
used, so the channel can never become a second way of reading the database
however far the app grows around it. The topic still decides who is told, because
*the payroll moved* is worth keeping off a supervisor's phone even with nothing
attached to it — and the list is written in terms of who may **hear**, not who
may change: a member of staff can do nothing at all to a rota and is the person
most waiting to hear that one has been published.

Three things keep it from being an interruption on a screen somebody is working
in. It never refreshes while somebody is in the middle of something — a dialog
open, a cursor in a box, a rota holding staged edits — and comes back to it when
the screen is free rather than taking the work with it. It does nothing while
the tab is hidden, and puts up what arrived the moment somebody looks again. And
it is silent: the new view is built before anything on screen is touched and
swapped in when it is ready, so the page never empties and keeps its scroll
position — somebody reading the bottom of a list stays at the bottom of it. That
last part was written down here long before it was true. What the code actually
did was rebuild the whole shell and drop a loading skeleton in place of the
screen while the request was out, so every update anybody made anywhere blanked
everybody else's page for as long as the fetch took, which on a phone is a
second or two. The skeleton belongs to a first paint and a change of screen,
where there is nothing on the page yet to keep. The tab that
made the change is left out of its own announcement, because it has already
redrawn itself off the answer to its own save — the same person's *other*
screens are told, on purpose, since a rota open on the office computer and on a
phone are two screens.

The connection is a Durable Object, which is the one thing in this runtime two
requests can both be looking at. Sockets hibernate rather than sit in memory, so
two dozen phones connected overnight cost nothing while nothing is happening. If
the socket cannot be opened at all the app falls back to asking every couple of
minutes, and stops the moment the socket is back: a deployment without the
binding is slower, not broken.

### On a phone

**It installs.** A web app manifest, real PNG icons at 192 and 512 including a
maskable one, and a service worker registered on every load rather than only
when somebody turns alerts on — Chrome will not offer to install anything
without one, and it wants a `fetch` handler on it besides. *My account → Put
HIVE on this device* holds the browser's own install prompt and offers it where
somebody went looking for it, rather than as a bar across the top that everyone
has learned to dismiss. iPhone has no such prompt at all, so there it prints
the steps instead: Share → Add to Home Screen, which is the half nobody
guesses.

**And some phones can never have alerts, so they are told so.** Apple added
notifications for a web app on the Home Screen in iOS 16.4, in March 2023. Every
iPhone before the XS — a 7, a 7 Plus, an 8 — stops at iOS 15 and can never have
them, and a good few of those are in pockets here. What the screen used to say
on one was "add HIVE to the Home Screen and open it from there", so somebody did
that, came back, found no switch, and concluded the app was broken. It now says
the phone cannot show them, that nothing on the screen will change it, and that
the bell at the top of HIVE has everything the alerts would have said. Installing
is still offered, because opening fast and working without a signal are worth
having on their own.

The version is read out of the user agent, which is where the only honest answer
lives — there is nothing to feature-detect, because the thing to detect is
missing — and out of either half of it: a browser tab carries `OS 15_8`, while
the same phone with HIVE on the Home Screen drops that and carries Safari's own
`Version/15.6`.

**What the worker caches, and what it must never cache.** The shell — the page,
the stylesheet, the scripts — network first, so a deploy is picked up the
moment there is a signal to pick it up with and the cache is only ever the
fallback. Nothing under `/api/` is cached at any time. A cached list of who to
chase is yesterday's list, and somebody acting on yesterday's list is worse off
than somebody who knows they are offline.

**Which is why there is a bar.** The app now opens from a home screen whether
or not anything can be reached, and a screen that opens is a screen somebody
believes: *nobody absent, all settled* is a reasonable-looking morning and a
dangerous thing to show when the truth is that nothing could be fetched. So a
failed request raises a line under the header saying so, and a successful one
clears it. Not `navigator.onLine`, which only reports whether the device has a
network interface — it stays true on a phone with two bars and no data, and
true when the site itself is down. Whether the server answers is the question,
and only a request answers it.

**And it fits the screen.** Figures go two across instead of one per row, which
was costing a screen and a half of scrolling before the first line of the day.
A card's heading, its note and its buttons each get their own line rather than
fighting over one. Every form field is 16px on a phone, because anything
smaller makes iOS zoom the page in on focus and never zoom back out. Tap
targets grow wherever the pointer is coarse — a mis-tapped checkbox on the
sign-off screen signs off the wrong day. And the notch and the home bar are
accounted for, since `viewport-fit=cover` is what lets the page paint under
both.

**The rota on a phone: the people view stops being a table.** Fourteen columns
will not fit on a handset and no amount of squeezing will make them. What was
happening instead was worse than either: the whole page went as wide as the
grid, so panning across to Thursday took the top bar, the buttons and the
person's own name off the screen with it.

Each person is a block now. Their name, department and hours on a line of their
own, and the days underneath in a row seven cells wide — a week on one screen, a
fortnight as two rows of seven. It is the shape every rota app on a phone has
settled on, for the reason they all found: a name is read once per person and a
day is read seven times, so the name is the thing that should give up its
column. The row of dates is pinned under the app's own bar and stays there while
the list goes past it, because a column of times twenty names down says nothing
if you cannot see which day it is under. What is pinned is the `thead` rather
than the row inside it: a sticky element can only move within its own parent,
and a `thead` is exactly as tall as the one row in it, so the row had nowhere to
go and scrolled away with everything else.

A cell is the two ends of the shift, one over the other, on the shift's own
colour, with the moon for one that runs into the night and a `+` on a day with
nothing on it. The `+1` on an overnight shift goes on a phone: "06:30 +1" is
wider than a seventh of a handset and was printing over the day beside it, and
the moon underneath is already saying the same thing. Nothing in a cell reaches
past it now, whatever it turns out to say. The name of the shift does not fit in fifty pixels and the clock
is the half worth reading anyway: four shifts on this property are called some
variation of Housekeeper Helper and only the times tell them apart. Pressing a
cell opens the same list of shifts the dropdown opens on a desk.

**The positions view takes the same shape.** The position's name and its hours
on a line of their own, then its days seven across, each one holding the shifts
standing on it: the clock, whose it is, and a `+` on a day that still needs
somebody. The shift's name is the heading two lines above it and is not printed
again in a cell fifty pixels wide.

The standing-pattern buttons go on a phone, because setting somebody's usual
week is desk work. Everything a planner does to a whole stretch — copy a week,
clear a period, import, what changed, suggest a draft, export — sits behind
*More*. What stays in view is what somebody is meant to act on: the people the
plan is overworking, and the days waiting on an answer.

None of this touches anything wider than a handset: the desk keeps the table it
had.

**And the toolbar is one row, not three.** A screen accumulates outputs — save
it, download the ones to deal with, the same across the week, the whole day as a
file — and on a desk they sit along the toolbar and cost nothing. On a phone the
same four wrapped onto three rows and pushed the morning's list below the fold,
so what a supervisor opening the app in a corridor saw was a page of buttons.
They are behind *More* now, which is one button and opens them as a block; on a
desk nothing moved. The day and week arrows lost their words for the same reason
— "‹ Previous day" and "Next day ›" either side of a date field is wider than a
handset, and it says twice what the field already says — and *This week* only
appears when the week on screen is not this one. The two emoji on those buttons
are gone as well: a phone draws them in full colour and they read as decoration
on a button that is doing a job.

**A dialog is never taller than the screen actually is.** `100vh` on iOS Safari
is measured with the address bar and the toolbar hidden, so a panel capped in
`vh` on an iPhone showing both is taller than the part of the screen anybody can
see. It does not overflow, so it never becomes scrollable: it simply runs off
the bottom under the toolbar, and whatever is down there cannot be reached at
all. That is how the switch that turns notifications on became unreachable on an
iPhone 7 Plus. `dvh` was meant to answer this and arrived in Safari 15.4, which
is later than a good many phones still in use here, so the app publishes
`window.innerHeight` as `--vh` and keeps it up to date, and every full-height
thing in the stylesheet is measured against that. The `vh` and `dvh` lines stay
above it as fallbacks.

On a handset a dialog is also anchored to the top of the screen rather than
sitting along the bottom, and it starts below whatever the phone is using up
there. Installed on an iPhone the page paints under the status bar, so a sheet
against the very top puts its own title and its ✕ underneath the clock and the
signal bars. The inset is held as a token — `--safe-top` — rather than written
out at each use, which also means the rule can be checked at a desk by setting
the token to a phone's worth of status bar. A sheet along the bottom is the nicer place for a
thumb, but the bottom of the viewport a dialog is laid out in is exactly where
Safari puts its toolbar. Nothing behind an open dialog scrolls, either, on a
phone: a page that moves under a modal is a page whose owner concludes the modal
does not scroll.

One bug fell out of looking at it: the name cell on three tables put the
department straight after the name with no line break, so every row read
*Abdul Hamid IddrisuSecurity*. That was true at every width, not just on a
phone; it was simply easier to see on one.

#### Making the mail arrive

Deliverability is the sum of a dozen small things, and every one of them is
free. What the app now does on its own:

- **A named sender.** The property's own name goes in front of the address, so
  the inbox shows *Somewhere Nice* rather than a bare `hive@niceoperation.com`.
  A name already written into the setting is left alone, and a comma or a quote
  in a property name cannot break the header.
- **A plain-text part on every message.** A message with an HTML part and no
  text part is one of the things filters weigh most heavily, because almost
  nothing legitimate is sent that way and a great deal of junk is.
- **A whole HTML document** — doctype, charset, language — rather than a loose
  fragment, and a preheader so the inbox shows a real summary beside the
  subject instead of scraping the property name twice.
- **A reply-to that reaches a person.** Staff do reply to these, and a reply
  that vanishes teaches them the mail is not worth reading.

The rest is DNS, and the app cannot do it: **SPF and DKIM** come with verifying
the domain at the provider, and **DMARC** is a record you add yourself. Without
DMARC, Gmail and Outlook have nothing to check the first two against.

**Every notice goes out by email as well as ringing the bell.** It reaches
whoever the notice names — the person it is addressed to, or everyone holding
the permission it is for — resolved at the moment of sending rather than from a
stored list of addresses. A stored list is a second copy of who works here, and
the day somebody is promoted is the day the two stop agreeing. The mail is
fired through `waitUntil`, so a provider having a bad afternoon can never slow
a sign-off down or fail one; a send that does fail lands in the email log and
nowhere else. The sender is `hive@niceoperation.com`, and one switch on Users &
data → Notifications turns the whole thing off.

The morning digest is deliberately left as it was: one message, to the typed
recipient list, and only when there is something to do about it. Emailing its
notice as well would put two messages about the same morning in the same inbox,
which is how people learn to ignore both.

#### Texts, for the phones nothing else reaches

Half the property is holding an iPhone 7 Plus. It stops at iOS 15, web push for
a home-screen app needs 16.4, and no amount of work in the app will ever make
one of them buzz. So a published rota now goes out three ways, in this order:

1. **An alert**, to anybody whose phone has actually been set up for one. Free,
   and it lands on the lock screen.
2. **An email**, to anybody whose phone has not. The same message, to the
   address on their login. Somebody who got the buzz does not also get the mail,
   because two messages about one rota is how a mailbox stops being read.
3. **A text**, to anybody the first two miss. It costs a few pesewas and it
   arrives on every handset ever made.

Somebody with no login at all used to hear nothing, and the publish dialog said
so. Now they get the text, since the number is on their record under People
rather than on a login they do not have. Only the people with neither a login
nor a number are counted as unreachable, and the dialog names how many.

**Setting it up.** Users & data → Notifications → *Text messages*. Pick the gateway —
Arkesel, mNotify or Hubtel, all three Ghanaian, all three over HTTP because a
Worker cannot open an SMTP socket or anything like one. Add the key as a secret
(`APP_SMS_API_KEY`, plus `APP_SMS_API_SECRET` for Hubtel, which wants two).
Type the sender name, which is what the message shows it is from: eleven
characters, letters and digits, and it has to be registered with the gateway
first or the messages bounce. Then *Send a test*, which texts one number you
type and costs one message.

**What it costs.** By default only the phones an alert cannot reach get a text,
which is both the cheaper answer and the reason the whole thing exists. The
setting can be changed to text everybody whose week changed. Either way one
publish is capped at 200 messages: nobody rosters two hundred people in one go,
so a number that high means something has gone wrong upstream and should stop
rather than spend.

**The message.** Written to fit in one 160-character segment, because a gateway
charges by the segment:

> HIVE: your rota for Mon 1 Jun to Sun 7 Jun is out. 5 shifts. First Tue 2 Jun
> 06:00. See staff.niceoperation.com

The link is bare rather than a full URL — every phone adds the `https://` back
itself, and that is nine characters of a segment.

**Numbers are read however they were written down.** `024 123 4567`,
`+233 24 123 4567` and `00233241234567` are the same phone and all three work.
Anything that does not come out as a real Ghanaian number is skipped rather
than guessed at, because a text sent to a wrong number is worse than one not
sent. Sending happens last and cannot throw: a gateway with no credit left, or
one having a bad afternoon, gets written to the text log and never leaves a
rota half published.

**The person you just acted on stays where you can see them.** The list is
ordered worst first, which is right when you open it and wrong the moment you
do anything: signing somebody's two worst days drops their count, so on the
refresh they re-sort into the middle of twenty-three cards and the person you
were halfway through working on is gone from the screen. It reads as *the whole
card disappeared when I signed two days* — and from where the reader is
sitting, it did. So whoever was last signed, asked about, reopened or corrected
is held at the top of their group, outlined, scrolled to, and carrying a line
saying what just happened and how many of their days are still outstanding.
Pressing any control means the reader has moved on, and the hold is released.

**Each person's days sort by any heading.** Press *Day*, *Clocked*, *What
happened* or *Flags* on somebody's table and their days reorder; press the same
heading again to turn it round. It sorts that person alone, because the table is
that person alone. *Flags* sorts by how much is wrong rather than alphabetically
— "Absent" before "Late" is alphabetical order pretending to be meaning — so
two presses bring the worst days to the top; *Clocked* pushes days nobody
clocked at all to the end, an absence not being "earliest". Ticks already made
survive the sort.

#### What is wrong, before you sign it

Each person's card names what the period contains — *2 late, 1 absent, 1 not
settled* — and separates the ones worth stopping for from the ones worth
seeing. An unexplained absence, an unsettled day and a whole missed shift are
blocking; lateness and leaving early are not.

Lateness is read from the rules' own verdict, not from the raw minutes. Grace
exists precisely so that somebody due at 06:00 who arrives at 06:01 is not
late, and a screen that flagged them anyway would put a warning beside half the
property every morning — which is how a list of warnings stops being read.

There are then two answers, not one:

- **Sign off** — and that you knew what was in it is recorded with the
  sign-off, so a decision taken over a known problem can be told from one where
  there was nothing to notice.
- **Ask an admin** — the period goes to a queue with the dates, the figures and
  your question. Nothing is signed, the days stay on your list, and the bell
  rings for whoever settles days.

#### The questions queue

Everything anybody has asked, in one place, with the whole conversation on it.
A question asked in a corridor is one nobody can find again; a question with
the dates, the figures and the answer on it is a record of a decision.

An administrator can do three genuinely different things:

| | |
|---|---|
| **Comment** | Say something and leave it open — a question being worked out is not one that has been dealt with |
| **Hand it back with a direction** | Tell them what to do. The period stays unsigned, the query goes back to their screen and rings their bell |
| **Sign it off** | Deal with it here, under the administrator's own name, and the question closes |

Whichever it is, **the bell rings for the person who asked** — them by name and
not every colleague who happens to hold the sign-off permission. They are the
one waiting on it; a notice four people receive is a notice none of them owns.

Once a question has been handed back, signing the days it was about answers it
automatically — though only when *every* day it asked about has been dealt
with. A question about five days, three of which were signed, is still a
question.

### Your shifts, found rather than typed

If you already built your shifts in Hik-Connect, you should not have to build
them again here. **Attendance → Setup → Shifts** offers them filled in, with one
press to accept.

Two sources sit behind that, and neither is authoritative alone:

- **The terminal's attendance bands.** A device in automatic attendance mode
  carries the time windows it uses to label a tap as a clock-in or a clock-out,
  and those come down from wherever the shifts were configured. The poller reads
  them and posts them here. They say *how many* shifts there are and roughly
  when.
- **The punches already recorded.** A few hundred people have been clocking in
  for these shifts. Where they actually arrive, clustered and rounded to five
  minutes, says *precisely* when — and it needs no API, no key and nobody's
  permission.

The observed times win where both agree, and the band is shown beside them as
corroboration. A shift the terminal describes but nobody has worked yet is
offered too; so is a cluster with no band behind it, which is the normal case
for a terminal that was never put into automatic mode.

**Nothing is applied on its own.** A shift decides whether somebody is recorded
as late, and inventing one silently is not a thing to do to a payroll — but the
button is next to a filled-in form rather than an empty one.

Re-running the sync updates the shift it created last time instead of adding a
second beside it, and only its name and times: breaks, grace periods and what
counts as a full day are policy nobody's device knows, so they arrive as
defaults and are never reset by a later sync. A shift you typed in yourself is
never touched.

Check it manually any time with:

```bash
node scripts/hik-poller.mjs --shifts --verbose
```

which prints which of the terminal's configuration endpoints answered. The
poller also does this on its own twice a day.

**The rota is a separate matter.** Who works which shift on which day is not
readable from the terminal at all — it lives in Hik-Connect's own cloud and
would need a partner key. It is maintained here instead, which is the right
place for it anyway: see *The rota* below.

### The rota — maintained here

This is where the rota lives. Not in Hik-Connect, not in a spreadsheet: the
reports are built against it, so it belongs where the reports are, and keeping
it in two places means keeping it wrong in one of them.

Built for the way a rota is actually made — last week, with a few changes:

- **Copy a week.** One press puts a whole fortnight in place. Approved leave in
  the weeks being written to is never overwritten, and a day the standing
  pattern already covers goes back to following the pattern rather than being
  pinned — otherwise one press would turn the entire grid into hand-set
  overrides and the distinction below would be gone by Wednesday. Shifts nobody
  is on yet come across as well: a slot is the week saying it still wants a
  third receptionist on the Saturday, and copying only the people copies a week
  that has apparently stopped needing anybody. Only the shortfall is written, so
  pressing Copy twice does not stack them up.
- **Fill a row.** One shift across every day shown for one person, skipping days
  they are already on leave.
- **Totals along the bottom.** How many people each shift has each day. A shift
  with nobody on it shows in red, which is the question a grid of dropdowns
  otherwise hides until somebody does not turn up on Sunday night.

Two layers underneath. A **standing weekly pattern** per person, set once — for
a fixed rota that is the end of it. A **per-day override** for swaps, cover and
one-off doubles.

A cell following the pattern is faint; one set by hand is not. Without that,
"I gave him Thursday off" and "the pattern never had him working Thursday" look
identical, and they are not — one of them is a decision somebody made.

Night shifts belong to the day they *start*, so a porter's 06:04 clock-out is
not the breakfast cook arriving four minutes late.

> **Hik-Connect only needs the shift definitions**, so its terminal knows how to
> label a tap. It does not need to know that Henry is on nights this week. Leave
> the shifts there if they are already set up, and keep the rota here.

### Importing a week

**Rota → Import a week** takes the CSV the scheduling system exports — employee
name, position, dates, times, title, note — and holds it as a **draft**. Nothing
is written when the file is chosen.

It also takes **the printed schedule as a PDF**, which is what most people
actually have to hand. A PDF says where each word was drawn and nothing about
what it means, so the grid is recovered from the geometry: the row of dates
across the top gives the columns, the names down the side give the rows, and
each cell is read as a block of *title, hours, length, place, job*. Time off
printed in the same grid has hours of its own and is held back rather than
rostered. Both kinds of file come out as the same rows and share every step
after that, so the safety is identical — but the CSV is the surer of the two,
and a draft read off a PDF is worth checking against the printout.

> **A PDF printed from a phone usually cannot be read at all.** Android draws
> every letter as an outline, so the file is a picture of a schedule with no
> text in it. Print it from a computer, or export the CSV. The import says so
> when it happens rather than reporting an empty week.

The draft says exactly what it would do: how many days for how many people,
which shifts it would have to create, and every line it could not use and why.
Confirm applies the lot in one press; discard costs nothing, which is the
property that makes it safe to try. The rota decides who is late and who is
absent, so an import that wrote first and reported afterwards would be one
nobody dared run twice.

Names are matched exactly, then by an alias somebody has confirmed, then by two
or more words in common — which catches "Angela Asare Ayima" against "Angela
Ayima Asare" without ever matching two different people. **One shared first name
is deliberately never enough**: "Emmanuel Twum" and "Emmanuel Ofori Bennie" share
exactly one, and quietly rostering the wrong Emmanuel is only noticed at payroll.
Unmatched names are listed once with a "who is this?" button, and the answer is
remembered — the same export arrives every week, and being asked the same
question every Monday is how an import stops being used.

Times pick the shift; where several share their hours, the position breaks the
tie.

**Hours the property has no shift for are a question, not an action.** Nothing
is created by an import unless somebody asks for it by name. Each set of unknown
hours is listed once — however many lines use it — with the shifts nearest to it
ranked by how many minutes apart they are, and three answers: use one of those,
create a new shift, or leave those lines out. Nothing is applied while a
question is open.

The default matters here. A line reading 05:30–11:30 against a property that
runs 05:00–11:30 is somebody typing half past, not a new shift — and a system
that quietly creates one leaves two nearly identical shifts, splits the reports
between them, and nobody notices for a month. Where a shift genuinely is new,
its break and grace start at the defaults, because no rota export knows a
property's policy.

Two lines for one person on one day keep the later and report the earlier. The
draft is kept after applying, because "where did Thursday's night shift come
from" is a question that gets asked.

### Rotating shifts

A hotel does not run on a fixed week. Set someone's pattern to repeat every two,
three or four weeks and give each week of the cycle its own seven days —
mornings one week, afternoons the next, nights the week after, with the rest day
travelling with the rotation. Set it once and it plays out for as long as they
work there.

Cycles are counted from a fixed Monday rather than from when a person was added,
so the same date always falls in the same week of the cycle no matter when the
screen is opened. If a rotation ends up a week out of step, move that person's
weeks round by one rather than touching dates.

**Same every week** is the default and is exactly the old behaviour, so nobody on
a fixed week has to know rotations exist. Any single day can still be changed on
the rota itself without disturbing the pattern, and the fill button (**⇢**) puts
one shift across the fortnight on whichever weekdays you tick.

### The monthly reckoning

A rota says somebody was due twenty-two days; the terminal says they worked
nineteen and a half. **Leave → The month, day for day** puts those two numbers
side by side for every person in a month, with the gap between them, and asks a
manager to decide what happens to it.

Both numbers are computed fresh from the same rules every other screen uses, so
a shift corrected this morning or a supervisor's ruling from yesterday changes
them — right up until the month is signed off. Approved leave and public
holidays are already out of the rostered count, so what is left is a real gap
rather than somebody's fortnight in July.

**Over and under are counted in whole days, never hours.** Subtracting hours
worked from hours rostered gives a decimal, and a decimal is unusable: nobody is
charged 1.3 days of leave. It also counts things nobody would count — somebody
who left twenty minutes early four times has had four slightly short days, which
is a conversation, not a deduction. So each side is an event with a bar to clear:

- An **over** is a day the rota never asked for, and only where more than six
  hours were actually worked. Two hours covering a gap is a favour, not a day off
  in lieu.
- An **under** is a whole rostered shift missed, and only once somebody has ruled
  on it. A part-day is never an under at any length, and an absence nobody has
  confirmed may still be a forgotten tap — charging leave against a maybe is the
  one mistake here that costs a person real money.

Every figure on the row can be pressed to see the days behind it — rostered,
worked, over and under each list their days with times, status and who ruled on
them. A count nobody can open is an assertion.

Signing off is deliberately two numbers rather than one. The difference is
arithmetic; what actually comes off somebody's leave is a judgement. The form
opens with the difference filled in as a default, not a verdict, and the record
keeps both — because the alternative is a conversation six months later with
nothing to stand on. A month can also be **let stand**, which costs nothing and
is still not the same state as one nobody has looked at.

Days charged or given back move the leave balance, and the balances on the same
screen include every month already signed.


**Over and under is `Worked + On leave − Calendar`**, and the five columns
reconcile.

| Column | Counts |
|---|---|
| **Calendar** | What the month expected: five days out of every seven, less a whole day for each public holiday |
| **Rostered** | What the rota asked of them. There for comparison; it does not enter the arithmetic |
| **Worked** | Days clocked in *and* out of. Whole days only |
| **On leave** | Days on approved leave |
| **Over / under** | `Worked + On leave − Calendar`, and what the sign-off proposes |

Five out of seven rather than Monday to Friday: the rota runs across all seven
days and a Saturday is an ordinary working day for half the staff, so counting
only weekdays would leave the night porter permanently over for doing exactly
what was asked of him. A public holiday takes a whole day off the expectation
wherever in the week it falls.

**A month can be told what it expected**, per person. Press the Calendar figure
on somebody's row and type what that month actually asked of them — somebody
covered the season on six days, a kitchen closed for a fortnight, somebody came
back part-time for three months. One number cutting across every month is close
enough for an office and wrong for a hotel, and the month it is wrong for is the
month nobody notices until leave has already moved. It applies to that person
and that month alone; clearing it hands the month back to the ordinary rule. The
figure is spread across the month's dates, so signing a fortnight of it still
comes to what the whole month would over those days.

The general shape is settable too: a **days-a-week** figure per person under
Setup → Staff, with a property-wide default under Setup → Rules. Use that for a
contract that is simply not five days; use the monthly figure for a month that
was unusual.

The expectation is carried **per day** — five sevenths of a day at a time — which
is what lets a sign-off cover three days out of a month and still come to the
same answer the whole month would. It is rounded once, to whole days, at the
point a period is totalled: leave is charged in whole days, and the five columns
have to reconcile exactly on screen or nobody believes any of them.

This replaced a narrower rule that counted an extra day only past six hours on
an unrostered day, and a missed day only once a supervisor had ruled on it. That
was defensible and it was also unusable: a property that has never got round to
settling its absences read "square" every single month, which is the one thing
it was not. An absence now counts whether or not anybody has settled it — a
working day nobody delivered is a working day nobody delivered — and the count
beside the figure says how many are still waiting on somebody to say what
happened.

Two things it deliberately does not do. A short day counts as a day, because it
was clocked in and out of and the column answers "did they turn up and finish";
the credited half-day figure the reports and the export use is untouched. And
somebody the rota never asked anything of — a starter whose first week is next
week, somebody who has left — is not shown as owing the month, though days they
did work still count in their favour.

Every figure on a row opens the days behind it.

### Leave

Requests, approvals and balances on one screen, because the question is never
"how much leave has Ama left" on its own — it is "can Ama have next Friday off".

Only rostered days are charged. A request spanning a rest day or a public
holiday does not spend leave on it, which is also what stops staff learning to
ask for Friday-to-Monday.

The default entitlement follows Ghana's Labour Act 2003 (Act 651) — fifteen
working days after twelve months' continuous service — and is a setting. Anybody
part way through their first year is shown a pro-rata figure rather than a bare
zero, so a manager can see what they are on course for.

### What an absence *means* is yours to decide

Not code — a table you edit. For each kind of day: is it paid, does it count as
a day worked, does it come off the annual allowance, does it need a note.

Paid and counts-as-worked are different questions, and conflating them is how
these systems go wrong: paid annual leave is paid but is not a day worked; a day
at a training course is both.

Sick leave, compassionate leave, maternity, unpaid leave, suspension, training,
working off site are all there to relabel and re-cost. Add your own. Eight
built-ins cannot be deleted because the status machine points at them by name,
but every one of them can be relabelled and re-costed.

### Public holidays

Ghana's calculable dates fill in for a year in one click — the fixed dates, Good
Friday and Easter Monday from the computus, Farmers' Day as the first Friday in
December, and the weekend-to-Monday rule applied across the lot.

Eid al-Fitr and Eid al-Adha follow the lunar calendar and are announced locally,
so they are left for you to type in. A computed guess that lands in a payroll is
worse than a blank somebody has to fill.

### Two ways in, and neither needs a server

The app is on Cloudflare; the terminal is on your office network with no public
address. Something has to bridge them, and there are two honest options.

**The terminal posts to us.** Configured once with a URL, it makes its own
outbound request every time somebody taps. Nothing runs in the building. This is
the default, and for most properties it is the right answer.

**A reader on site fetches.** A one-file program on any always-on computer asks
the terminal for its log every few minutes, over overlapping windows, so a
dropped connection costs nothing.

The difference is what happens during an outage: a push is one attempt, a poll
retries by design. Both can run at once — punches are matched on the device's
own event number, so a tap that arrives twice is stored once.

The ingest is source-agnostic underneath: normalised punches with a source tag
and a dedupe key, and nothing downstream cares who sent them. A Hik-Connect
cloud adapter, should a partner key ever arrive, would be a third feed into the
same door.

### Nobody goes missing

An employee number the terminal sends that nobody here recognises is listed on
the setup screen with its punch count. The punches are kept, and attach
themselves the moment the person is added.

### The terminal's clock is checked on every tap

Every punch is stamped by the device, not by this app, so a terminal whose clock
has wandered does not fail loudly — it quietly rewrites who was late, and nobody
finds out until somebody disputes a Tuesday that is no longer provable.

A pushing terminal stamps an event and posts it a second or two later, which
makes the gap between the two readable for free. It is measured on every punch,
stored against the terminal, and shown as a warning at the top of the morning
screen — above the counts, because every number underneath was worked out from
times that terminal supplied. The Terminals screen carries the same reading per
device: *right*, *11 min fast*, or *not checked yet*.

The threshold is `att_clock_drift_seconds` in `settings`, three minutes by
default: past anything network delay could explain, well short of a shift's
grace period. The fix is on the device — time zone GMT+00:00, daylight saving
off, time sync set to NTP.

A polled terminal never fills this in. The poller hands over a log that may be
an hour old, and reading that delay as drift would put a red warning on the
screen every morning until everybody learned to ignore all of them.

---

## Recruitment — before somebody is on the books

Everything else in this app assumes a person is already on the books. How they
got there was a folder of CVs, a WhatsApp group and somebody's memory of who
was coming in on Thursday.

**Recruitment** is that part: who applied, who is worth seeing, when they came
in, what the interviewer thought, and who was taken on. It ends where People
begins, and the join between the two is one deliberate press.

Three things on one screen, because they are read together: the **vacancies**
being filled, the **pipeline** of everybody in the running, and the **interview
diary**. Nobody can answer "are we going to fill the housekeeping job" if those
live on three tabs.

### The candidate picks the time

This is the part worth building properly. A time somebody is *told* to attend
is a time half of them cannot make, and the phone calls that follow are the
whole cost of arranging interviews at a property this size.

So the property publishes when it is free and the person chooses.

**Recruitment → Interviews → Publish times.** You say "Tuesday, ten till one,
half an hour each" and it cuts the morning into slots. A slot that would not
fit is not published: a half-hour interview starting at 12:45 when the morning
ends at one o'clock is fifteen minutes, which is not an interview. Publishing
the same morning twice adds only what was missing rather than doubling it.

**The Where box finds real places as you type it**, when a Google maps key is
set. Type a few letters, pick the place off the list, and what goes on the slot
is the full address, which place it was, and where on the earth it is.

That last part is the point, and the autocomplete is only the means. A place
picked off the map becomes a **Get directions** button on the candidate's own
page — one that opens the Maps app where there is one and the website where
there is not. "The office, main building" reads perfectly to whoever wrote it
and is not somewhere a candidate at the other end of Accra can navigate to.

It stays a text box either way. Whatever is typed stands, nobody is made to
pick a suggestion, a property with no key set sees no difference at all, and a
lookup that fails leaves the typing alone. A field that will not accept "the
office" because Google has not heard of it is a field that stops people
publishing interview times. Where nothing was picked off the map, the
directions link still searches Maps for the words.

The place you pick is remembered as the default, so a property that picks its
own front desk once never picks it again. So is whoever is interviewing.

### Who is interviewing, and who gets told

**Who is interviewing** is a member of staff picked off the list, not a name
typed in a box. That is the whole point of it: a candidate takes a time at
eleven at night, nobody here is looking at a screen, and "Kwame" is not
somebody the app can tell.

So the moment a time is taken — by the candidate on their own phone, or by the
office booking one over the counter — **whoever is on the panel is told**, on
their own phone, by name. They are also told when somebody gives a time back,
when the property cancels an interview, when one is moved, and when they are
put on or taken off a panel. Being quietly taken off one is how somebody fails
to turn up to an interview that was theirs.

Somebody on the books with **no login** is still a perfectly good interviewer
and simply cannot be reached. That is not an error: plenty of people who sit on
a panel have no reason to open this app. The picker says "(no login)" beside
them and the line underneath says nothing can be sent, so you know to pass it
on yourself. **Somebody else** is the last option in the list, for an owner or
a consultant who is not on the books at all.

### Changing a diary that is already published

A diary is written a week ahead and the week moves. Before this the only answer
was to cancel and republish, which loses the time a candidate had already taken
and tells them nothing.

**One time** — the pencil on a slot. Day, time, length, vacancy, where, and who
is on it. Moving one onto a time already published that day is refused rather
than left to produce two interviews at the same minute.

Moving a **booked** one is allowed, and the box says what it costs. The
candidate's own page reads the slot, so the new time is what they see the next
time they open their link — but a link they have already closed does not ring,
so somebody has to tell them. Better a control that says so than one that
refuses and gets worked around on paper.

**A whole day** — *Edit this day* beside the date. The realistic edit is not one
time, it is "Tuesday is Yaa now, not me" or "we are in the small office". It
changes where, who and which vacancy across the day and leaves the **times**
alone: moving eleven interviews together is a different thing from correcting
who is on the panel.

Appointments somebody has already been given are **left alone unless you tick
the box**. A bulk edit meant to tidy up the free times should not quietly move
somebody's appointment.

> **The key never reaches a browser.** The ordinary way to do this loads
> Google's own script into the page with the key in the URL, restricted by
> referrer — which puts a billable key in the source of every page that has an
> address box, and a referrer restriction is a request rather than a wall. Here
> the browser asks this app and this app asks Google. Set it as a Worker secret
> (`wrangler secret put GOOGLE_MAPS_KEY`) or paste one in under
> **Setup → Rules → Finding places on a map**; the secret wins where both
> exist, and neither is ever shown back. It needs a Google Cloud project with
> the **Places API (New)** turned on and billing enabled.
>
> Google bills autocomplete by the session rather than the keystroke when a
> token is carried from the first letter through to the pick, so one is, and a
> nine-letter address is one billable lookup rather than seven. The box also
> waits a quarter of a second after somebody stops typing, and never asks about
> fewer than three letters.

Then **make the candidate a link**. They open it on their phone, see the times
grouped by day, and tap one. You are told the moment they do. They can change
their mind or give the time back, which frees it for somebody else rather than
leaving you with an empty chair and no warning.

> **Two people can never take the same half hour.** The claim is one
> conditional update, shared by the candidate's own page and by the office
> booking a time over the phone. Two candidates pressing at the same moment:
> one gets it, the other is told plainly and shown the list again rather than a
> confirmation that is not real.

**And a time somebody has taken goes off everybody else's screen.** The
conditional update above handles two people pressing at the same instant; the
commoner version of the same thing is slower and more annoying. A page opened
at nine, left on a phone, looked at again at half past: by then two of the four
times are gone and it is still offering them. Being refused *after* deciding on
Tuesday at eleven reads as the app failing, rather than as a time going.

So the candidate's page asks again on the two occasions worth asking: when it
comes back into view, which is what happens when a phone is unlocked or a tab
is returned to, and on a slow timer while it is actually on screen. The button
is simply not there any more, and a quiet line says one has just been taken. It
asks for nothing while the page is hidden, once a time has been chosen, or on a
link that never offered times — a candidate's phone is their own data.

The office screens hear it too. Recruitment has its own live channel, so a
candidate booking at eleven at night moves the diary on any screen that happens
to be open on it, without anybody reloading.

A candidate is only ever offered times published for **their own vacancy**, or
for none, and never a time that has already gone. A link sent on Monday and
opened on Friday must not offer Tuesday morning, because somebody will pick it
and turn up.

Their page is told the property, the job, the message you wrote and the times
that are free. It is not told who else applied, who is on the panel, or
anything anybody has written about them.

### Nothing is emailed from here

You get a link and a message written out ready to paste, and you send it
however you already talk to that person. There is a WhatsApp button beside it.
An app that insisted on sending its own email would be an app that needs an
address for somebody who applied by walking in with a printed CV.

The link is the same shape as an employee's: shown once, stored only as a hash,
expiring, cancellable, with an optional four digits you tell them out loud. It
lasts ten days by default rather than twenty-one, because it carries a diary
and a diary three weeks old offers times that have been and gone.

### Getting people into the pipeline

One at a time, or **Paste a list** — a name per line, with a number after a
comma if you have one, which is what a stack of applications or a list from an
agency actually looks like. It reads the list, shows what it found with a tick
on each line, marks anybody already in the pipeline, and writes nothing until
you press the second button.

It creates candidates and only candidates. Nobody reaches the property's books
this way.

**Or upload the CVs themselves.** *Upload CVs* takes a folder of them at once,
against a vacancy you pick, and reads each one for a name, a phone number and
an email. What it found comes back with a tick and an editable box against each
file; nothing is written until the second press, and each CV lands on the
person it came from rather than in a pile.

The three things it reads are not equally reliable, and the screen says which
is which. An **email** is a shape and is as close to certain as this gets. A
**phone number** is nearly as good, and is checked against the two traps that
do real damage on a CV — a year of employment and a Ghana Card number. A
**name** is a guess: there is no marker for one, so it is taken from the
heading, the first line, or the file's own name, and the note under each row
says which of the three it used.

A **photograph** has no text in it at all, and half the CVs here are a picture
taken on a phone. Those are attached, offered whatever the file name suggests,
and marked *"A photograph, so there is no text to read. Type their name."* That
is honest and useful; guessing would be neither. Anybody already in the
pipeline is flagged and starts unticked, so a folder uploaded twice does not
double everybody up.

**The CV goes on when the name does.** The Add a candidate form takes files,
several at once, because the moment somebody is typing a name off an
application is the moment they are holding the application. Made to wait for a
second screen it does not get attached at all, and a pipeline of names with no
paper behind them is a pipeline nobody can shortlist from. A photograph of a
printed CV counts, which is what most of them are.

Each file says what it is: a CV, a certificate, a reference, or something else.
That is not decoration. When somebody is taken on, each one lands under the
staff record's own name for it — a certificate becomes a qualification, a
reference becomes a reference — so a school certificate sent with an
application is filed where the record expects it rather than in a pile called
"CV". More can be added on the candidate's own page at any time, and they can
be asked for on the candidate's link.

### Several at once

Shortlisting is the one step genuinely done in a batch: somebody reads twenty
CVs in an evening and six of them are worth seeing. Six presses with a dialog
on each is how that turns into an afternoon, and how a pipeline stops being
kept up to date.

So the pipeline has a tick against each name and a bar that appears once
anything is ticked. **Move to shortlisted** where they are all at the same
stage, **Not this time**, or **Somewhere else** for a mixed handful where there
is no one forward step. An ending still insists on a reason, asked once and
written on every one of their records.

A batch can do nothing a single press could not. Nobody reaches the books this
way, every move lands on its own trail, and anybody being taken out of the
pipeline gives their interview time back to the diary. **One refusal does not
sink the rest**: somebody taken on since the screen was drawn is skipped with a
reason and everybody else goes through, because failing all twenty because of
one is what teaches people to move them one at a time again.

### A link each, and a file to keep them in

The point of shortlisting six people in one press is inviting six people in one
press. **Make links** on the same bar does that, and the first thing it offers
is the **download**.

That is not a convenience. Every link is stored only as a hash and can never be
shown again, which is right for one link and dangerous for twenty: a browser
closed at the wrong moment loses the lot. The file has the name, the number,
the link and the whole message on one row — a safe copy, and also the shape
somebody wants for pasting them into WhatsApp one at a time. There is a Copy
and a WhatsApp button on each row beside it.

Anybody with no interview times free for their vacancy is skipped by name and
told why, rather than being sent a link that opens on an apology.

> **No four-digit code on a batch.** A code has to be told to each person out
> loud on a call, which is the phone call this whole thing exists to remove,
> and one code shared by twenty is not really a code. Where you want one, make
> that link on its own from their page.

### Why somebody was not taken on

Turning somebody down asks for a reason in a line and keeps it. That is the
whole value of a recruitment record afterwards: the question anybody asks a
year later is why, and "nobody can remember" is the answer that costs a
property a claim.

Every candidate has a trail — added, shortlisted, link made, link opened, time
taken, scored, offered, taken on — with who did it and when. Nothing on it can
be edited or removed.

And nothing is ever deleted. Somebody turned down in March is somebody to ring
in June, which is the single most useful thing a small property's hiring
records can do for it.

### Taking somebody on

The one door between a candidate and the books, and it is deliberately heavy.

It appears once somebody has actually been **offered** the job. It makes their
staff record, carries across the phone number and email the pipeline already
holds, and moves their CV onto the record so it is filed where the rest of
their paper will be. Their interview time goes back into the diary. The
vacancy closes itself if that was the last person wanted. Whoever keeps the
records is told, because the next three things that have to happen are theirs.

**The employee number is typed in by hand** and has to match what is enrolled
on the terminal exactly. It is the join between a punch and a person; there is
no version of guessing it that is safe. Punches already sitting under that
number become theirs, so somebody enrolled last week and starting this week
does not lose the days in between.

**It needs the attendance setup permission as well as recruitment.** Running
the pipeline is a job a manager holds; putting somebody on the property's books
is what setup guards, and a side door into it would make that permission mean
less everywhere else. The screen says so rather than hiding the button —
"ask an administrator" is a useful sentence and a missing control is not.

**It does not issue the contract.** That is the next press, on their new
record, through the templates and the signing that already exist. A contract
from a hire and a contract from anywhere else have to be the same document with
the same trail, or the trail is worth nothing.

---

## People — the records behind the names

Attendance knows somebody as an employee number and a name, because that is all
a turnstile needs. **People** holds everything else: where they live, who to
ring if something happens, what they have signed, and the scan of the ID it was
all checked against.

Two ideas run through it, and everything else follows from them.

**What somebody sends you is a claim; what is in the record is a decision.** A
self-service form never writes to the record. It lands as a submission with a
line-by-line difference against what is already there, each line with a tick,
and somebody accepts it. Same shape as the rota import and for the same reason.

**A signature is worth what you can show about it.** A contract keeps the exact
words that were signed, a fingerprint of those words, and a sequential log of
every event — issued, link sent, link opened, document read, signed — each with
a time, a network address and the device.

### Folded under departments, and a box to type a name into

The list started at twenty-odd names and read as a list. It is now a page
somebody scrolls past to reach the housekeeper they came for, so **People**
opens as its departments rather than its names: each one a band with a count,
and the names under it when you press it.

Three things sit above it.

**A search box** that takes a name, an employee number or a job title and
narrows the list as you type rather than when you leave the box. Every record
is already in the browser, so nothing is fetched and nothing waits.

**Which department**, which is the question anybody arrives with.

**What state the record is in** — on the books, everybody including people who
have left, records with something still missing, contracts sent and not signed,
or only the people who have left. The middle two are the two lists somebody
actually walks round the building with.

The bands open on their own the moment any of the three is used: a search that
finds three people and hides them behind three lids has not found anybody.
**Open them all** is there for reading the whole list at once, and **Clear**
puts it back.

### The register, out of a spreadsheet

**Setup → Staff → Bulk upload.** A CSV of the property's staff, read
line by line, shown in full, and only then written.

**This is the only import in the app that creates people.** Every other one
refuses a name it has not seen, on the grounds that a rota or a payroll sheet
is about people somebody already decided to employ, and a file that can quietly
invent one eventually does. That reasoning does not apply here: inventing
people is the entire job. A property that has been running on a spreadsheet for
six years should not have to type ninety names into a form one at a time.

So the safeguard moves rather than disappearing. Everything the file would do
sits on the screen first — who would be added, who would change and what about
them, every line that could not be read, every column nobody recognised — and
nothing at all is written until somebody has looked at that and pressed the
button. The additions are listed separately from the changes, under a warning
that says how many new people there are, because a staff number that matches
nobody is read as somebody new and one typo therefore makes a duplicate.

**One button, and the template behind it.** Every screen that takes a file of
data has the same control: **Bulk upload**, which opens a small menu with
*Upload a file* and *Download template*. Take the template first — what comes
down is the property's own people with their own figures in it, not a blank
form with headings and nothing under them. Change the lines that changed and
send it back. A property with nobody on it yet gets one example row, so the
columns are shown rather than described.

The same control is on **Payroll** for a month's figures and on the **rota**
for a week, so the way in is the same wherever a sheet is involved. Uploading a
sheet and downloading the one to fill in are the same job in two directions,
and as two buttons side by side they read as two unrelated things with the one
nobody wants first.

**The columns.** Employee number and name are the two it needs; everything else
is optional and matched on the words a staff list actually uses, so a column
moved or missing changes nothing.

| Column | Also accepted as |
|---|---|
| Employee no | employee number, staff no, staff id, emp no, id |
| Name | full name, employee name, staff name |
| Department | dept, section, unit |
| Job title | title, position, role, designation |
| Started | start date, hired, date employed, joined |
| Left | leaving date, date left, exit date |
| Annual leave days | leave days, leave entitlement |
| Days a week | days per week, working days |
| Here for | kind, type, on the rota |
| Phone | mobile, telephone, contact number |
| Email | e-mail, email address |
| Basic salary | basic, salary, monthly salary, basic pay |
| SSNIT | on ssnit, ssnit member |
| `Allowance: <name>` | one column per allowance — see below |
| Note | notes, remark, comment |

*Here for* takes the same three answers the staff form does: `Rota`,
`Never rostered`, `Payroll only`. A **basic salary** in this sheet is what puts
somebody on the payroll, which is why most of these sheets exist in the first
place; the month's figures afterwards go through Payroll → **Bulk upload**,
which changes what people are paid and still creates nobody.

**Allowances get a column each**, headed `Allowance: Transport`. The prefix is
the safeguard and it is not decoration: a bare column called Transport stays
unrecognised and is reported back, so nothing turns into money on a payslip by
accident, but a heading that says outright what it is can introduce an
allowance the property has never used, once somebody ticks to allow it. Add
`(not taxable)` — or `(tax free)` — for a genuine reimbursement; without it the allowance is taxable, which is what
most of them are. Nought takes an allowance off; a blank cell leaves it alone.
The same columns work on the **month's** sheet under Payroll, where they used
to be limited to allowances already in use, and an allowance for somebody who
is not on the payroll yet is reported rather than set, because it would never
reach a payslip.

**A column that adds them up is read as one.** `Allowances: Total` — or
`Total allowances`, or `Allowance: Total` — is the line totalling itself, and
the month sheet checks it rather than setting anything from it: a total cannot
say how it splits, and reading it as an allowance called Total would put a
second copy of everybody's allowances on a payslip under that name. What it is
worth is the disagreement, said against the line it is on: *the sheet totals
900.00, the payroll will pay 400.00*. That compares against what the person
will actually be paid, not against the sheet alone, so an allowance the sheet
never mentions still counts. The one exception is a property running a single
allowance whose sheet has no column for it, where there is exactly one thing
the total can mean and it sets that one. The staff sheet has nothing to check a
total against, so it reports one back.

**A bonus scheme gets a column too.** A scored one is headed `Score: <name>`
and holds a percentage; one that pays a set figure is headed `Bonus: <name>`
and holds money, so fifteen agreed figures are a column somebody pastes rather
than fifteen boxes somebody types. The word above the column is not what
decides which it is: the scheme is found by name and its own kind says how the
cell is read, so writing `Score` above a column of amounts gets you what you
meant. A cell against a scheme somebody is not under is refused either way.

**A scheme can also pay by tier.** Nkosoɔ is scored one to ten and every score
is worth a stated amount — a 1 is seventy cedis, a 4 is a hundred and thirty, a
10 is two hundred and fifty. Neither of the other two shapes holds that:
scored out of a hundred it means working out what per cent of 250 comes to 130,
every month, for everybody, and as a set figure each it means typing the money
when the score is the thing the property actually decides. So the table belongs
to the scheme and somebody picks a score. The rungs are written out rather than
stored as a start and a step, because every one of these stops being even
eventually and a scheme that cannot hold what was agreed gets worked around in
somebody's head. A score not on the table is refused rather than rounded to the
nearest, and what a rung was worth is copied onto the payslip when the score is
given, so moving the table in December does not rewrite what somebody was paid
in June. Its column on the month sheet holds the score itself, a 4 rather than
a percentage or the money.

**A name the property has not got is offered rather than refused.** The preview
lists what the file would introduce and puts a tick beside it, and nothing is
made unless that tick is on. Leave it off and the sheet still goes in, with the
new names listed back as the one thing it left alone. `Bonus: Housing` against
a scheme nobody has heard of offers to make a set-figure scheme, because the
column is the money and there is nothing left to guess; everybody with a figure
in it goes under the scheme as it is made. `Score: Housing` cannot do the same
and is still named back on its own, because a column of percentages is a share
of a worth and nothing in it says what that worth is. A scheme that was made
once and later retired is matched, not made a second time.

**A blank cell leaves what is there alone.** It is not an instruction to clear a
department or wipe a start date. Somebody sending back a sheet with two columns
filled in means to set two things.

**Matched on the employee number, never on the name.** Two people called Kwame
Mensah are two people; the number is the only thing that is theirs. A line with
no number is skipped and named, and the same number twice in one file is caught
rather than applied twice.

**Dates are read four ways**, because a spreadsheet hands back whatever the
person's locale felt like: `2020-01-06`, `06/01/2020` (day first, as it is
written here), `6 Jan 2020`, and the serial number Excel writes when a date
column is exported as text. Anything else is reported against that line and the
rest of the line still goes in.

**A number invented for somebody who is only paid stays out of the terminal's
matching**, exactly as it does when they are added by hand, so it can never
claim the punches of whoever really holds that card.

### A tax table has a date it starts on

The bands were one setting, so there was one table and it was always the
current one. That is right until the day it changes: GRA moves the bands in the
budget, somebody types the new ones in, and every month still open — including
one being reopened to correct a single allowance — is quietly retaxed at rates
that were not in force when it was worked.

**Setup → Tax and SSNIT → These figures start in.** Save the change with a
month against it and the figures apply from that month on. Everything behind it
keeps whatever was in force then. The first time a property dates a table, what
it was using until then is kept as its own row, so the history is complete from
the start rather than from the second change.

**Tables by date**, at the bottom of the same screen, lists every set of
figures the property has used and the month each one started. Somebody asks in
November why March came to what it did, and the answer is a row on that list.
The captured row cannot be removed: taking it off would leave every month
before the first dated change with no figures at all.

**What is and is not retrospective**, since this is the question that gets
asked:

| | |
|---|---|
| A **closed** month | Never moves. Closing writes every payslip out in full, and the screen, the payslip, the journal and the GRA schedule all read those afterwards. |
| An **open** month | Uses the table in force for *that* month, not today's. It recomputes, but at the right figures. |
| A **reopened** month | The same: reopening January in July gives it January's table back, not July's. |

The payslip carries the name of the table it was worked out on, so a slip
printed in March can be told from one printed in April, and the payroll header
says which table answered for the month and when it started.

**The pension split is kept with the payslip**, not worked out again when
somebody draws the journal. It used to be recomputed from today's SSNIT
percentages, so changing them would have a closed month's journal show a new
tier 1 / tier 2 split against the PAYE it was actually closed on. Payslips
written before this keep working: they fall back to computing it, which is what
they always did.

### The birthday message is yours to write, or to switch off

The one message this app sends that is not about hours, lateness or money was
written into the code, which made it the one message nobody here could change.
A property that wanted to say something in its own voice had no way to, and a
property that would rather a person said it out loud and the app stayed out of
it had no way to do that either.

**Setup → Birthdays.**

Two messages, kept apart on purpose. **What the person gets** is warm and
addressed to them: a heading and a line, with `{name}` where their name goes
and `{property}` where this place's name goes. `{name}` becomes their preferred
name where they have given one. **What whoever runs the floor gets** is a
prompt rather than a wish, because what somebody actually remembers about their
birthday is a colleague saying it out loud, and an app that only sends an
automatic message has replaced that rather than prompted it.

Either can be switched off on its own. With both off nothing goes out at all,
and nothing is marked as sent, so turning it back on tomorrow is not a day
somebody was quietly skipped. You also choose whether it reaches their phone or
waits in the bell, and how far ahead the coming-up list on Today looks.

**How it reads** shows both messages as they will actually arrive, against the
first name of whoever's birthday is next. It redraws as you type. A preview
against "John Smith" reads as a preview; the same sentence with a real name in
it is the thing itself, which is what makes a clumsy line obvious.

Underneath are the two lists that make this a screen rather than a form.

**Nobody knows when these birthdays are** is the one that matters. A birthday
the app has never been told about looks exactly like a birthday nobody has, and
nothing else in the app tells them apart. It is a chase list, so it is folded
by department and each name links to the record where the date goes.

**The year** is all twelve months with everybody under the one they fall in,
which is the only list of it anywhere in the app. **What has gone out** is the
last thirty birthday messages and who each went to, so a change to the wording
can be checked against something real rather than taken on trust.

The card on the Today screen opens with whatever the wish says, so a card
somebody sends by hand and the message the app sent an hour earlier are not two
properties talking. Nothing here ever reads a birth year out loud: the record
holds a full date because payroll and contracts need one, and a card announcing
that somebody is fifty-three is not a kindness.

### A member of staff sees their own screens, even before they are linked

A staff login that has not yet been pointed at somebody's staff record used to
open on the Guide and nothing else. Every one of their screens was hidden, and
there was no way through to any of them.

The rule doing it was written for an administrator who happens not to be on the
rota: they hold every permission there is, including the one for their own
screens, and with no staff record behind the login there is nothing of theirs
to show, so the menu item goes. That is right, and it assumed the alternative
was a full menu with one broken entry in it.

For a member of staff it produced something far worse, because those screens
are the only ones they have. So the rule now applies only while there is
something else to show. Somebody who holds nothing but their own screens gets
them, and each one says plainly that the login is not linked yet and who to
ask. One screen that explains why it is empty beats an app that appears to
contain nothing.

### Every table fits a phone, or scrolls on its own

A table of figures has cells that do not wrap, so on a handset it is wider than
the screen. That is fine as long as the table is what scrolls. It was the page
that scrolled, which takes the whole layout sideways and hides the column on
the right that the table exists for.

Every wide table now scrolls inside its own box, and looks as though it does: a
shadow appears on whichever side there is more to see, and on neither side once
the whole table fits. It is two pairs of backgrounds rather than a scroll
listener, so it costs nothing and cannot fall out of step.

Where a column can go instead of scrolling, it goes: the running account under
My advance drops the opening balance on a phone, because it is the closing
figure on the line above, and says the currency once in the heading rather than
on every figure in every row.

### The workforce, measured four ways

Under the comparison table on **Workload** are four blocks, in the order a
hotel asks the questions once it has stopped firefighting.

**What the labour costs.** Cost an hour, cost a day, and the share of the bill
going out as overtime and holiday premium, each beside what it was over the
window before. Rates rather than totals on purpose: a wage bill goes up when
trade goes up, which is the point of trade, and only a rate moves when
something has actually changed. Under that, the split between what a rota can
move and what it cannot, cost an hour by department, and who the money goes to
with a running share beside them, which is what answers "how few people is half
of this". Anybody without a salary on their record is named, because until they
have one every figure above is an understatement.

**Where the time goes.** Two different questions, kept apart, because mixing
them sends somebody to talk to the wrong person. Did the rota ask of people
what was agreed with them, and having been asked, did they turn up and stay.
Absence and lateness come from what the clock recorded, over the days somebody
was actually rostered: a day nobody put them down for is not an absence.

**Who is at risk.** The strain score behind the table above, ranked, with what
put each person there. Rules are counted by rule rather than by person, because
four people short of a turnaround is one rostering habit and not four problems.
Untaken leave is priced at each person's own daily rate, which is a real bill
that grows quietly and falls due in a lump the day somebody resigns.

**What shape the cover is.** People on, hour by hour across the day. A rota
looks balanced as a grid of shifts and is often not balanced at all as a curve:
three shifts that all start at eight leave the building empty at six, and no
table of shift counts ever shows that. A night shift counts on the hours it
actually covers rather than falling off the end of the clock.

Money only reaches somebody who may see pay, and it is left out by the server
rather than hidden on the screen. Every figure comes back as nothing known
rather than as nought where there was no denominator: a department with nobody
in it has no absence rate, and printing 0% would be a claim nobody made.

### The return is the GRA's own form, and the month comes out as a workbook

**Payroll → Journal and PAYE** used to show Hive's own fourteen-column summary
of the return. It had the right figures in the wrong shape, so whoever filed it
rearranged the columns by hand every month, which is a job nobody should be
doing twelve times a year.

It is now the form. The same twenty-seven column numbers along the top, the
same headings in the same order, the same heading block with the employer, the
tax office and the month as MM/YYYY. Column 15 is 6 + 11 + 14, column 19 is
15 + 16 + 17 + 18, column 21 is 9 + 10 + 20, column 22 is 19 minus 21 and
column 26 is 13 + 23 + 25, because that is what the form says they are.

Some columns are filled in from outside the payroll:

| Column | Where it comes from |
|---|---|
| 2, TIN / GH. Card | The TIN on somebody's record, or their Ghana Card number where there is no TIN. The column asks for either. |
| 4, Position | Set against the person. Their job title, then their department, where nobody has set one. |
| 5, Residency | Set against the person. Resident-Full-Time where nobody has set one. |
| 20, Deductible reliefs | Set against the person. Nought for almost everybody. |
| 26, Severance pay paid | Recorded against the month it went out in. |

**Payroll → Set pay and allowances → Return** sets the first three, one person
at a time, and they can be changed again the month they change. Leave any of
them alone and the form uses the reading in the table above, which is right for
almost everybody, so nobody has to fill in twenty-five rows to file a return.

A relief is not just reported. It comes off before the graduated bands, the
same as the pension does, so it lowers the tax and raises what the person takes
home. It has to: on the form, column 22 is 19 minus 21, and 21 includes it.

**Severance** is on a card of its own on the payroll page, because it happens
once when somebody leaves rather than every month. On a profile it would
quietly repeat until somebody noticed, which is the sort of figure that gets
filed three times. It goes in the column that asks for it and nothing else
moves: what severance costs in tax depends on what it was for, and that is a
decision above a payroll.

**Export** on the payroll page and over the return offers **PDF** and
**Excel**. PDF is the browser's own print dialog, where Save as PDF is a
destination on every platform. Excel gives the whole month as one workbook of
three sheets: the
payroll table, the journal, and the PAYE schedule laid out as the form. It is
written without a library, because a Worker has no zip in it and an .xlsx is a
zip of XML; the parts go in uncompressed, which every spreadsheet program
opens.

### A bonus is net for most people, and gross for some

A bonus here is normally a net promise. Somebody is told five hundred cedis,
five hundred is what reaches them, and the property carries the tax that makes
that true. Hive works out the gross figure that leaves five hundred after tax,
puts the difference into the allowance line, and shows the payslip the five
hundred that was actually agreed.

That is not true of everybody. Some figures were never net promises: they were
worked backwards from a take-home somebody had already settled on, so the tax
is already inside them. Grossing one of those up again pays the same tax twice
and hands the person more than was agreed.

**Setup → Pay and allowances → Bonus is net** says which it is, one person at a
time. It sits per person rather than per scheme because the promise belongs to
the conversation somebody had, not to the scheme they happen to sit under: the
same Nkosoɔ tier can be a net promise to one person and a gross figure for the
next.

Ticked, which is how everybody starts, nothing changes. Unticked, the figure
is taxed exactly as it stands, the allowance line carries nothing extra, and
the tax comes out of the bonus instead of out of the property. The payslip
still reads the same way either way, and the earnings column still adds to the
gross.

Who is which shows on **Who is on the payroll** as a `net` or `gross` pill
against each name. A screen that does not ask about it, such as a spreadsheet
upload, leaves the setting alone rather than putting everybody back to net.

### Somebody who is only ever paid

A property has people on the payroll who never touch a terminal and never
appear on a rota: a director, the owner, a consultant on a retainer, a driver
on a fixed monthly wage. Adding them used to be the same thing as adding a
kitchen porter, which meant they turned up on Today as absent every morning, on
the sign-off list every week, and in the year's report as somebody who had not
worked a single day.

**Setup → Staff → Add somebody → What they are here for.** Three answers:

| | What it means |
|---|---|
| **The rota and attendance** | Everybody normal. Nothing has changed for them. |
| **Attendance, but never rostered** | They clock in and out, but no column is kept for them on the grid, the draft or the workload list. |
| **Payroll only** | Nothing about attendance applies. No day is ever worked out for them, no screen counts them, nothing chases them. |

Payroll only takes them off the rota as well, because a rota is a plan for who
is coming in and there is no version of it that means anything for somebody who
is only here to be paid. The form then stops asking the questions that do not
apply: annual leave days, days a week, the days they never work, the
departments they can be put on.

What stays exactly as it was: their record under People, their payslip, their
allowances, their advances, their medical claims, their letters and their
birthday. None of that was ever about who came in this morning.

**The employee number is still required**, and for them it is just a staff
number for the payslip — invent one. It is deliberately kept out of the
terminal's matching, so a number made up for a director can never claim the
punches of whoever really holds that card.

**Switching somebody over keeps their history.** The days already worked out
for them are left alone rather than deleted, so putting them back on the clock
gives them their year back instead of an empty one. What does go is the rota
ahead of them: shifts from today onwards, and their standing pattern, exactly
as they do for anybody taken off the rota.

### One link, whatever they still owe

**People → open somebody → Send them a link.** It carries their details form,
any contracts waiting to be signed, or both — one message rather than three,
which is the difference between a new starter doing all of it and doing half.

The link is `staff.niceoperation.com/i/<token>` and is shown **once**. Only a
hash of it is stored, so a copy of the database opens nothing and a lost link is
replaced rather than recovered. It expires (21 days by default), can be
cancelled, and can carry an optional four-digit code you tell the person out
loud — worth it for a contract, overkill for a phone number.

There is no account and no password on the other end. The page is one column
built for a phone at the end of a shift, and it never reads the record back: the
form starts empty, because a form showing what the property already holds is a
form that leaks it to whoever is holding the phone.

> **Blank is never a delete.** A question somebody skipped is not a request to
> erase the answer on file, so blanks never appear in the review at all. This is
> the single most destructive thing a self-service form can do, and it is the
> one rule in here with its own test.

### Choosing what to ask for

**People → What to ask for.** Every self-serviceable field, every list and every
document gets one of three answers: **ask for it**, **insist on it**, or **do
not ask**. A property that pays everybody by mobile money has no use for a bank
branch; one that has been caught out by an emergency contact nobody filled in
wants that one refused rather than skipped.

The plan is stored as **only what was changed**, and that is the most important
decision in it. A plan listing every field would freeze the form at the moment
somebody pressed Save: a field added to the code next year would be absent from
it and — under any reading that treats the plan as complete — never asked for
again. Storing the exceptions means the default is always whatever the code
currently says. It lives in `settings` under `hr_form`; no setting at all means
the standard set, which is what every property had before this existed.

Insisting is enforced on the way in as well as on the form, because the form is
a courtesy and the API is the gate — and checked against the record too, so
somebody on their second link is not made to retype an address the office has
had since their first week. A field set to **do not ask** is dropped from a
submission rather than reported: a payload naming it is not a mistake.

### Photographing the paper

A Ghana Card number typed into a box is a claim. A photograph of the card is
what SSNIT, the Labour Department and an auditor actually want, and the person
holding the card has a camera in the same device. Until this, the only route was
a WhatsApp message and a manager saving it out and uploading it — three steps,
each of which stops happening.

So the link now carries **Photograph your documents**: the ID, the WASSCE
certificate, the passport photo, a food handler's certificate for anybody in a
food department. Which of them are asked for comes from the plan above *and*
from who the person is — Act 851 applies to whoever handles food, and the record
already says who that is.

A contract is deliberately not on that list. It is the property's own document,
signed through the same link, and would mean nothing arriving as a photograph
from the person it binds.

What arrives is a claim like any other. It does not go on the file: `status` is
`pending`, it is invisible to the completeness checklist, and it waits on
**People → the person → Sent in from their phone**, where somebody opens it,
checks it is what it says it is, and accepts it or sends it back with a reason.
A photograph of the wrong side of a card — or of somebody else's — is exactly
what a review catches and a direct upload would not. Each kind holds one waiting
file per link, because a second photograph is somebody retaking a blurred one
rather than sending a second card, and the person can withdraw anything until it
has been looked at.

Images and PDFs only, up to 12 MB, stored in 700 KB pieces because D1 caps a row
at about two.

### A signature that already exists

Drawing with a finger is fine on a phone and poor with a mouse, and plenty of
people have a signature — scanned once, used on everything — and no interest in
inventing a second one that looks nothing like it. So **Upload an image** sits
beside the signature box everywhere one appears: saving your own signature,
signing a letter, signing a contract.

It is not pasted in whole. A photograph of a signature is dark ink on a
grey-white page and would drop onto a letter as a grey rectangle, so the page is
taken out: anything above a luminance threshold becomes transparent, the result
is cropped to the ink, and the ink is what gets stored. Luminance rather than
pure white, because paper under a hotel office light is never white. An image
with nothing dark enough in it is refused rather than saved as a blank.

#### The address must not move

The token *is* the link. The page reads it back out of the address bar, which
means anything that changes the address on the way in throws it away — and the
failure that follows is unusually misleading, because nothing is wrong with the
link at any point.

Static hosting tidies URLs by habit. A request for `/invite.html` is answered
with a redirect to `/invite`, which is a courtesy on an ordinary site and fatal
here: the browser follows it, the page loads perfectly, and the first thing it
does is look for a token in an address that no longer has one. The person is
told their link will not open, asks for another, and the replacement is built
correctly, sent correctly and fails identically.

So `servePage()` in `src/index.js` follows any redirect the assets binding
returns *internally* and hands back the page, at the address the person
actually opened. Off-site redirects are not chased and a loop stops after four
hops. If nothing redirects, nothing changes.

The page has its own half of this. It takes the token from the segment *after*
`/i/` rather than from the end of the address, so it survives any prefix — and,
more to the point, an address with no `/i/` in it yields no token at all rather
than the word `invite`. That distinction is the difference between telling
somebody their address lost its code and telling them their link expired.

#### The site address, and why it is only ever an origin

Every link the property sends — `/i/<token>` here, `/s/<token>` for a letter
out for signature, `/#/att-today` in a notification — is this address with a
path stuck on the end. The address comes from **Users & data → Notifications**,
which is a text box somebody typed into once, and what gets typed into a box
like that is whatever was in the address bar at the time.

A path left in it does not fail loudly, which is what makes it worth a section.
`https://staff.niceoperation.com/i` produces `/i/i/<token>`. That link serves
the page perfectly, the page runs, and only the API call underneath it lands on
nothing — so the person holding a link that is minutes old is told it has
expired, and asks for another one built exactly the same way.

So the setting is reduced to an origin in one place, `src/lib/site.js`, on the
way in and on the way out: parsed, host kept, everything else discarded, `https`
assumed when no scheme was typed. The Notifications screen shows the origin
rather than what is stored, because a box still displaying the path invites
somebody to decide the setting is fine and go looking elsewhere. And the deploy
prints it into the run summary next to the row counts, since it is the address
of a public web page and one glance rules it out.

The two public pages take the token from the **last** segment of the address
rather than by stripping the prefix off the front. That is deliberate belt and
braces: links already sent cannot be reissued — only a hash of each one is
stored — so a fix that only corrected future links would leave every outstanding
one dead.

### What is held, and who may read it

Personal details, address and GhanaPost GPS, identification (Ghana Card, SSNIT,
TIN), how they are paid, what a first-aider would need, emergency contacts and
next of kin, education, previous employment, and scanned documents.

Two permissions. **Employee records** reads the file with the private numbers
masked — `•••• 4321` rather than blank, so a supervisor can see that a bank
account is on file without reading it. **Manage employee records** unmasks them,
edits the file, sends links, accepts submissions and issues contracts. Managers
get both by default; the rota planner gets neither.

Scans live in the database rather than a separate bucket — one binding, one
backup. The browser shrinks a photograph before sending it, so a picture of a
Ghana Card taken on a phone is fine; anything still over the row limit is
refused with the size in the message rather than truncated.

### The standard set, and what a file must contain

**People → Templates → Load the standard set** puts in ten documents written
from the statutes that apply to a hotel in Ghana:

| Document | Built from |
|---|---|
| Contract of employment — permanent | Act 651 ss.10–13, 17, 20, 33, 57, 63, 65 |
| Contract of employment — fixed term | The same, ending on its own date |
| Terms of engagement — casual worker | Act 651 ss.74–77 |
| Written statement of particulars | Act 651 s.13 — the two-month statement |
| Confirmation after probation | A letter, because silence is not confirmation |
| Handbook and house rules | What the contract means when it refers to them |
| Confidentiality and guest privacy | Stands alone, so it can go to a contractor too |
| Personal data notice and consent | Data Protection Act 2012 (Act 843) |
| Health, safety and food hygiene | Act 651 ss.118–119, Public Health Act 2012 (Act 851) |
| Next of kin declaration | The page nobody reads until the worst day |

They come in as ordinary templates. Edit them into your own words and loading
the set again never touches them — it only adds what is missing, matched on the
code each came in under.

> **A starting point, not legal advice.** No Ghanaian lawyer has settled these.
> They exist so a small hotel starts from something with the statutory
> particulars in it rather than from an empty box, which is the realistic
> alternative and a far worse one. Have somebody who knows Ghanaian employment
> law read them before issuing any of it. A new Labour Bill is expected to
> replace Act 651 — 14 weeks' maternity leave, paternity and compassionate
> leave, notice to end a probation, a workplace policy on harassment — and when
> it passes these need revisiting. Contracts already signed keep their own words
> and are unaffected.

**Each person's Documents tab carries a checklist** of what ought to be in their
file, worked out for that person rather than shown to everybody: Ghana Card,
SSNIT, photograph, certificates, a reference or police report, and the signed
contract, handbook, data consent and next-of-kin form. Two are conditional —
a **food handler's health certificate** for anybody in a food department, which
Act 851 requires to be renewed yearly, and a **work and residence permit** for a
worker who is not Ghanaian. A blank nationality demands nothing; assuming
somebody is foreign because a field is empty is the wrong default.

An expired certificate counts as missing, because that is what it is worth to an
inspector. One inside thirty days of running out is flagged before it does.

### Contracts, signed on a phone

A **template** is the words with `{{placeholders}}` in them. Issuing one copies
the words out and freezes them against a person — editing the template next year
cannot change what somebody signed last year, which is the property that makes
templates safe to edit at all. Most placeholders come from the record; a few
(remuneration, hours, notice, probation) are typed in at the moment of issue.

The employee opens the link, reads the whole document — the signing controls sit
below the text, so reaching them means scrolling past it — ticks a box saying
they agree to sign electronically, and signs with a finger or types their full
name. Then somebody at the property countersigns, because a contract signed by
one side is an offer.

#### Contracts that were signed on paper

Everybody already working here signed something years ago, on paper, and for
most of the staff that is the only record of what was agreed. **File a signed
paper contract** puts the scan where a contract belongs rather than in the
general documents pile — same list, same checklist, and it asks for the date on
the paper rather than assuming today.

What it does not do is pretend the two are the same. There is no electronic
signature behind a scan and no chain of events, so the certificate for a paper
contract says what can honestly be said and no more: who signed it, when, who
filed the scan, and a SHA-256 **of the file**, which proves the scan has not
been swapped since — and says nothing about the signature on the page, which is
a question for the paper original.

Scanned contracts are often several megabytes, more than a database row will
hold, so a file is stored in pieces of 700 KB and reassembled on the way out.
The ceiling is 12 MB; 200 dpi in black and white is plenty for a contract.

#### What is recorded when somebody signs on screen

The name, the drawn mark, the server's timestamp, the network address, the
device, and the SHA-256 of the exact words that were on the screen. That hash is **rechecked every time the contract is
opened afterwards**. If the stored text no longer produces it, the screen says
so in red and says not to rely on it — which is precisely the thing a signature
is supposed to be able to prove.

> Ghana's Electronic Transactions Act 2008 (Act 772) gives an electronic
> signature the same effect as a written one where it is uniquely linked to the
> signatory and under their control, and recognises a typed name or a drawn mark
> as a simple electronic signature. The Labour Act 2003 (Act 651) requires a
> written contract where somebody is employed for six months or more, and the
> main terms in writing within two months. The starter template has those
> particulars in it. **It is a starting point and not legal advice** — have
> somebody who knows Ghanaian employment law read it before you issue it.

## Letters — the correspondence register

A hotel writes to suppliers, banks, the Labour Department and guests, and in
most small properties those letters live in a Word folder and a sent-items box.
Six months later nobody can say what was sent, when, who signed it, or whether
the reply ever came.

**Letters** answers those four, and puts the fourth first: a reply that is
overdue is the one thing a register catches that a folder never will.

### A reference, the moment it exists

`SN/FIN/2026/0041`. Four series out of the box — administration, staff,
suppliers, guests — each counting on its own and restarting in January without
anybody remembering to. A number is allocated once and **never reused**, so a
gap in the register is a question worth asking rather than a bug.

Write the letter here from a template, or upload one written in Word. Both are
ordinary entries from that point; the only difference is where the words live.

### Sending it out for signature

Name the people who have to sign, in the order they sign. Each gets a link and
a **six-character access code** to be told separately — read out on a call —
so a forwarded link on its own opens a locked door. Where an email address is
on file, the signer can have a **six-digit one-time code emailed** at the moment
of signing, which is what turns *somebody holding this link* into *somebody
holding this link and reading that mailbox*.

Only the earliest unsigned person's link is live. Anybody further down is told
plainly that it is not their turn and who is being waited on, because a letter
counter-signed before it was signed is one nobody can reason about afterwards.
Somebody copied in for information gets no link at all.

The words are fixed the moment a letter goes out. The hash of them is checked
before any signature is accepted, and a letter altered in between cannot be
signed at all.

### Signing for the property

Anybody with **Sign for the property** can sign and apply the company stamp —
and is asked for their **own password or PIN at the moment they do**, on top of
the session they already have.

> A stored signature that anybody with an unlocked phone could stamp onto a
> letter is a forgery machine, and the whole value of holding one is that it is
> not. A signature belongs to the person, not the property: nobody else can see
> it, nobody else can apply it, and there is no route in the system that hands
> one person another person's. That somebody *has* one saved is shown; what it
> looks like is not.

The **stamp** is the other way round — it belongs to the property, anybody who
may sign can apply it, and it is printed on paper that leaves the building every
week. Photograph the rubber stamp on a white sheet; the browser shrinks it.

### The chain

The event log is **hash-linked**. Each row carries the hash of the row before
it, and its own hash over that plus its own contents. Edit a row or delete one
and every hash after it stops matching, and the letter says so in red, naming
the event where the chain broke.

That is not a digital signature and does not claim to be — somebody with the
database could rewrite the whole chain from scratch. What it stops is the
realistic version: one inconvenient row quietly altered afterwards. An audit
trail that can be rewritten without trace is not an audit trail.

Everything is on the chain: drafted, signed for the property, sent for
signature, opened, wrong access code entered, one-time code emailed, signed,
refused, dispatched, closed — each with a UTC timestamp, the actor, and the
network address.

### Who can do what

| Permission | Reaches |
|---|---|
| **Letters** | Read the register and what has been sent |
| **Write letters** | Draft, send for signature, record dispatch, file replies, keep the address book |
| **Sign for the property** | Sign a letter and apply the stamp — with the signer's own password or PIN each time |

Drafting and signing are separate on purpose: whoever writes a letter is not
necessarily whoever signs it. Managers get the first two by default.

## Who can see what

Eleven permissions, so a supervisor settling this morning's missing clock-outs
never sees a leave balance and whoever draws up the rota never sees anybody's
bank account:

| Permission | Reaches |
|---|---|
| **Attendance today** | Who clocked in, and what needs dealing with |
| **Attendance reports** | Days worked, hours, lateness, leave balances, exports |
| **Rota & leave requests** | Set the rota and put leave in for people. No approvals, no balances |
| **Correct clock times** | Put a wrong or missing clock-in or clock-out right. Every change recorded, administrators told |
| **Sign off attendance** | Close a day, week, month or any set of days off and move the days. Still no balances |
| **Rota & decisions** | Set the rota, settle incomplete days, approve leave |
| **Attendance setup** | Staff, shifts, absence reasons, holidays, terminals, rules |
| **Employee records** | Read personal details, contacts and contracts. Private numbers stay masked |
| **Manage employee records** | Edit records, send links, accept what people send in, issue and sign contracts |
| **Recruitment** | See the vacancies, who has applied, the interview diary and what was decided. Changes nothing |
| **Run the recruitment** | Open vacancies, add candidates, publish interview times, make a candidate's link, score an interview, move people along. Taking somebody on needs attendance setup as well |
| **Letters** | Read the correspondence register |
| **Write letters** | Draft letters, send them for signature, keep the address book |
| **Sign for the property** | Sign a letter and apply the company stamp |

Five roles built from them — Rota planner, Supervisor, Manager, Reports only,
Administrator — and any individual can be adjusted off their role's defaults.

**Rota planner** is the narrowest of them: builds next week's rota, sets standing
patterns and rotations, and puts leave in for people — where it waits for
somebody else to approve it. They also read the **Month** tab, because knowing
who was absent and who is over their hours is how next week's rota gets built —
but the *Leave left* column is not on it and the export is not offered them. The
column is not hidden by the screen: `overview` does not compute a balance for
anybody without the reports permission, so opening the endpoint directly returns
rows with nothing where it would have been. They cannot grant leave (including their own),
cannot settle a missing clock-out, and cannot see how much leave anybody has
left. They *can* put a wrong clock time right — see below — because they are the
people who notice. That last one is the point of the role: whoever draws up the
rota does not need to know who is running out of days, and a rota built around
that knowledge is a rota built around the wrong thing.

**Correct clock times** *is* part of the planner's defaults, and is deliberately
smaller than settling a day. It answers one question — when did this person
actually arrive and leave — and nothing else. It cannot choose a reason, cannot
mark anybody present or absent, and cannot approve a thing; the rules read the
corrected times and work the verdict out again from them, so the hours, the
lateness and the overtime all follow on their own.

The reason it exists as its own permission is practical. The person who knows
the kitchen ran until nine is the person building the rota, not the person who
approves leave, and a correction that has to be relayed through somebody else is
a correction that does not get made.

**A correction is a request, not a change.** Anybody without *Attendance setup*
raises one and nothing happens to the day: `att_days` is untouched, the figures
stay exactly as the terminal left them, and the request waits. That matters most
on the sign-off screen, where a period could otherwise be closed against a figure
somebody has already said is wrong — so a day with a change pending says so on
its own row, on the person's report, and on the sign-off list.

**Approving applies the times and settles the day**, in that order and for a
reason. The corrected times go on, the day is recomputed from them, and *then*
the verdict the rules reached is written down as settled under the approver's
name. The administrator is not asked to type a status; they are approving two
clock times, and what follows from them is worked out rather than chosen. A day
two people have now looked at should not still be sitting on somebody's list.
Sending one back changes nothing at all and requires a reason, because "no" on
its own tells whoever asked nothing about what to do instead.

Two things are deliberately left alone by an approval. A ruling somebody else
made — a Tuesday a supervisor decided was sick leave — keeps its reason; the
times go on and the hours follow, but the verdict stays theirs. And clearing both
boxes is a correction *withdrawn*, not a day settled: the day goes back to what
the terminal saw and reopens.

An administrator's own correction applies and settles immediately. A queue with
one name in it teaches everybody to press the button without reading it.

**The day is one press away before the decision, not after it.** A waiting row
says what somebody typed and what the terminal read, and nothing about whether
the shift was even that person's, or whether the same thing happened the day
before. So *Record* sits on every waiting row and again inside the approve box,
where it opens in its own tab — the moment somebody is about to settle a day on
another person's account of it is exactly the moment they should be able to look
at the day, and looking should not cost them the note they have started typing.

What makes the permission safe to hand out is not that it is restricted but that
it is impossible to use quietly: every change is written to `att_time_edit` with
what stood before it, what the terminal itself read, who made it, why, from which
address, who answered and what they said. The register is on the sign-off screen
under **Clock changes** — waiting requests at the top, applied ones below — and
the same trail prints on the bottom of the person's own report, where the person
whose hours were changed can read it.

Settling a day still supplies clock times too, and those land in the same
register — a register that recorded corrections made through one door and stayed
silent about the other would be worse than none. Those apply immediately: a
supervisor settling a day is already making the decision an approval would ask
for.

The punches themselves are never touched by any of this. `att_punches` is what
the terminal saw and stays what the terminal saw; a correction is an opinion
recorded beside it.

**Where the buttons appear.** Settle and Times are offered only against days with
something wrong with them — absent, late, left early, a clock-in or clock-out the
terminal never completed, or a day already ruled on — and on the sign-off list
against days carrying an issue. A column of buttons beside twenty-eight ordinary
days is a column nobody reads, and the four that matter are lost in it. The one
case this hides is a day that looks perfectly ordinary and is not: the terminal
read somebody out at 17:02 and the kitchen ran until nine. **Show buttons on
every day** on the person's report reaches those.

**What the terminal sent.** A day that reads *Absent* has two very different
causes behind it and, until now, one appearance. Either nothing arrived — the
terminal recorded nothing, or it recorded something and has not sent it yet — or
something arrived and was not counted, because it came in under a number that no
longer matches anybody. Nowhere in the app could you tell those apart, so every
argument about a missing clock-in came down to whose memory to believe.

The bottom of a person's report now lists the raw punches for the range: the
time, whether it was read as in or out, which terminal serial sent it, the number
it came in under, and whether it is attached to that person or floating. It is
matched on the number as well as the person, so a punch that belongs to nobody
is still shown against the number that made it, with a warning saying so. The
day either side of the range is included, because a night shift's clock-out
lands on tomorrow.

When there is nothing at all, it says so in those words rather than showing an
empty table, since an empty table reads as a bug.

This is the terminal's own record, not a summary of it: no rounding, no shift,
no verdict. If the punch is on this list and the day still says absent, the fault
is in how the day was worked out. If it is not on the list, the punch never
reached us.

**Sign off attendance** is deliberately separate and is not part of the planner's
defaults. Tick it for whoever draws up the rota and they can close a day, a week
or a month off and move the days against people's leave — while still never
being shown how much leave anybody has left. That is not a screen that hides the
number: the report endpoint strips the balance out of its answer for anybody
without the reports permission, because the menu is a courtesy and the API is the
gate.

**Employee records** splits the same way and for the same reason. The read-only
half shows that a bank account is on file as `•••• 4321` rather than hiding the
field, because an empty space has somebody chasing a number that is already
there. Only *Manage employee records* unmasks it, and only that permission can
open a scanned ID — reading a photograph of a Ghana Card is reading the number
on it. Managers hold both by default. The rota planner holds neither.

Reports-only never gets it. That role exists to change nothing, and signing off
moves leave.

Holding a larger permission carries the smaller one, so a supervisor or manager
keeps the rota and the sign-off without anybody having to tick three boxes. The route table is
tested against every role, because a permission granted by accident does not
throw, does not log, and is only noticed once somebody has seen something they
should not have.

Note that **a login and a member of staff are different things**. Almost nobody
who clocks in has a login; a room attendant has a face on a terminal and no
reason to ever open this. The two are linked where the same human is both.

---

## Setup

All of it happens in a browser. Two tabs — Cloudflare and GitHub — and no
software on anybody's computer. Pushing to `main` runs the tests, applies any
database changes and publishes, so looking after it later is the same browser
and the same two tabs.

### 1. Create the database

Cloudflare dashboard → **Storage & Databases → D1 → Create**. Name it
`attendance`.

Copy the **Database ID** it shows you.

### 2. Put that ID into the settings file

On GitHub, open `wrangler.toml`, press the pencil to edit it, and replace
`REPLACE_WITH_YOUR_D1_DATABASE_ID` with the ID you just copied. Commit straight
to `main`.

### 3. Make a Cloudflare API token

Cloudflare dashboard → **My Profile → API Tokens → Create Token**, starting from
the **Edit Cloudflare Workers** template. Add **D1 → Edit** to its permissions
before you save, and include the zone for your domain so it can attach the
custom address.

Copy the token — it is shown once. You also need your **Account ID**, which is
on the right of any Workers page in the dashboard.

### 4. Give them to GitHub

Repository → **Settings → Secrets and variables → Actions → New repository
secret**. Add two:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 3 |
| `CLOUDFLARE_ACCOUNT_ID` | your account ID |

### 5. Publish it

Repository → **Actions → Test & Deploy → Run workflow**.

It runs the tests, creates the tables, and publishes. Three or four minutes. The
run summary at the end prints what ended up in the database, so you can see the
tables exist rather than hoping.

From now on this happens on its own whenever anything is committed to `main`.

### 6. Set the app's secrets

The Worker exists now, so it can hold secrets. Add them the same way you added
the Cloudflare credentials — repository → **Settings → Secrets and variables →
Actions → New repository secret**:

| Name | Value |
|---|---|
| `APP_SESSION_SECRET` | forty or more random characters. Never needs remembering. |
| `APP_MANAGER_PIN` | six digits — your way in before any accounts exist, and your way back in if everybody is ever locked out. **Write it down.** |
| `APP_RESEND_API_KEY` | only if you want the morning email digest |
| `APP_SMS_API_KEY` | only if you want texts. The API key from Arkesel, mNotify or Hubtel |
| `APP_SMS_API_SECRET` | Hubtel only. The other two need just the key |

Then **Actions → Set the app's secrets → Run workflow**. It copies them onto the
Worker and lists the names it set. Run it again any time you change one.

> They go through GitHub rather than being typed into Cloudflare's dashboard for
> two reasons: that dashboard moves the Variables and Secrets section between
> versions, and a value typed into a workflow form stays readable in the run
> afterwards. A repository secret is neither.
>
> The Cloudflare route still works if you prefer it — **Workers & Pages →
> niceoperation-attendance → Settings → Variables and Secrets**, adding each with
> the **Type** dropdown set to *Secret* rather than *Text*. Drop the `APP_`
> prefix there: the Worker wants `SESSION_SECRET`, not `APP_SESSION_SECRET`.

**staff.niceoperation.com** should now open. If the address does not work, the
domain is probably not on this Cloudflare account — add it there first, or
attach the address by hand under the Worker's **Domains & Routes**.

### 6b. Make your own administrator account

Open the site and sign in with the `MANAGER_PIN` from step 6 — there are no
accounts yet, so that is the only way in.

**Users & data → People → Add somebody**, role **Administrator**, your email and
a real password. Sign out, sign back in as yourself, and put the emergency PIN
in a drawer.

### 7. The terminal

**On the terminal itself.** Give it a fixed address on your network, set its
clock and time zone with NTP on, and make sure it can reach the internet. Its
clock is where every time in this system comes from; if it drifts, the reports
drift with it.

**In the app.** Setup → Terminals → *Register a terminal*. Leave the first
question on **“The terminal posts to us”**. Enter the serial exactly as the
device reports it under System → Device Information.

The app then shows you a small table of settings and a URL. Copy them into the
terminal's own web page, under **Network → Advanced Settings → HTTP Listening**
(some firmware puts it under **Event**). Press **Test** there, come back to
Setup → Terminals, and it should say the terminal was heard from just now.

That is the whole installation. Nothing runs on site, nothing needs restarting
after a power cut, and there is no computer for anybody to maintain.

> The URL contains that terminal's token, so treat it like a password. It is
> readable once, when you register. Lose it and you press *New token*; the old
> one stops working immediately.

**What this mode costs you.** One attempt per tap. If your internet is down at
07:03, that tap does not arrive — it stays in the terminal's own log, but
nothing here will go and fetch it. For most properties that is a fair trade
against having a machine to look after. If it is not, read on.

#### The other way, if you would rather not lose a tap

A small reader program can run on any always-on computer on the same network and
ask the terminal for its log every five minutes, over a window that overlaps the
last one — so an outage costs nothing, because the next successful run catches
up.

Choose **“A reader program on site fetches from it”** when registering, then on
that computer:

```bash
cp .hik-poller.json.example .hik-poller.json
# Fill in the terminal's address and password, this app's URL,
# and the serial and token from the step above.

node scripts/hik-poller.mjs --once --verbose   # check it can see both ends
node scripts/hik-poller.mjs --from 2026-01-01  # pull in the history
node scripts/hik-poller.mjs                    # then leave it running
```

It has no dependencies — one file and Node 18 or newer. Keep it alive across
reboots however that machine prefers: a systemd unit, Task Scheduler, `pm2`.

**Both at once is allowed**, and is the belt-and-braces option: the terminal
posts every tap immediately, and the reader sweeps up anything a dropped
connection lost. Punches are matched on the device's own event number, so a tap
that arrives twice is stored once.

#### Bringing in history

Pushing only starts from the moment you configure it. If you want the months the
terminal is already holding, run the reader once from any laptop on the network:

```bash
node scripts/hik-poller.mjs --from 2026-01-01
```

Then close it and never think about it again. A one-off backfill is not a
machine you have to maintain.

### 8. Then set the rest up, in this order

All under Attendance → Setup:

1. **Shifts** — check what the sync has already found for you and press to
   accept, then set the break and grace period on each. Only add one by hand if
   it is missing.
2. **Staff** — the employee number must match the terminal exactly. Anybody
   whose punches have already arrived is listed at the top of that screen;
   adding them attaches their history on the spot.
3. **Public holidays** — *Fill in this year* does the calculable ones.
4. **Rota** — set each person's usual week. From then on, most weeks are
   *Copy a week* and two corrections. This is where the rota lives from now on;
   Hik-Connect only needs the shift definitions.
5. **Rules** — what a missing punch means, and the leave entitlement.

---

## Day to day

**Every morning, a supervisor** opens **Today** and clears the "waiting on a
decision" list. Usually two or three people who forgot to clock out; each takes a
few seconds. Left undone, those days stay uncounted and the month's hours are
wrong.

**Once a week**, open **Rota**, press *Copy a week*, and fix whatever differs.
Do it before the week starts rather than after: "late" is measured against the
shift somebody was rostered on, so a swap recorded on Friday makes Monday to
Thursday read wrong until it is. Glance at the totals along the bottom before
you close it — a red zero is a shift nobody is covering.

**Monthly, for the wages**, **Month** gives days worked, hours, overtime,
absences and leave left per person, and exports as CSV.

### Getting the data out

```
/api/att/export?from=2026-07-01&to=2026-07-31
```

One row per person per day: clock times, hours, status, what the day was charged
to, whether that counts as paid and as a day worked, and who confirmed it if
anybody did. Enough for a payroll run without going back to the screen.

---

## Development

Everything above is done in a browser. This is for anybody who would rather work
locally.

```bash
npm install
npm test

# Local database, entirely separate from production:
npm run db:migrate:local
npm run dev

# And, if you prefer publishing from a terminal to letting GitHub do it:
npx wrangler login
npm run db:migrate
npm run deploy
```

No frontend build step and no runtime dependencies. `migrations/console/` holds
comment-free copies of every migration for pasting into the D1 console, which is
the third way of applying them if both of the above are inconvenient.

### Layout

```
src/
  index.js            Worker entry: routing, auth endpoints, the daily tick
  lib/
    attendance.js     Punches to days, statuses, notes, leave, holidays — pure
    attendance-ingest.js
                      The terminal feed, and keeping derived days in step
    device-shifts.js  Reading shifts off the terminal, and inferring them from
                      the punches when it has none to give
    push-events.js    Unwrapping what the terminal posts — JSON, XML or
                      multipart, all ending as the same punch
    roster-import.js  Reading a week's rota out of the scheduling CSV, and
                      saying what each line would do before anything is done
    roster-pdf.js     The same, off a printed schedule: dates across the top
                      give the columns, names down the side give the rows
    people.js         What a record is made of, declared once: the office
                      form, the phone form, the difference between what
                      somebody sent and what is on file, what is still
                      missing, and what a supervisor may not read
    ghana-templates.js
                      The standard contracts, letters and acknowledgements,
                      and the list of what belongs in a personnel file — with
                      the statute each is built from named beside it
    correspondence.js Letter references, the hash-linked event chain, and
                      whose turn it is to sign
    signoff.js        What a sign-off actually signed, what is still
                      outstanding, and what is wrong with a period
    files.js          Holding a file in a database that will not take one
                      whole: splitting it into pieces and putting it back
    pdf-text.js       Every word in a PDF and the point it was drawn at.
                      Objects, object streams, inflate, text operators — and
                      nothing else, because a rota is names, dates and times
    auth.js           PIN and password login, signed session cookies
    permissions.js    Who can reach what
    notices.js        The bell
    notify.js         The morning digest: email and push
    push.js           Web Push plumbing (VAPID, payload encryption)
    http.js           JSON responses, input validation
  routes/             API handlers. Each feature that reaches outside the
                      building is split in two: people.js/invite.js for the
                      staff records, correspondence.js/sign.js for the letter
                      register. The public half of each shares nothing with
                      its office half but the database, because it is reached
                      by anybody holding a link
  util/dates.js       Day arithmetic
public/               Frontend — plain ES modules, no build step
migrations/           Database schema (console/ holds paste-able copies)
scripts/
  hik-poller.mjs      Optional: reads the terminal over ISAPI from on site,
                      for backfilling history or for outage-proof collection
test/                 Rules, the write path against real SQLite, and the poller
```

### Where the logic lives

`src/lib/attendance.js` is pure functions over plain rows — nothing reads the
database and nothing writes to it. That is what makes the rules testable, and
these rules are the part that has to be right, because they decide whether
somebody is paid for Tuesday. `test/attendance.test.js` covers them without a
database at all.

`test/attendance-db.test.js` runs the migrations into SQLite and drives the real
handlers, because three things only fail in SQL: the idempotent insert, the
upsert that must not overturn a supervisor's ruling, and punches that arrive
before the person exists.

---

## The group's numbers, all four systems at once

There is a second application in this repository, in `bi/`, and it is not part
of HIVE: it is a separate Worker with its own database that *reads* this one.

The group runs four pieces of software — this, the breakfast and housekeeping
app, the restaurant POS and the laundry — and none of them can see any of the
others. `bi/` reads all four every night, puts them in one warehouse where a
day and a cedi mean the same thing in all of them, and answers the questions
that need two systems at once: whether the wage bill is rising faster than the
work, which of the guests in house are actually eating in, whether the bed
checks get missed on exactly the days somebody was absent, and whether the same
supplier charges the kitchen and the restaurant two different prices.

It reads HIVE's database directly through a second binding. Nothing in it
writes here, and it deploys on its own, so a reporting layer can never take
down the app people clock in on. See [bi/README.md](bi/README.md).

### Arriving here already signed in

That app is also the group's front door. Somebody signs in there, clicks
**HIVE** on its hub, and lands here without typing a password —
this app's `/sso` route takes the hand-off code, calls the hub back to find out
who it was for, matches them to a row in `users` by email address, and makes an
ordinary session exactly as a PIN would.

Three things it deliberately does not do. It does not trust anything in the
URL: the code carries no identity, and the name and address come back over a
server-to-server call. It does not create accounts — if the hub names somebody
with no `users` row here, they are refused, with the address in the message, so
an administrator can add them. And it does not widen anybody: the role the hub
sends is ignored, and what somebody may do here is what their own row says.

It is off unless configured. Two secrets switch it on:

```bash
wrangler secret put INSIGHT_SSO_URL      # https://<insight>/api/sso/redeem
wrangler secret put INSIGHT_SSO_SECRET   # the same value as SSO_SECRET_ATTENDANCE there
```

One more is optional, and switches on the address box that finds real places:

```bash
wrangler secret put GOOGLE_MAPS_KEY      # a project with Places API (New) and billing on
```

Without it every address box is an ordinary line of text, which is what they
all were before. It can also be pasted in under **Setup → Rules** by anybody
who would rather not deploy to change it; the secret wins where both exist.

Without them `/sso` says so rather than failing blank, and PIN and password
sign-in are unaffected either way. The protocol is in
[bi/docs/sso.md](bi/docs/sso.md); the code is `src/lib/sso-consumer.js`.


## Notes and limits

- **A punch is a fact; a day is an opinion.** See the top of this file. Every
  derived figure is recomputed whenever the rota, the leave book or the rules
  change.
- **A missing punch is not evidence of anything.** Auto-close credits the
  scheduled shift and never a minute more: somebody who forgot to clock out gets
  their hours, not the overtime they might have worked.
- **A supervisor's ruling outranks the terminal.** Once somebody has confirmed a
  day, punches arriving afterwards refresh the times on the record but never
  overturn the verdict. Both are shown side by side, so what was observed and
  what was decided can always be told apart.
- **Attendance is only as complete as the staff list.** Somebody enrolled on the
  terminal but never added here is invisible in every report. Their punches are
  kept and attach the moment they are added, and unrecognised employee numbers
  are listed on the Staff setup screen — but nothing chases you.
- **The device clock is the source of truth for time.** Set the terminal's
  timezone and turn NTP on. A device that drifts produces punches that are wrong
  here too, and no amount of care at this end will fix it.
- **A pushed tap is one attempt.** If the internet is down when somebody clocks
  in, that tap does not arrive. It is still in the terminal's own log, and a
  one-off run of the reader program will fetch it, but nothing does that on your
  behalf. Run the reader alongside if a lost tap matters more than a machine to
  maintain.
- **Silence means different things in the two modes.** A reader that has not
  called in for an hour is broken; a pushing terminal that has said nothing for
  an hour on a Sunday is a terminal nobody has walked past. The Terminals screen
  colours them differently for exactly that reason.
- **The push URL is a password.** It carries the terminal's token, which is what
  authorises punches under that terminal's serial. It is shown once. Anybody who
  has it can post fabricated attendance, so treat it accordingly — and press
  *New token* if it ever ends up somewhere it should not be.
- **Timezone matters.** The `timezone` setting decides which calendar day a punch
  belongs to. Set it before the terminal starts sending, because changing it
  later moves days across boundaries.
- **The leave defaults are Ghana's statutory floor, not legal advice.** Fifteen
  working days after twelve months' continuous service. A property may be more
  generous, and the figure is a setting. Check your own obligations rather than
  taking a default as compliance.
- **A suggested shift is a suggestion.** The terminal's bands are the times a
  tap is *accepted* between, not the hour anybody is due — a 06:00 shift
  typically accepts clock-ins from 05:00. That is why the punches outrank them,
  and why nothing is applied without somebody pressing a button.
- **Eid is not calculated.** Both Eids follow the lunar calendar and are
  confirmed locally days ahead. Filling in a year adds everything else.
- **Retired, not deleted.** Somebody who leaves keeps their history — set a
  leaving date rather than removing them, or the months you have already
  reported on go with them. The same applies to a shift that has ever been
  worked.
- **Every decision is attributed.** Confirmations, rota changes, leave decisions
  and changes to what an absence costs all record who did them, and changes to
  costs record the old values beside the new. The audit trail under Users & data
  is the full record.
- **Two ways to sign in, chosen by role.** A PIN is right for a supervisor
  holding a phone in a corridor. It is not right for an account that can erase
  data, so administrators use an email address and a password.
- **Password stretching happens in the browser, not on the server.** A Worker
  gets 10ms of CPU per request on Cloudflare's free plan; 600,000 PBKDF2 rounds
  costs roughly 90ms. So the browser derives a key (PBKDF2-SHA256, 600k rounds,
  per-password salt) and the server keeps a peppered HMAC of that key. An
  attacker with the whole database still has to run the full 600,000 rounds per
  guess, and the raw password never leaves the browser.
- **One alert a morning, and only when something needs doing.** An alert for
  every late arrival would be a dozen a day, everybody would learn to swipe them
  away, and the one that mattered would go with the rest.
