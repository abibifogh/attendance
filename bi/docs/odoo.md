# Connecting Odoo

For **Odoo 19 Online, Custom plan** — which is what this was written against.

Insight reads Odoo and never writes to it. `search_read` is the only method
called anywhere in `src/connectors/odoo.js`, and there is no code path that
writes. That is not a promise in a comment; it is the whole of the surface.

---

## Before you start

Two things decide whether this works at all.

**The plan.** External API access on Odoo Online is a **Custom plan** feature.
It is not available on One App Free or Standard. You are on Custom, so this is
settled — but if the subscription is ever downgraded, this connector stops
working and the Books tab goes quiet.

**The version.** Odoo 19 uses the **External JSON-2 API** at `/json/2/`. The
older `/jsonrpc` and `/xmlrpc/2` endpoints — which nearly every example on the
internet still shows — are scheduled for removal in **Odoo Online 21.1, winter
2027**. This connector is written against JSON-2, so it will not need redoing.

---

## 1. Make a user for Insight

**Settings → Users & Companies → Users → New.**

| | |
|---|---|
| Name | `Insight (read-only)` |
| Email | anything you control |
| Access rights | **Accounting → Billing** and **Purchase → User**. Nothing else. |

Being straight about this: Odoo has no single "read-only" switch. The real
safeguards are that this connector only ever reads, and that you can revoke
this user's key instantly without touching your own login. A separate user is
what makes that revocation cheap.

Do **not** give it Settings or Administration access. It does not need it.

## 2. Generate the API key on that user

Sign in **as that user**, then:

**avatar (top right) → My Profile → Account Security → New API Key.**

It asks for that user's password, then a description (`Insight`), then shows
the key **once**. Copy it now — Odoo will not show it again.

The key replaces the password in API calls. Treat it exactly as seriously.

## 3. Find your database name

For Odoo Online it is normally the subdomain: `niceoperation.odoo.com` →
database `niceoperation`.

Confirm at `https://<your-domain>/web/database/selector`, or leave it blank —
the connector sends the `X-Odoo-Database` header only when you give it one, and
Odoo Online needs it only where one domain serves several databases.

## 4. Decide how Odoo says which part of the business a cost belongs to

**This step decides how useful the result is**, and it is the only one nobody
can answer for you.

Open a recent vendor bill and look at a line. What distinguishes a restaurant
purchase from a laundry one? Usually one of:

- **Analytic accounts** — the proper Odoo way, and what this connector prefers
- **Product category**
- Neither, in which case everything lands under one heading

Whatever it is, write down the mapping: which Odoo value means `restaurant`,
`bar`, `breakfast`, `laundry`, `rooms`, `housekeeping`, `maintenance`, `admin`.

Anything unmapped lands in `admin` **on purpose**. An unexplained lump of admin
cost is a prompt to fix the map; spreading it quietly across the lines that earn
would flatter every one of them and nobody would ever notice.

## 5. Put the key on the Worker

The key is a **repository secret**, never a config file and never a chat window.

1. GitHub → `abibifogh/attendance` → **Settings → Secrets and variables →
   Actions → New repository secret**
2. Name: `INSIGHT_ODOO_KEY`
3. Value: the key from step 2
4. **Actions → Set Insight's secrets → Run workflow**

## 6. Point Insight at it

In Insight, **Setup → Odoo (books)**:

| Field | Value |
|---|---|
| Address | `https://niceoperation.odoo.com` |
| Database | `niceoperation`, or blank |
| Line by | `analytic` or `category` |
| Line map | the mapping from step 4 |

Press **Check**. It answers with your company name and currency if the key
works, and with what is wrong if it does not.

## 7. Load

**Setup → Load and re-read now.** Then open **Books**.

---

## What it reads

| Odoo model | What for |
|---|---|
| `account.move` | vendor bills and credit notes — the headers |
| `account.move.line` | the lines, for prices |
| `res.company` | the connection check only |

Only bills dated in the window, by **accounting date** (`invoice_date`) rather
than entry date: a bill keyed in three weeks late still belongs to its own
month, and reporting it in the month somebody got round to it turns a good month
into a bad one for a reason nobody can find.

Cancelled moves are dropped at the source. Drafts come through and are excluded
from every total by the analysis, which needs to be able to count them.

Only product lines are read. A bill also carries tax lines and the balancing
payable line, and counting those as purchases would double every total and
invent a supplier called "Accounts Payable".

## What it does with it

The **Books** tab, ordered by what is worth acting on:

- **The same thing, two prices** — items bought from more than one supplier,
  ranked by what the gap is *worth* at the quantities actually bought, not by
  the percentage
- **Bills that may be the same bill** — the same supplier reference twice
  (invisible in Odoo's own lists, because its internal numbers always differ),
  and the weaker same-amount-days-apart signal
- **Lines that do not look like the others** — a price far from that supplier's
  usual, which is nearly always a quantity keyed wrongly
- **Spend nobody agreed to first** — the share of billing with no purchase order
- **Where the money goes** — supplier concentration and the long tail
- **What is still owed** — ageing as at the end of the window, not today
- **Suspiciously round bills**
- **Every price, item by item**

## Three things worth knowing

**Money.** Odoo hands out floats in the company currency; this warehouse is
whole pesewas. The connector converts once, on the way in, with `toMinor()`.
Using `minor()` would load GH₵2,450.75 as GH₵24.51 — a hundredth of the real
figure, with no error and a plausible number on screen. Every field is asserted
in both units in `test/odoo.test.js`.

**Credit notes.** Odoo stores a refund with positive amounts and marks it only
by `move_type`. Read as written, every return would inflate the supplier it came
from instead of reducing it. The sign is applied in the connector.

**Outliers do not set a comparison price.** A single line keyed at 925 instead
of 9.25 once dragged one supplier's average to eleven times another's, and the
top finding on the screen became an accusation that a real supplier was
charging 946% more for bread — invented entirely by a typo. Prices are compared
on the clean lines; the bad line is reported on its own, where it can be fixed.
What was *spent* still counts everything, because the money left the account
whatever the line said.

## If something does not work

| What you see | What it means |
|---|---|
| "Odoo refused the API key" | Wrong key, or the user cannot read accounting. |
| "the address is wrong" | Check the address has no path on the end. |
| "did not answer in time" | Odoo was slow; the next run picks it up. |
| Books says "Odoo is connected but has no vendor bills" | Bills may be sitting as drafts, or dated outside the window. |
| Everything lands in `admin` | Step 4's mapping is empty or does not match. |
