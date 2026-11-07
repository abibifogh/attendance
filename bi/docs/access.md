# Who sees what

**Settings › People & access › Who sees what** is one table: one row per
person, one column per tab in Insight, each **Hidden**, **See** or **Do**. It
replaced Supervisors and Reports they see. **People** stays for inviting and
removing people.

Admins only open it.

## Reading the table

- **Places fold.** Tap Today, Front desk, Reports… to open its tabs or fold
  them. A folded place shows a small bar per tab and "2 of 7". What is open is
  remembered while the browser tab is open.
- **A square is a tab.**
  - Tap it to go Hidden → See → Do.
  - **See** is looking. **Do** is acting: giving money on Floats, deciding on
    Approvals, checking a shift.
  - Reports, Spend, Cashiers, Everybody and Staff costs are See only.
- **A dot** marks a change not saved yet. Nothing changes until **Save**;
  **Undo** drops every change.
- **A name** opens that person, tab by tab. Under some tabs are the finer
  things inside it, as ticks:
  - **Shifts:** day, week and month views, See amounts, Odoo POs, Check a
    shift, Ask for proof.
  - **To sort out:** staff answers, Advances, card and bank, cash movements,
    money out.
  - **Closing reports:** Reopen a report.
  - **Cashiers:** Net by person.
  - **Safe:** Mark envelopes received.
  - **Nice Place counters:** Answer counter questions.

  A tick that acts counts only while its tab is on Do. Mark envelopes
  received is the exception: it goes with the Safe on See, because on Do they
  have the whole safe.
- **Start from** sets a person from a ready-made level:
  - Front desk supervisor, Accounts, Nice Place pickups, Nice Place cash,
    Upload only, Reports only;
  - Admin, or No Insight access.

  Change one square and they show **Custom**.
- **Copy access to … from…** (with a person open) gives them somebody else's
  tabs and ticks.
- **Download** is the table as a CSV file.
- **Other systems**, at the end, is who opens HIVE, Breakfast & rooms, the POS
  and Laundry from the apps button.

## Who may change what

- **Admins** set every tab for people who are not admins.
- **Settings** tabs are for admins only, shown as "·". Giving someone Settings
  would let them change the rules for everybody.
- **Only an owner** makes somebody an admin, takes an admin away, or changes
  the other systems. An owner's row cannot be changed. Nobody can take their
  own admin away.
- Every save is in the audit trail, as every change is.

## How Insight keeps to it

A hidden tab is gone from the person's menu, and Insight refuses its data.
Underneath, the table writes three things (`src/routes/tabaccess.js`):

| Tabs | Kept in | Checked by |
|---|---|---|
| Shifts, To sort out, Closing reports, Cashiers, NP pickups, Upload files, and the ticks | the Shifts areas (`till_access`) | each endpoint's area, as before |
| Report pages, Spend, Suppliers, Staff costs, NP counters & money | shared reports (`report_access`) | `reportaccess.js`, as before; changing a supplier needs Suppliers on Do |
| Approvals, Floats, Receipts, Stock from Odoo, Fixed assets, Safe, Everybody, Evaluations | `tab_access` (migration 0070) | the front door: the tab's endpoints answer as for an admin, for that request only. A GET needs See; anything else needs Do |

Each tab's own rules, such as Receipts rules or Stock rules, stay in Settings,
which is for admins.

When saved in the table, a person gets the Insight role `supervisor` with a
row for every tab and every area. Hidden ones are written too, so the old
defaults for supervisors never apply to them. Somebody not saved yet keeps
exactly what their role (uploader, Reports only, Nice Place cash,
supervisor) gave them, and the table shows it that way.

Tested in `test/access.test.js`.
