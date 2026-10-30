# The Assistant

Assistant › Today, for admins: everything that needs you, from every place
Insight reads, in one list, each with what Insight would do about it.

## The list

| Tab | What is in it | Where it comes from |
|---|---|---|
| **Decide** | Approvals waiting in every system; receipts with no PO, drafts to check; float receipts to look at; answers on the to-do list; Nice Place counters nobody could read | Approvals, Receipts, Floats, the to-do list, Nice Place |
| **Fix** | Insight's own checks (drawers, food cost and the rest), money held in floats with nothing sent for 14 days, Odoo bills owed more than 30 days, to-dos nobody has, the ASSD journal not loaded for two days | Findings, Floats, Odoo bills, the to-do list, Shift files |
| **Review** | Last week's management report when it has not gone; supplier names not linked to Odoo; a system that could not be read for approvals | Management report, Suppliers, Approvals |
| **Done for you** | What Insight did by itself in the last day: reading the systems, draft POs made from receipts | Insight |

Urgent first, then by money, then by how long it has waited. Open a line for
why, **What I'd do**, and buttons: a decision that needs nothing typed
(Approve, Send back) is made from here, in its own system, as you; anything
else opens the page where it is done.

Each place is read on its own. One that fails says so under **What I read**,
and the rest of the list still comes.

## The summary and Ask

**Your day, in short** is written by Workers AI (the same reader that reads
receipts and the Nice Place counters) from the list, and nothing else: it is
told never to invent a figure, a name or a cause. Until it answers, or if it
cannot be reached, the counts are said in plain words.

**Ask Insight** answers a question from the same list, and says which page
would answer what the list cannot. It reads only; it changes nothing.

## Not yet

Doing things on its own (reminders, routine approvals) and telling you by
WhatsApp or email wait for your say on how far it may go.

## Endpoints

- `GET /api/assistant`: the list, counts, tiles and what was read. Admins.
- `GET /api/assistant/brief`: the summary in words.
- `POST /api/assistant/ask` `{ question }`: an answer.
