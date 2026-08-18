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

It is also the way in. One sign-in here opens all five systems — click a system
on the hub and you arrive there already signed in, as yourself, with whatever
that system says you may do. See [Signing in once](#signing-in-once).

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

### The hub

The first screen, and for most people the only one here they will ever open: a
card per system, whether they have been given it, and one click to enter.

Access is granted per person per system. There is no role that quietly carries
all of them, because *manager* means five different things in five systems, and
somebody who needs the till does not necessarily get the wage bill. Being able
to sign in here is itself one of the grants — an account can be a way into the
other four and see none of the numbers.

A system that cannot hand somebody over says so on its own card, in a sentence,
and offers a plain link instead. A button that silently drops you on another
login form is worse than no button.

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

## Signing in once

Somebody signs in here, clicks a system, and arrives there already signed in.

The mechanism is the authorization-code half of OAuth: this app mints thirty-two
random bytes, stores their hash against that person and that system for ninety
seconds and one use, and redirects. The far system then calls **back** here,
server to server, with the code and its own shared secret, and gets the name and
address. Nothing about who somebody is ever travels in a URL.

Four properties are worth stating, because a simpler version would not be safe:

- **The identity is on the back channel.** A URL ends up in a browser history, a
  proxy log and a `Referer` header. A single-use code ninety seconds old is
  worthless in all of them; an email address and a role are not.
- **Single use is enforced here.** There are four far ends and one of these, and
  a replay check is only as good as the system that remembered to write one.
- **Every system has its own secret** and can only redeem codes minted for it. A
  compromised laundry cannot mint itself a session on the POS.
- **A consumer never creates accounts.** If this app says `ama@example.com` and
  nobody with that address exists over there, the answer is no. Otherwise
  whoever controls this hub could mint themselves an account in every system in
  the group.

**The attendance app already accepts a hand-off** — `src/lib/sso-consumer.js` in
the parent repository, and a `/sso` route in its Worker. The other three live in
their own repositories; [docs/sso.md](docs/sso.md) is the protocol and the
thirty lines each of them needs, written out for a Cloudflare Worker, a Netlify
function and an Appwrite function.

Until a system has its handler, its hub card links to it and says it will ask
for a password. Nothing is broken in the meantime; it is just not yet joined up.

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
| *anything on Supabase* | HTTPS, PostgREST, per-source key | Whatever you map it to |

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

### A database on Supabase

Supabase needs nothing in GitHub. GitHub holds code; Supabase holds data, and
this reads it over the network through the PostgREST API that every Supabase
project already has. What it needs is the project's address and a key, not a
repository.

The difference from the four above: they each know their system's schema,
because that schema is in a repository this code can read. A Supabase database
is your own Postgres and its tables are whatever you made them — so this
connector is **declarative**. The mapping lives in the source's configuration
and no code changes to add one:

```json
{
  "schema": "public",
  "tables": [
    { "fact": "revenue", "from": "daily_sales", "day": "sale_date",
      "line": "restaurant", "money": "major",
      "columns": { "net": "total", "collected": "paid", "orders": "tickets" } },
    { "fact": "demand", "from": "occupancy", "day": "night",
      "columns": { "inhouseGuests": "guests_in_house" } }
  ]
}
```

`money` has no default and the mapping is refused without it. `"major"` means
the column holds cedis like `12.50` and will be multiplied by a hundred;
`"minor"` means it already holds whole pesewas like `1250` and will be left
alone. Guessing is how a figure ends up out by two orders of magnitude in a
direction nobody notices until a bank reconciliation.

Add one under **Setup → Databases you have mapped yourself**. Each gets its own
key, named after it, so revoking one does not revoke the others:

```bash
wrangler secret put SUPABASE_KEY_ROOMS    # the project's service-role key
```

Filters, paging, `where` clauses in PostgREST's own syntax, and what each fact
will accept are in `src/connectors/supabase.js`.

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

All of it from a browser. Nothing below needs a terminal, a laptop or wrangler
installed anywhere.

### Once, before anything else

**Settings → Secrets and variables → Actions → New repository secret:**

| Secret | What it is |
|---|---|
| `CLOUDFLARE_API_TOKEN` | a token with **D1:Edit** and **Workers Scripts:Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | from the right-hand side of any Cloudflare dashboard page |
| `INSIGHT_DASHBOARD_PASSWORD` | what you will type the first time you sign in |

Only the last one is new — the first two are what the attendance app already
deploys with, so they may well be there.

### Then, two buttons

**1. Actions → Set up Insight → Run workflow.** Leave the branch as `main`.
Creates the D1 database, finds the `attendance` and `breakfast` databases on
your account, writes their ids into `bi/wrangler.toml` and commits that,
switches off any binding whose database does not exist, applies the migrations,
and publishes Insight. The Worker's address is printed in its *Publish Insight*
step.

**2. Actions → Set Insight's secrets → Run workflow.** Leave both inputs blank
for now. Puts the password on the Worker and **generates the signing key
itself** — that one never exists in GitHub, in a log or in anybody's password
manager, only on the Worker.

Then open the Worker's address — printed at the end of step 1's *Publish
Insight* step, and again in the Cloudflare dashboard under **Workers & Pages →
niceoperation-insight** — sign in with `INSIGHT_DASHBOARD_PASSWORD`, and press
**Setup → Load and re-read now**. It starts in demonstration mode, so
every screen has something on it before a single real system is connected.

> Step 1 publishes rather than leaving that to the ordinary deploy, because a
> push made with `GITHUB_TOKEN` does not start a workflow — GitHub suppresses
> that so a workflow cannot trigger itself for ever. Its commit would otherwise
> sit there doing nothing and step 2 would fail on a Worker that does not exist.
>
> If step 1 cannot push — a protected default branch will refuse it — run it
> against a branch instead and merge that, or copy the ids out of the workflow
> summary into `bi/wrangler.toml` using GitHub's own editor. Database ids are
> not secret; reaching one still needs the API token.

After that, every push to the default branch republishes Insight alongside the
attendance app, in the ordinary way.

### What is left, in the order it is worth doing

Each stands alone. The app works after every one of them and says on screen
what it still cannot see.

**Make yourself an account.** **Accounts → Add somebody**, tick owner, set a
password. The shared password still works as a way back in, but it deliberately
cannot be handed over to another system — a password out of a config file is
not a person.

**Connect the POS and the laundry.** Add repository secrets
`INSIGHT_POS_REPORTS_KEY` and `INSIGHT_LAUNDRY_TOKEN`, run **Set Insight's
secrets** again, and put each one's address in under **Setup → The four
systems**. The POS's reporting API ships switched off — it needs
`"execute": ["any"]` on its notify function and a deploy, or it answers 503 and
this says so.

**Leave demonstration mode** once one real source is reading. The invented
figures stay until the next load overwrites them, so doing it by accident costs
nothing.

**Join the other three up for single sign-on.** Generate a secret for each
(any password manager will), add it as `INSIGHT_SSO_SECRET_BREAKFAST`,
`INSIGHT_SSO_SECRET_POS` or `INSIGHT_SSO_SECRET_LAUNDRY`, run **Set Insight's
secrets**, and give that system the same value plus the handler in
[docs/sso.md](docs/sso.md). One at a time; the hub says plainly which are joined
up and which still ask for a password.

**Map any Supabase databases** under **Setup → Databases you have mapped
yourself**, then add their keys as `INSIGHT_SUPABASE_KEYS` — one `name=key` per
line — and run **Set Insight's secrets**.

### From a terminal instead

If you would rather:

```bash
cd bi && npm install && npm run setup
npx wrangler secret put SESSION_SECRET       # openssl rand -base64 32
npx wrangler secret put DASHBOARD_PASSWORD
npm run deploy
```

`npm run setup` does exactly what the **Set up Insight** workflow does, and is
equally safe to run twice. By hand it is: `wrangler d1 create insight`, the
printed id into `wrangler.toml` under the `DB` binding, the ids of the
`attendance` and `breakfast` databases into `ATT_DB` and `BREAKFAST_DB` (or
those bindings commented out), then `npm run db:migrate`.

### Where it lives

By default `niceoperation-insight.<your-account>.workers.dev` — the exact address is printed in the **Set up Insight** run, under its *Publish Insight* step. For a proper
address, add a route block to `bi/wrangler.toml` the way the attendance app has
one:

```toml
[[routes]]
pattern = "insight.niceoperation.com"
custom_domain = true
```

The domain has to be on the same Cloudflare account. Editing that file in
GitHub's web editor and pushing is enough; the deploy picks it up.

## Development

```bash
npm test        # 97 tests, no network, no fixtures to keep in step
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
  lib/               http, money, dates, db, auth, sso
  connectors/        one file per source system, plus the registry
  warehouse/
    identity.js      making one person, supplier or item out of several
    etl.js           pull, normalise, replace
  insight/
    facts.js         the warehouse read once, in the shape everything wants
    stats.js         the small amount of statistics this app is entitled to
    engine.js        runs the rules, ranks and stores what they find
    rules/           labour, demand, cash, supply, service
  routes/            the panels behind each screen, plus accounts
  fixtures/demo.js   the invented hotel
scripts/setup.mjs    the terminal version of the Set up Insight workflow
public/              the dashboard and the hub: no framework, no build step
docs/sso.md          the hand-off protocol, and a handler per platform
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
- **The hand-off tells the far system *whether*, never *as what*.** The role
  travels with it as context; what somebody may do over there is what that
  system's own database says, as it always was.
- **This is a separate Worker with its own database.** It reads the attendance
  app; it does not live inside it. A reporting layer that shares a deploy with
  the app people clock in on is a reporting layer that can take attendance down.
