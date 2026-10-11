# Advances, the expense form, and POs whose price changed

## The rules

1. **An advance.** When cash leaves the drawer before the purchase, the
   receptionist adds the PO while it is still a requisition in Odoo (a request
   for quotation, or waiting for approval). It counts on their shift at the
   requisition's amount, in their name. A cancelled PO cannot be used.
2. **Settled** means approved in Odoo *and* reported on the expense form (the
   amount and the TnT, which add up to the PO's total).
3. **The next shift.** An advance not settled holds up the next shift's
   closing report, and every shift after it, until it is settled. In Insight,
   whoever may act on Advances can give it **More time** (until a day) or
   **Close** it with a reason.
4. **An approved PO** typed on a closing report has to be on the expense form
   already, or the report cannot be signed.
5. **ASSD.** Every expense, advances included, is moved out in ASSD when the
   shift closes. A later difference shows in ASSD as a closing surplus (a
   refund came back) or a shortage (more was paid).
6. **Refunds and deficits.** Once a PO is settled, if its total is not what
   left the drawers:
   - **Refund** (bought for less): HIVE tells whoever is on the rota for the
     next reception shift, by push and email, to expect that much more cash
     than ASSD shows, with the PO, who advanced it and when, and what it was
     bought for. On Close shift it says *Put GH₵ X in the drawer* with
     **Done**, and the shift cannot be signed until it is done.
   - **Deficit** (bought for more): nobody is messaged. On Close shift it says
     *GH₵ X more paid from the drawer* with **Done** and **Not on my shift**.
   - Only for POs paid from a HIVE drawer. A PO on the expense form that no
     shift paid was paid some other way and is never chased.
   - Only within five days of the shift that paid it. Older ones are not shown
     to staff; the admins are told instead.
7. **Before the form is connected**, nothing waits for it: an approved PO
   counts as reported.

## Who sees it

Insight → Shifts → To-do → **Advances**. Admins always. A supervisor only if
an admin gives them **Advances** under Till settings → supervisor access:
*See* shows the list; *See and act* also allows More time and Close. Shift
variances are shown only to those who also see amounts.

Each line has one status: *Approve in Odoo*, *Report on form* (either marked
*overdue* once the next shift's day has passed), *Refund GH₵ X*, *Deficit
GH₵ X*, *Refund not in ASSD* (the shift that took it in shows no surplus),
*Cancelled in Odoo*, *Closed* or *Settled*. Open a line for what Odoo, the
form and the drawers each say.

## Connecting the expense form, once

1. Make up a long random password (a password manager can make one). This is
   the form's secret. Do not paste it anywhere else.
2. GitHub → this repository → **Settings → Secrets and variables → Actions →
   New repository secret**. Name `INSIGHT_EXPENSE_FORM_SECRET`, value the
   secret.
3. **Actions → "Set Insight's secrets" → Run workflow.**
4. Open the expense form in Google Forms → **⋮ → Apps Script**. Delete what is
   there and paste in [`expense-form.gs`](expense-form.gs). It reads these
   questions: *Enter the Purchase Order number*, *Enter the GHS Value*, *Was
   there transportation?*, *How much was transportation?* and *Select Your
   Name*. If one is renamed on the form, change its title at the top of the
   script to match.
5. In the script editor: **Project Settings (⚙) → Script properties → Add**:
   - `INSIGHT_URL`: Insight's address, for example `https://insight.example.com`
   - `FORM_SECRET`: the same secret as in step 2
6. Back in the editor, choose **setUp** and press **Run**. Google asks for
   permission the first time; allow it.
7. Choose **sendAllPast** and press **Run**, to send the responses already on
   the form from 1 October 2026 on (`SEND_FROM` at the top of the script).

PO numbers are read however they were typed: 4123, P04123, p04123, PO4123,
POO123, or two on one response ("4123 & 4124", both marked reported). *N/A*,
a name or a phone number names no PO. TnT is added to the amount, unless the
answer to *Was there transportation?* says it was included in the invoice.

From then on each response reaches Insight the moment it is submitted.
