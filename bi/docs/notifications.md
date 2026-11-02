# Notifications

Everything Insight tells a person is in **Assistant › Notifications**, and on
their phone or computer too once they turn that on. The bell at the top shows
how many are unread.

## The inbox

- **All**, **Unread**, **Urgent** and **Read** across the top. Unread is
  where it opens.
- Newest first; something told again (a reminder) moves back to the top,
  unread, and says how many times it was told. It stays one line.
- Pressing one opens what it is about and marks it read. **Mark read** /
  **Mark unread** on each; **Mark all read** at the top.
- **Urgent**: somebody is waiting on it (a store-room request, proof asked) or
  it says something is overdue, late or short. Once the thing it is about is
  finished (a store request issued), it is marked done and leaves Urgent.
- Each person sees only their own.

## What comes here

Every email Insight sends a person with an Insight account, to them or in
copy: the 07:00 list, a to-do given, proof asked, a note they were tagged in,
the management report, the prepaid summary, the reply to receipts they
emailed. And the kitchen's store-room requests (below), which are pushed
again every 15 minutes. Somebody without an Insight account (a new person
invited, a supplier) gets the email only.

## On the phone or computer

**Turn on** at the top of Notifications: the browser asks, Insight sends a
test. From then everything above also arrives as a notification, even with
Insight closed; pressing it opens Insight at the right page. **Send a test**
and **Turn off** are there too, and it says how many other devices of yours
have it on.

- On an **iPhone**: Share › Add to Home Screen first, open Insight from the
  home screen, then Turn on (Apple allows it only there).
- Blocked by mistake: allow notifications for Insight in the browser's site
  settings, then Turn on again.

Nothing to set up: Insight makes its own push key the first time (kept in the
`push_key` table, not in settings), and speaks to the browser's own push
service directly.

## The kitchen's store-room requests

Kitchen staff ask the store room for stock in the breakfast app. Every 15
minutes Insight reads those still waiting, straight from the breakfast app's
database:

1. A new one becomes a to-do in **To sort out › Store requests**, for the
   person chosen in Settings › Rules › Front desk › Limits, **The kitchen's
   store requests go to** (shared out among supervisors when nobody is
   chosen). It is on their **Today**, urgent, with **Issue it in the
   breakfast app**.
2. They are **emailed once**, and **pushed** at once.
3. While it is still waiting, they are **pushed again every 15 minutes**.
4. Once it is **issued** (what was not issued comes back as a request of its
   own, and starts again), **declined** or **cancelled** in the breakfast app,
   the to-do closes itself, saying who did what, and the pushes stop.

Issuing stays in the breakfast app: Insight only reads it. Whoever is chosen
needs the breakfast app's store-room permission to issue.

## For whoever runs it

- `src/lib/notices.js`: `tell` (a line in the inbox, and the push),
  `fromMail` (called by `callLink` for every `/api/link/mail` sent with
  `env`), `settle`, `pushTo`.
- `src/lib/webpush.js`: encryption and signing (HIVE's, copied) and
  Insight's key. `src/routes/notices.js`: the inbox and the devices.
- `src/routes/storereq.js`: the 15-minute read (`*/15 * * * *` in
  wrangler.toml). To-dos are `money_todo` rows of kind `store`.
- `public/js/views/notifications.js`, the bell in `public/js/app.js`, and the
  `push` and `notificationclick` handlers in `public/sw.js`.
- Tables `notice`, `push_sub`, `push_key`, `store_request` (migration 0067).
