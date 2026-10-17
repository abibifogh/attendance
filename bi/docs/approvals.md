# Approvals

Everything waiting for an admin's decision, in every system, in one list.
The **✓ Approvals** button on Insight's menu bar shows how many are waiting
(on a phone, the tick and the number). It is there for admins only.

## What is in it

- **Insight:** supervisors' answers and "reconciled together" waiting for an
  admin, corrections to cash movements, and POs made in Insight that staff
  want to pay from a drawer.
- **HIVE:** leave requests, leave days changed after sign-off, clock-time
  corrections, availability, shift swaps, salary advances, medical claims,
  lunch changes, documents sent in, personal details sent in, and sign-off
  questions.
- **POS** (once linked): spends at the till, purchase orders over the limit,
  group bookings and changes to a booking, decided here. Counts (bar,
  kitchen, store room, shop) and shelf changes are listed with a link to the
  POS's Waiting for you, and decided there, because approving one moves
  stock. A group booking whose meal times are already on the kitchen's list
  is refused in the POS too, which cancels them and gives money back.
- **Maintenance** (once linked): tasks done and waiting for review, store
  counts, stock counts, new parts and tools, and weekly activity plans (a
  supervisor passes them up; the admin approves).
- **Team Tasks** (once linked): leads' week plans, for a manager.

You see only what you may decide in each system. In HIVE that is what your
own HIVE login may decide: an admin sees all of it; a login without, say, the
pay permission does not see advances or medical claims.

The chips across the top filter by system. The list is oldest first. Pick one
to see it in full on the right (below the list on a phone).

## Deciding

Each item offers the same choices its own system gives, with the same fields:

- Leave: **Approve** (with the type it is recorded as, and the days charged)
  or **Refuse**.
- Salary advance: **Approve** (with the amount and months, which you can
  change) or **Decline**.
- Medical claim: **Approve** (an amount up to what was claimed, and whether
  to allow it over the allowance) or **Refuse**.
- Personal details: **Accept** the changes ticked, or **Refuse all**.
- Sign-off question: **Answer and hand back** (a note is needed), **Sign the
  days off**, or **Close, no change**.
- The rest: approve or refuse, send back or decline. Where the system needs a
  reason to refuse (a clock-time correction, a document, a PO from a drawer),
  the note box says so.

Pressing a choice does it in that system, through that system's own rules,
as you. HIVE records it as, for example, "Michael Test via Insight (admin)",
changes the rota, the balance or the pay exactly as if you had pressed it in
HIVE, and tells whoever asked by notice, push and email as it always does.
The item then leaves the list and the count goes down.

**Open in HIVE ↗** opens the same screen in HIVE, in a new tab, for anything
you want to look at more closely (a document's file, a medical receipt, the
rota around a swap). An Insight item opens Shifts › Inbox.

## When something goes wrong

- **A system cannot be reached:** a yellow line says so, and its items are not
  in the list this time. Nothing is changed there. **Try again** asks again.
- **Already decided in the system itself:** the system's own words come back
  ("That request has already been decided") and nothing is changed. Press
  **↻ Refresh** and it is gone from the list.
- **"No HIVE login has the email …":** HIVE finds you by the email on your
  Insight account. Put the same email on your own HIVE login (HIVE › Setup ›
  Users & data), then refresh.

## Linking the POS

The POS joins the list by itself once both are true:

- **The POS's reports address is set in Insight** (Setup). This is its notify function's domain.
- **Insight has `SSO_SECRET_POS`.** It is the same secret the POS's sign-in hand-off already uses.

The POS must also be running the version with the approvals entry point (snpos PR #58). Until then, a yellow line says the POS does not take approvals from Insight yet.

## Linking Maintenance and Team Tasks

Both are answered by one server function in the Maintenance database. Set
one shared secret, the same value in both places:

- In the hostel-maintenance repository: `INSIGHT_APPROVALS_SECRET`, then run
  its "Deploy Supabase" Action.
- In this repository: `INSIGHT_SSO_SECRET_MAINTENANCE`, then run "Set
  Insight's secrets".

Maintenance finds you by the email on your Insight account. A decision goes
through Maintenance's own rules, as you: only a supervisor or admin passes a
plan up, only a Team Tasks manager decides a week plan.

Laundry has nothing that waits for approval.

## For whoever runs it

HIVE's side is `src/routes/approvals.js`: `POST /api/link/approvals/list` and
`/decide`, signed by Insight with the same secret as the till link
(`SSO_SECRET_ATTENDANCE` here, `INSIGHT_SSO_SECRET` in HIVE). Each decision
runs HIVE's own route for it, with that route's own permission, as the HIVE
login whose email matches. Insight's side is `bi/src/routes/approvals.js`;
each system is one entry in `SYSTEMS` with a `list`, a `decide` and, for the
POS, a `linked` check. The POS's side is
`functions/notify/src/insight-approvals.js` in the snpos repository, signed
the same way with `SSO_SECRET_POS` (`INSIGHT_SSO_SECRET` there).
