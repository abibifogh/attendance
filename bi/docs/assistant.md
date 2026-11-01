# The Assistant: Today

Assistant › Today is each person's **one list**: everything that is theirs,
from every place Insight reads, sorted by when it wants doing, with the button
that does it. Everybody given Insight has one, and it opens first; an admin's
covers everything, anybody else's only what their access already shows them.

## The page

- **On top:** how many things are yours, how many overdue and due today, and
  chips to show one kind at a time (All, Given to you, Shifts, Safe, Nice
  Place, Approvals, Buying, Checks, Report). The chip chosen is remembered.
- **The Saturday report**, for the supervisor who sends it, all week: when it
  is due, how long is left, the reminders already sent, and the 14:00
  deduction. Amber after Friday's reminder, red once late, green once sent.
  An admin sees it from Friday's reminder until it has gone.
- **The list**, in three groups: **Overdue** (red), **Due today** (amber),
  **Later**. Six of each show; the rest open with *N more*. Each line has its
  kind, who gave it, why, how late it is, and its buttons: **Done** for a
  to-do, **Open shift** (opens that shift's page), **Decide**, **Send proof**,
  Approve or Send back for an approval, or a link to the page where it is done.
- **Sent up, waiting for a decision**: a supervisor's answers,
  reconciliations, accepts and corrections an admin has not decided yet, and
  anybody's own answers in HIVE (as staff, found by the same email) that
  nobody has decided yet, oldest first, so nobody asks twice. Nothing to do on
  them. Somebody's own HIVE answers are never on their list to decide.
- **Beside it:** *Your week* (things done since Monday, from the audit trail;
  what is overdue; shifts checked in the last seven days; whether last week's
  report went), *One email a day* (supervisors), *Done today*, and **Ask
  Insight**.

## Maintenance jobs and Team Tasks

Once Maintenance is linked (`SSO_SECRET_MAINTENANCE`, and
`MAINTENANCE_APPROVALS_URL` or `MAINTENANCE_TASKS_URL`), Today also lists
everybody's own open **Maintenance jobs** (given to them, Assigned or In
progress) and **Team Tasks** (given to them, not done), found by their email,
with chips of their own. Each has **Done** and **Open in Maintenance / Team
Tasks** (straight to that job or task, in a new tab).

**Done marks it done in that app**, as the person, keeping the app's rules:

- a job goes to *Done*, waiting for review; its history says "from Insight",
  and its reviewer and the coordinators are told, as the app tells them;
- a task is signed off with its steps; its history says so, and the others it
  is given to are told.

Some are opened, not done, and say why: a job that needs a photo of the
finished work and has none, a job in a locked period (for anybody but a
Maintenance admin), and a repeating task (Team Tasks sets the next one when it
is ticked there). The rules live in the Maintenance repository
(`db/maintenance/supabase/functions/tasks/`). They are in the 07:00 email too.

### When somebody's emails do not match

Jobs and tasks are found by the email of the Insight account. When somebody is
not found in Maintenance or Team Tasks by it, but somebody there has their
name (the same name; the same first and last name; or a single name that is
the other's first), their emails do not match and their work there cannot
show:

- **They** see *Your email doesn't match Team Tasks* on their Today, with the
  address Insight has and the start of the one the app has
  (`sa•••@other.test`), and to ask an admin to make them the same.
- **Admins** see one line per person and app, with both addresses in full
  (*People* chip): change one, in Insight under Settings › People & access, or
  in that app. It goes once they match.

Somebody in neither app, with no one of their name there, is not warned:
they simply have nothing there.

## When something is due

| Line | Due |
|---|---|
| A to-do given to you | The day it was given for |
| A Maintenance job, a Team Tasks task | Its due day in the app (none: by urgency) |
| Proof asked of you | The day it was asked |
| A shift to check | The day after the shift |
| A staff answer from HIVE, an approval | The day after it was given |
| Envelopes not marked received | The day after the oldest |
| Anything else | Urgent: today. Waiting a week or more: overdue. *Soon*: today. The rest: later |

## Who sees what

| Who | Their list |
|---|---|
| **Admin** (and owners) | To-dos given to them, proof asked of them, envelopes, and everything below in **What else is on an admin's list** |
| **Supervisor** | To-dos given to them; proof asked of them; POs to chase given to them, and sent back; each shift of the last week not checked (if they may check shifts); each staff answer from HIVE waiting (if they act on staff answers); envelopes not marked received (if they act on envelopes); Nice Place counters to read (if they read them) |
| **Uploader** | The ASSD journal not loaded lately, with a link to Upload files |
| **Anybody given report pages** | Insight's checks, if the Brief is shared with them; Nice Place shifts with no sales sent, if the Nice Place page is |

Amounts show only for whoever may see money (an admin, or a supervisor given
amounts); the Brief's own findings show theirs, as the Brief does. The summary
and **Ask Insight** use only that person's list.

## What else is on an admin's list

Approvals waiting in every system; receipts with no PO, drafts to check; float
receipts to look at and money held in floats with nothing sent for 14 days;
answers on POs to chase, and POs to chase nobody has; Insight's own checks
(drawers, food cost and the rest); Odoo bills owed more than 30 days (only
when turned on, see below); Nice Place pickups to approve and shifts with no
sales sent; the ASSD journal not loaded for two days; last week's management
report when it has not gone; supplier names not linked to Odoo. **Done today**
also says what Insight did by itself (reading the systems, draft POs made from
receipts).

## Email

Supervisors get **one email a day**, at 07:00: the same list, in the same
order, with the admins copied (see `management-report.md`). A to-do sends one
email when it is given; there are no other reminders. Anybody who does not get
the 07:00 email (an admin) is still reminded of their to-dos each morning.

Each place is read on its own. One that fails is named at the bottom of the
side (*could not be read*), and the rest of the list still comes.

### Bills owed in Odoo: off unless turned on

Bills owed to suppliers are paid on their own rhythm, and a big balance would
otherwise sit at the top of the list and in the summary. So they are left
out. At the bottom of the side, an admin's page says Odoo bills are *off*.
Under it, an admin ticks **Flag bills owed in Odoo** to bring them back
(suppliers owed for more than 30 days, two months and over as *Soon*), and
unticks it to leave them out again. It is one setting for every admin.
Buying › Suppliers shows every bill either way, and **Ask Insight** still
answers a question about what is owed when they are off.

## The summary and Ask

The line under the greeting is written by Workers AI (the same reader that reads
receipts and the Nice Place counters) from the list, and nothing else: it is
told never to invent a figure, a name or a cause. Until it answers, or if it
cannot be reached, it is left out.

**Ask Insight** answers a question from the same list, and says which page
would answer what the list cannot. It reads only; it changes nothing.

## Endpoints

- `GET /api/assistant`: Today: the list (each line with `when`, `due`, `late`, `area`), counts, the Saturday report card, what was sent up, the week, done today, and what was read (`src/routes/today.js`).
- `GET /api/assistant/brief`: the summary in words.
- `POST /api/assistant/ask` `{ question }`: an answer.
- `POST /api/assistant/app-done` `{ system: 'maintenance' | 'teamtasks', id }`: Done on a job or task, sent to Maintenance's `tasks` function as the person.
