# The Assistant

Assistant › Today: everything that needs you, from every place Insight
reads, in one list, each with what Insight would do about it. Everybody given
Insight has one, and it opens first; an admin's covers everything, anybody
else's only what their access already shows them.

## Who sees what

| Who | Their Assistant reads |
|---|---|
| **Admin** (and owners) | Everything below in **The list** |
| **Supervisor** | To-dos given to them, and sent back to them; shifts of the last week not checked (if they may check shifts); staff answers from HIVE waiting for a decision (if they act on staff answers); Nice Place counters to read (if they read them; the link opens To sort out) |
| **Uploader** | The ASSD journal not loaded lately, with a link to Upload files |
| **Anybody given report pages** | Insight's checks, if the Brief is shared with them; Nice Place shifts with no sales sent, if the Nice Place page is |

Approvals in every system, receipts, floats, bills owed, suppliers, the
management report and Nice Place pickups to approve stay an admin's, and so
does **Done for you**. Amounts show only for whoever may see money (an admin,
or a supervisor given amounts); the Brief's own findings show theirs, as the
Brief does. The summary and **Ask Insight** use only that person's list, and
say so when something is beyond it. The count on the Assistant button is an
admin's approvals, so nobody else has it.

## The list

| Tab | What is in it | Where it comes from |
|---|---|---|
| **Decide** | Approvals waiting in every system; receipts with no PO, drafts to check; float receipts to look at; answers on the to-do list; Nice Place counters nobody could read | Approvals, Receipts, Floats, the to-do list, Nice Place |
| **Fix** | Insight's own checks (drawers, food cost and the rest), money held in floats with nothing sent for 14 days, Odoo bills owed more than 30 days (only when turned on, see below), to-dos nobody has, the ASSD journal not loaded for two days | Findings, Floats, Odoo bills, the to-do list, Shift files |
| **Review** | Last week's management report when it has not gone; supplier names not linked to Odoo; a system that could not be read for approvals | Management report, Suppliers, Approvals |
| **Done for you** | What Insight did by itself in the last day: reading the systems, draft POs made from receipts | Insight |

Urgent first, then by money, then by how long it has waited. Open a line for
why, **What I'd do**, and buttons: a decision that needs nothing typed
(Approve, Send back) is made from here, in its own system, as you; anything
else opens the page where it is done.

Each place is read on its own. One that fails says so under **What I read**,
and the rest of the list still comes.

### Bills owed in Odoo: off unless turned on

Bills owed to suppliers are paid on their own rhythm, and a big balance would
otherwise sit at the top of the list, in **Money at stake** and in the
summary. So they are left out: **What I read** shows Odoo bills as *off*.
Under it, an admin ticks **Flag bills owed in Odoo** to bring them back
(suppliers owed for more than 30 days, two months and over as *Soon*), and
unticks it to leave them out again. It is one setting for every admin.
Buying › Suppliers shows every bill either way, and **Ask Insight** still
answers a question about what is owed when they are off.

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
