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
   **Give it to** one person instead, once it is approved in Odoo: then only
   that person's Close shift waits for it ("Given to you to report", on every
   shift they close, whichever shift it is) until it is on the expense form,
   and everybody else closes as normal. The person who gave the money out is
   suggested first. They are told at once in HIVE (push and email), and told
   again if it is given to somebody else, taken back, given more time or
   closed. **Take it back** makes it hold up every shift again.
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

Insight → Front desk › Shifts › To sort out → **Advances**. Admins always. A supervisor only if
an admin gives them **Advances** under Settings → Who sees what:
*See* shows the list; *See and act* also allows More time, Give it to and Close. Shift
variances are shown only to those who also see amounts.

Each line has one status: *Approve in Odoo*, *Report on form* (either marked
*overdue* once the next shift's day has passed), *Refund GH₵ X*, *Deficit
GH₵ X*, *Refund not in ASSD* (the shift that took it in shows no surplus),
*Cancelled*, *Closed* or *✓ Counted*. Open a line for what Odoo, the
form and the drawers each say.

Under **Advances**, below the list, **On the expense form, not paid from a drawer** lists form
entries whose PO no HIVE shift paid (the safe, a transfer, a supplier
account). They are never chased. An admin ticks the ones looked at and
**Clears** them (or **Clear all listed**); **Undo** puts them back.

## Connecting the expense form, once

1. Make up a long random password (a password manager can make one). This is
   the form's secret. Do not paste it anywhere else.
2. GitHub → this repository → **Settings → Secrets and variables → Actions →
   New repository secret**. Name `INSIGHT_EXPENSE_FORM_SECRET`, value the
   secret.
3. **Actions → "Set Insight's secrets" → Run workflow.**
4. Go to [script.google.com](https://script.google.com) → **New project**.
   Delete what is there and paste in [`expense-form.gs`](expense-form.gs).
   Name the project (top left), for example *Expense form to Insight*, and
   save. It reads these questions: *Enter the Purchase Order number*, *Enter
   the GHS Value*, *Was there transportation?*, *How much was
   transportation?* and *Select Your Name*. If one is renamed on the form,
   change its title at the top of the script to match.
5. **Project Settings (⚙) → Script properties → Add script property**, three
   times:
   - `INSIGHT_URL`: Insight's address, for example `https://insight.example.com`
   - `FORM_SECRET`: the same secret as in step 2
   - `FORM_ID`: the long code in the form's address when you edit it,
     between `/d/` and `/edit`
6. Back in the editor, choose **setUp** and press **Run**. Google asks for
   permission the first time; allow it (on "Google hasn't verified this app":
   Advanced → Go to … → Allow).
7. Choose **sendAllPast** and press **Run**, to send the responses already on
   the form from 1 October 2026 on (`SEND_FROM` at the top of the script).

PO numbers are read however they were typed: 4123, P04123, p04123, PO4123,
POO123, or two on one response ("4123 & 4124", both marked reported). *N/A*,
a name or a phone number names no PO. TnT is added to the amount, unless the
answer to *Was there transportation?* says it was included in the invoice.

From then on each response reaches Insight the moment it is submitted.

The script also sends *Date of the expense:* and whether it was paid from
the cash register or the safe (*Did you pay from cash register or did you
use petty cash from the safe?*). Insight uses them to tie a PO to a shift;
neither is required. With a script from before they were added, paste the
new [`expense-form.gs`](expense-form.gs) over it (keep the script
properties), save, and run **sendAllPast** once more: responses already sent
are updated, not doubled.

A separate project rather than the form's own script editor: a form whose
script was once tied to a Google Cloud project that has since been deleted
cannot be given permissions ("Error 401: deleted_client"). A new project is
not tied to anything. The script also works from the form's own editor,
where FORM_ID is not needed.
