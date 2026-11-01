# View as

An admin can see Insight exactly as somebody else sees it: their menus, their
Inbox, only the areas and amounts they are given. Useful when somebody says
"I can't see it" or "there is no button".

## Using it

- Your name (top right) › **👁 View as somebody else…**, choose the person,
  **View as**. Or Settings › People & access › **👁 View as** on their row.
- A purple bar on top (and a purple frame round the screen) says whom you are
  viewing as. Switch to somebody else from the bar, or press **Stop viewing**.
- It is **look only**. Anything that would change something is refused with
  "You are viewing as …: nothing can be changed. Stop viewing to do this as
  yourself." That includes opening another system from the hub as them.
  What only reads still works: the to-dos and notes on each difference, and
  **Ask Insight** (answered from their list).
- **Not the same as their screen:** choices the browser remembers (Day or Week,
  the chip picked on Today, light or dark, table layout) are yours, from your
  browser, not theirs; and you see it at your screen's size, not their phone's.
  Buttons show as they would for them, but pressing one is refused.
- It ends by itself after 4 hours, when you sign out, or if you stop being an
  admin.

## Who may view as whom

| You are | You may view as |
| --- | --- |
| Owner | anybody active except yourself, other owners included |
| Admin (Insight "Everything") | anybody active who is not an owner |
| Supervisor, uploader | nobody |

## The log

Owners see every time under Settings › People & access › **Who viewed as whom**: who,
as whom, from and until.

## For whoever runs it

- `src/lib/auth.js`: the `insight_view_as` cookie (signed, tied to the admin
  who set it) and `currentAccount`, which answers as the viewed account with
  `viewedBy` set. `currentAccount(…, { real: true })` is who is really signed in.
- `src/index.js`: the router refuses every request other than GET while
  `viewedBy` is set.
- `src/routes/viewas.js`: whom (`GET /api/view-as`), start or switch
  (`POST /api/view-as`), stop (`POST /api/view-as/stop`), the log.
- `public/js/views/viewas.js`: the chooser and the bar.
- Table `view_as_log` (migration 0038).
