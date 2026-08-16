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

### The rota

Two layers. A **standing weekly pattern** per person, set once — most people
never need anything else. A **per-day override** for swaps, cover and one-off
doubles.

A cell following the pattern is faint; one set by hand is not. Without that,
"I gave him Thursday off" and "the pattern never had him working Thursday" look
identical, and they are not — one of them is a decision somebody made.

Night shifts belong to the day they *start*, so a porter's 06:04 clock-out is
not the breakfast cook arriving four minutes late.

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

### Nobody goes missing

An employee number the terminal sends that nobody here recognises is listed on
the setup screen with its punch count. The punches are kept, and attach
themselves the moment the person is added.

---

## Who can see what

Four permissions, so a supervisor settling this morning's missing clock-outs
never sees a leave balance:

| Permission | Reaches |
|---|---|
| **Attendance today** | Who clocked in, and what needs dealing with |
| **Attendance reports** | Days worked, hours, lateness, leave balances, exports |
| **Rota & decisions** | Set the rota, settle incomplete days, approve leave |
| **Attendance setup** | Staff, shifts, absence reasons, holidays, terminals, rules |

Four roles built from them — Supervisor, Manager, Reports only, Administrator —
and any individual can be adjusted off their role's defaults.

Note that **a login and a member of staff are different things**. Almost nobody
who clocks in has a login; a room attendant has a face on a terminal and no
reason to ever open this. The two are linked where the same human is both.

---

## Setup

### 1. Prerequisites

A Cloudflare account, Node 18 or newer, and `npx wrangler login`.

### 2. Create the database

```bash
npm install
npm run db:create
```

Copy the `database_id` it prints into `wrangler.toml`.

### 3. Create the tables

```bash
npm run db:migrate
```

Or paste `migrations/console/*.sql` into the D1 console in order. Those are
comment-free copies for exactly that — the console rejects a paste whose first
statement is a comment.

### 4. Set the secrets

```bash
# A long random string. Rotating it signs everybody out.
npx wrangler secret put SESSION_SECRET

# Optional but wise: the emergency way back in if every account is locked out.
npx wrangler secret put MANAGER_PIN

# Only if you want the morning email digest.
npx wrangler secret put RESEND_API_KEY
```

### 5. Deploy, and point the domain at it

```bash
npm run deploy
```

`wrangler.toml` already claims `staff.niceoperation.com` as a custom domain. The
zone has to be on the same Cloudflare account; Wrangler creates the DNS record.

### 6. Make the first administrator

With no users in the database, sign in with the `MANAGER_PIN` you set above,
then **Users & data → Add somebody** and create a real administrator account.

### 7. The terminal

**On the terminal.** Give it a fixed address on your network, set its clock and
timezone with NTP on, and make sure the account the poller will use can read the
access-control event log.

If you configure shifts on the device or in Hik-Connect, its events arrive
already labelled as clock-ins and clock-outs, which makes this app's job easier.
It is not required — direction is worked out from the shift when the labels are
absent — but it is free accuracy if you are doing it anyway.

**In the app.** Attendance → Setup → Terminals → *Register a terminal*. Enter the
serial exactly as the device reports it, and copy the token it shows you. That is
the only time it is readable.

**On the machine that will run the poller.** Node 18 or newer, and either a
checkout of this repository or just the one file, `scripts/hik-poller.mjs`, which
has no dependencies at all.

```bash
cp .hik-poller.json.example .hik-poller.json
# Fill in the terminal's address and password, this app's URL,
# and the serial and token from the step above.

# Check it can see both ends. Prints the model, firmware and serial.
node scripts/hik-poller.mjs --once --verbose

# Pull in the history the terminal is already holding.
node scripts/hik-poller.mjs --from 2026-01-01

# Then leave it running. Polls every five minutes.
node scripts/hik-poller.mjs
```

Keep it alive across reboots however that machine prefers — a systemd unit, Task
Scheduler, `pm2`. It does not matter if it stops for a while: each pass asks for
a window that overlaps the last one, so the next successful run picks up whatever
was missed, and duplicates are discarded on arrival by the device's own event
serial.

**Why a poller at all.** This app runs on Cloudflare and the terminal sits on a
private network with no public address, so nothing in the cloud can reach it. The
alternative is putting an access-control terminal on the open internet, which is
not worth the convenience for a device family with this one's CVE history.

The ingest endpoint is source-agnostic: it takes a batch of normalised punches
with a source tag and a dedupe key and does not care who sent them. The ISAPI
poller is one adapter. The device's own HTTP push is another. A Hik-Connect
adapter — should you get a Technology Partner Program key and confirm your model
does cloud attendance — would be a third, and nothing downstream would change.

### 8. Then set the rest up, in this order

All under Attendance → Setup:

1. **Shifts** — the two or three your rota actually uses. A shift is a name, a
   start, an end, and how much lateness you are prepared to overlook.
2. **Staff** — the employee number must match the terminal exactly. Anybody
   whose punches have already arrived is listed at the top of that screen;
   adding them attaches their history on the spot.
3. **Public holidays** — *Fill in this year* does the calculable ones.
4. **Rota** — set each person's usual week; override individual days as they come.
5. **Rules** — what a missing punch means, and the leave entitlement.

---

## Day to day

**Every morning, a supervisor** opens **Today** and clears the "waiting on a
decision" list. Usually two or three people who forgot to clock out; each takes a
few seconds. Left undone, those days stay uncounted and the month's hours are
wrong.

**When the rota changes**, set it before the week starts rather than after.
"Late" is measured against the shift somebody was rostered on, so a swap recorded
on Friday makes Monday to Thursday read wrong until it is.

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

```bash
npm install
npm test

# Local database, entirely separate from production:
npm run db:migrate:local
npm run dev
```

No frontend build step and no runtime dependencies.

### Layout

```
src/
  index.js            Worker entry: routing, auth endpoints, the daily tick
  lib/
    attendance.js     Punches to days, statuses, notes, leave, holidays — pure
    attendance-ingest.js
                      The terminal feed, and keeping derived days in step
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
  hik-poller.mjs      Reads the terminal over ISAPI, runs on site
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
- **Timezone matters.** The `timezone` setting decides which calendar day a punch
  belongs to. Set it before the terminal starts sending, because changing it
  later moves days across boundaries.
- **The leave defaults are Ghana's statutory floor, not legal advice.** Fifteen
  working days after twelve months' continuous service. A property may be more
  generous, and the figure is a setting. Check your own obligations rather than
  taking a default as compliance.
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
