# Insight

The group runs four pieces of software. None of them can see any of the others.

**Attendance** knows who walked through the staff entrance and when.
**Breakfast** knows how many guests are in the house and what the kitchen
bought. The **POS** knows what the restaurant sold and what the till was out
by. The **laundry** knows what was charged and what was actually collected.

Each one answers its own question well. Between them sit the questions nobody
can ask, because asking them means holding two systems' numbers at once:

- Is the wage bill going up because the hotel is busier, or is it just going up?
- The restaurant's takings fell. Did fewer guests stay, or did fewer of the
  guests who stayed eat in?
- Housekeeping keeps missing rounds. Is that on the days somebody was absent?
- The kitchen and the restaurant both buy tomatoes. Do they pay the same price?
- The till was short on Tuesday. Who was actually on the premises?

This reads all four every night, puts them in one warehouse where a day means
the same thing in all of them, and answers those questions on a page.

---

## The one idea worth knowing

Every number here is the same shape: **a day, a part of the business, and a
figure in whole pesewas.**

That sounds like an implementation detail. It is the whole design. Four systems
disagree about almost everything — one calls it a venue and another a module,
one sends money as `4500` and another as `45.00`, one thinks a day ends at
midnight UTC and another when the night shift goes home. Once every row has
been forced into the same day, the same eight business lines and the same
integer pesewa, questions that used to require a person with two screens and a
calculator become one line of SQL.

Everything else in here is either the work of getting a source into that shape,
or the work of asking a question once it is.

---

## What it does

### The brief

One screen, opened in the morning. A single number — contribution across the
whole group — six tiles with how each has moved against the period before, and
the findings ranked by what they are worth a month.

Not by how alarming they sound. A critical-sounding note worth nothing must not
sit above a quiet one worth two thousand cedis a month, because the person
reading has ten minutes and reads from the top.

### Findings

A finding is a sentence somebody can act on, the money it is worth, the systems
it drew on, and enough evidence to check it. Fifteen rules produce them. The
ones that matter are the ones that need more than one system:

| What it finds | Systems it needs |
|---|---|
| Revenue per hour worked has fallen and the hours have not | attendance + POS/laundry |
| A line spends more on wages than it takes | attendance + POS/laundry |
| Overtime is being paid on the days that are not busy | attendance + POS |
| The same supplier charges two arms of the group two prices | breakfast + POS |
| Feeding a guest costs more — and whether that is prices or portions | breakfast |
| One person's till is short far more often than anybody else's | POS + attendance |
| A till was closed on a day that person was never clocked in | POS + attendance |
| Fewer of the guests in house are using the restaurant, or the laundry | breakfast + POS + laundry |
| The rota is heavier on a weekday than the work on it | all four |
| Bed checks fall short on exactly the days somebody was absent | breakfast + attendance |
| Money charged and never collected, and whether it is getting worse | laundry |
| Beds found in a state the front desk did not expect | breakfast |
| What none of the four systems records at all | — |

That last one is not a joke and not an afterthought. **No system in the group
records what the rooms earn.** There is no property management system among
these four applications, so every group total this tool produces is understated
by the largest line in a hotel's accounts. It says so, on the same screen as
the totals, every time. A dashboard that quietly omitted it would be worse than
no dashboard, because it would be believed.

### The other screens

**Money** — contribution by line, the whole table, and the days behind it.
**Labour** — revenue per hour worked, the week as it actually runs, what each
department costs. **Guests** — everything expressed per guest night, which is
what separates "the hotel is emptier" from "we are selling to fewer of the
people who are here". **Cash** — charged, collected, still owed, and every till
close. **Buying** — group spend per supplier, and the same item bought twice at
two prices. **Service** — checks due against checks done, next to who was on.
**Setup** — where the four systems are connected, and every load that has run.

### Getting the data out

```
/api/export?from=2026-07-01&to=2026-07-31
```

One row per day per line: revenue, discounts, collected, outstanding, tender
split, orders, covers, purchases, hours, wages, contribution. The point of a
warehouse is that somebody can take it away and do something nobody here
thought of, so the export is the whole joined table rather than whichever
screen they were looking at.

---

## How it reads the four systems

Two of them are Cloudflare D1 databases in the same account as this Worker, so
they are **bound directly** — a second binding in `wrangler.toml` and a `SELECT`.
No key, no network hop, nothing to rotate, nothing to expire at three in the
morning. Nothing in this Worker writes to either of them.

| Source | How | What it uniquely knows |
|---|---|---|
| `attendance` | D1 binding `ATT_DB` | Who was physically on the premises |
| `breakfast` | D1 binding `BREAKFAST_DB` | Guests in house, food bought and used, rooms checked |
| `pos` | HTTPS, `/reports/*`, bearer key | Sales, payments, expenses, till closes |
| `laundry` | HTTPS, `/api/report`, bearer token | Charged, collected, left owing |

The POS's reporting API is documented in that repository as doc 18 and is
**switched off by default** — its execute permission is empty. A 503 from it is
a configuration state, not a fault, and the run log says so rather than raising
an alarm every night.

Each connector hands back the same eleven lists whatever it had to do to get
them (`src/connectors/bundle.js`). That is the trick of the whole application:
four systems that share no field name, no money format and no idea what a day
is, each turned into one shape by the one piece of code that understands it,
and never spoken of in their own terms again.

**A connector never throws.** A source that fails comes back with an empty
bundle and a reason. One system being down costs the dashboard that system's
figures and nothing else.

### Money

Whole pesewas, everywhere, from the moment a figure enters until the moment it
is printed. Three of the four sources hand out floating-point cedis; they are
converted once, at the connector. The POS already sends minor units and is not
converted again — getting that backwards would inflate the restaurant's takings
by a factor of a hundred, and there is a test for it.

### Making one person out of three spellings

Attendance calls her "Akosua Frimpong", employee number E004. The POS has a
cashier "akosua frimpong". The laundry has "Akosua F.". Every question worth
asking about a person needs those to be one person.

An employee number matching is `exact`. A normalised name matching is `name` —
good enough to aggregate on, and **not** good enough to put somebody's name
beside the word "shortage" without saying so. Every finding and every table
that names a person carries the confidence of the link that named them.

There is deliberately **no fuzzy matching**. No edit distance, no nicknames. A
near-match that merges two real people is far worse than two rows that should
have been one: the first puts one person's till shortages on another's record,
the second is a tidy-up job. For the same reason, two people who really are both
called Kofi Asare, with two employee numbers, stay two people.

---

## What it is careful about

**It says what it cannot see.** Missing room revenue, a source that did not
answer, a wage rate that is an estimate — each is printed next to the number it
affects, not buried in a footnote.

**It is slow to accuse.** The till rule needs ten closes, four material
shortfalls, and a rate well clear of everybody else's before it will name
anybody — and if *most* tills are short it says so instead, because that is a
process problem and naming an individual would be wrong.

**It refuses to answer questions it cannot.** A labour ratio on a day with no
revenue is not 0% and not infinity; it is `null`, and every rule can tell that
apart from a real number. A trend on four days is `null`. A correlation on
three points is `null`.

**It uses blunt statistics on purpose.** A property this size produces about
thirty numbers a day. Medians rather than means, median absolute deviation
rather than standard deviation, and a stated minimum number of observations
below which a rule may not speak. One wedding must not redefine a normal week.

**Contribution is not profit** and never claims to be. Rent, power, water and
depreciation appear in none of these four systems.

**A finding somebody put down stays down.** Dismissing one is a judgement about
the finding; it is not undone by the rule firing again tomorrow.

---

## Demonstration mode

The app ships knowing how to invent a hotel, and starts that way.

A business intelligence tool with nothing in it is impossible to judge — you
cannot tell whether the findings are worth reading when the screen is empty. So
there are 26 invented staff, a guest count that drifts down over the window,
and problems planted on purpose: housekeeping that did not shrink when the
hotel emptied, a tomato supplier charging the restaurant half as much again as
the kitchen, laundry bills that go uncollected, and one cashier whose till is
short far more often than anybody else's.

Everything is generated from a fixed seed, so the same day always produces the
same numbers. It is arithmetic, not a recording: no real figure from any
property is in `src/fixtures/demo.js`. Every screen says so while it is on, and
connecting one real source replaces the lot.

The demonstration is also *internally consistent* — the housekeeping rounds are
generated from the same roster the attendance connector reports, so the
absence-to-missed-checks finding is a real join and not a coincidence somebody
arranged. A demonstration whose systems disagreed with each other would make
the tool look as though it were inventing connections.

---

## Setup

Six steps, and the first four are the same as any Worker.

### 1. Create the warehouse

```bash
cd bi
npm install
npm run db:create
```

Put the database id it prints into `wrangler.toml`, under the `DB` binding.

### 2. Bind the two databases it reads

In `wrangler.toml` there are two more `[[d1_databases]]` blocks, `ATT_DB` and
`BREAKFAST_DB`. Fill in the ids of the attendance and breakfast databases —
`wrangler d1 list` prints them. If a property does not run the breakfast app,
delete that block; the app copes, and says on every screen what it is missing.

### 3. Run the migrations

```bash
npm run db:migrate
```

### 4. Publish it

```bash
npm run deploy
```

### 5. Set the secrets

```bash
wrangler secret put SESSION_SECRET       # anything long and random
wrangler secret put DASHBOARD_PASSWORD   # what you will type to sign in
```

Both are needed. With neither, the app refuses everybody rather than letting
everybody in — an app that opens itself when misconfigured is worse than one
that locks its owner out until they set a password.

Optionally, for the two HTTP sources:

```bash
wrangler secret put POS_REPORTS_KEY      # the POS's REPORTS_API_KEY
wrangler secret put LAUNDRY_TOKEN        # a laundry staff token
```

**Keys are never typed into the Setup screen and never will be.** A secret
typed into a web form is a secret in a browser history, a proxy log and a
database export. The screen takes an address, which is configuration.

### 6. Load it

Open the app, sign in, go to **Setup**, and press *Load and re-read now*. After
that it runs itself at 00:45 Accra time every night.

The nightly run reaches **ten days back**, not one. Every one of these four
systems accepts a late correction — a punch that arrives this morning belongs
to Tuesday, an invoice is entered on Friday for Monday's delivery — and loading
only yesterday would freeze all of that at whatever it happened to be at
midnight. A reload replaces a day rather than adding to it, so running it twice
is safe and is the standard fix for "these numbers look wrong".

---

## Development

```bash
npm test        # 51 tests, no network, no fixtures to keep in step
npm run dev     # wrangler dev
```

The tests run the real migrations into `node:sqlite` behind a small shim of
D1's interface and drive the real handlers — the same approach the attendance
app takes, for the same reason. Every interesting bug in a warehouse is a bug
in a query, and a stubbed database cannot have one. The two HTTP connectors are
driven against a stubbed `fetch` and the two bound ones against real schemas —
the attendance connector is tested against the attendance app's own migrations,
one directory up, so a column renamed over there fails here rather than in
production.

### Layout

```
migrations/          the warehouse: dimensions, facts, findings
src/
  index.js           the route table, and the nightly cron
  lib/               http, money, dates, db, auth
  connectors/        one file per source system, plus the registry
  warehouse/
    identity.js      making one person, supplier or item out of several
    etl.js           pull, normalise, replace
  insight/
    facts.js         the warehouse read once, in the shape everything wants
    stats.js         the small amount of statistics this app is entitled to
    engine.js        runs the rules, ranks and stores what they find
    rules/           labour, demand, cash, supply, service
  routes/            the panels behind each screen
  fixtures/demo.js   the invented hotel
public/              the dashboard: no framework, no build step
```

### Where the logic lives

If a number is wrong, it is in one of three places and they are easy to tell
apart. A number that is wrong **for one source** is in that connector. A number
that is wrong **for every source the same way** is in `warehouse/etl.js`. A
*sentence* that is wrong is in `insight/rules/`.

### Adding a rule

A rule is an object with an `id`, a `title` and a `run(ctx)` that returns
findings. `ctx.facts` is the whole warehouse for the window, already joined;
`ctx.money` formats pesewas. Add it to `RULES` in `insight/engine.js`. A rule
that throws is contained — it costs its own findings and nothing else — but the
brief prints that it could not run, because a check that silently stops
checking is worse than one that fails loudly.

Three things a new rule owes the person reading it: a sentence rather than a
label, an honest `impactMonthly` (zero is a fine answer), and enough in
`evidence` that somebody can check the claim instead of believing it.

---

## Notes and limits

- **Room revenue is missing**, and everything above is understated by it. The
  cheapest fix is a single figure a day recorded beside the guest count in the
  breakfast app.
- **Wages are an estimate** unless a person carries their own rate: hours
  worked at a group default set in Settings. Every margin built on it is
  marked.
- **The laundry's collection figures are apportioned across days** by each
  day's share of what was charged, because its API reports them for the window
  as a whole. A month's total is exact; a single day's is indicative, and
  nothing decides anything on one day of it.
- **Department-to-line mapping is by pattern** (`src/connectors/attendance.js`).
  Anything unrecognised lands in admin deliberately, so an unmapped department
  shows up as an unexplained lump rather than being spread quietly across the
  lines that earn.
- **This is a separate Worker with its own database.** It reads the attendance
  app; it does not live inside it. A reporting layer that shares a deploy with
  the app people clock in on is a reporting layer that can take attendance down.
