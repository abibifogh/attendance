# Staff Attendance

Attendance, rota and leave for a hotel, read from the Hikvision face terminal at
the staff entrance.

The terminal knows one thing, and knows it very well: that a face was recognised
at 07:03. Everything a manager actually wants is downstream of that — was 07:03
late, is a missing evening tap an absence or a forgotten one, how many days has
this person worked this month, and how much leave is left. None of that lives on
the device. This is the part that turns the one into the other.

Runs entirely on Cloudflare: a Worker serves both the app and the API, with a D1
(SQLite) database behind it. Served at **staff.niceoperation.com**.

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

### Reports

| Screen | What it answers |
|---|---|
| **Person, any period** | The slip that gets handed over. A plain-English line at the top saying what happened and what to do differently, the clock times under it as evidence, and the leave balance beside it. Prints as a PDF. |
| **Week** | Names down the side, Monday to Sunday across. Finds the pattern a daily list hides — the person late three Mondays running, the section short every weekend. |
| **Month** | Days worked, hours, overtime, absences, leave taken and leave left, per person. The sheet that goes to whoever does the wages. Exports as CSV. |

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

**The leave box is left off the printout.** A slip handed to one person is read
by whoever is standing next to them, and how much leave they have left is nobody
else's business — so it stays on screen and there is a tick box to put it on
paper when it belongs there. Where a signed-off month has added or taken days,
that shows as its own tile — *Days charged* or *Days given back* — with a line
saying which months it came from. A balance that quietly differs from the
entitlement is the kind of thing people notice on payday.

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
  overrides and the distinction below would be gone by Wednesday.
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

## Who can see what

Six permissions, so a supervisor settling this morning's missing clock-outs
never sees a leave balance:

| Permission | Reaches |
|---|---|
| **Attendance today** | Who clocked in, and what needs dealing with |
| **Attendance reports** | Days worked, hours, lateness, leave balances, exports |
| **Rota & leave requests** | Set the rota and put leave in for people. No approvals, no balances |
| **Sign off attendance** | Close a day, week or month off and move the days. Still no balances |
| **Rota & decisions** | Set the rota, settle incomplete days, approve leave |
| **Attendance setup** | Staff, shifts, absence reasons, holidays, terminals, rules |

Five roles built from them — Rota planner, Supervisor, Manager, Reports only,
Administrator — and any individual can be adjusted off their role's defaults.

**Rota planner** is the narrowest of them: builds next week's rota, sets standing
patterns and rotations, and puts leave in for people — where it waits for
somebody else to approve it. They cannot grant leave (including their own),
cannot settle a missing clock-out, and cannot see how much leave anybody has
left. That last one is the point of the role: whoever draws up the rota does not
need to know who is running out of days, and a rota built around that knowledge
is a rota built around the wrong thing.

**Sign off attendance** is deliberately separate and is not part of the planner's
defaults. Tick it for whoever draws up the rota and they can close a day, a week
or a month off and move the days against people's leave — while still never
being shown how much leave anybody has left. That is not a screen that hides the
number: the report endpoint strips the balance out of its answer for anybody
without the reports permission, because the menu is a courtesy and the API is the
gate.

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
    auth.js           PIN and password login, signed session cookies
    permissions.js    Who can reach what
    notices.js        The bell
    notify.js         The morning digest: email and push
    push.js           Web Push plumbing (VAPID, payload encryption)
    http.js           JSON responses, input validation
  routes/             API handlers
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
