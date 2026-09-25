# Publishing a report behind a PIN

For a finished report somebody made elsewhere — a page of HTML and whatever it
needs beside it — that a handful of people should be able to open at a fixed
address on this site.

## Where the files live, and why

In the database, never in the repository.

The repository is public. A PIN on a page whose source anybody could read on
GitHub would be theatre, so the report is uploaded through the app and stored
in D1, exactly as uploaded. What is served back is the same bytes. Nothing is
decoded, reformatted or rewritten on the way through.

## Publishing

**Reports** tab (owners only) → *Publish a report*.

| Field | What to put |
|---|---|
| Title | What readers see on the door |
| Address | The path after the site name — `2025v2024analysis` opens at `https://insight.niceoperation.com/2025v2024analysis` |
| Files | The page (an `.html` file — one named `index.html`, or the first one) and anything it loads beside it |

Publishing again to the same address replaces files of the same name and keeps
the rest, so a chart library uploaded once stays.

**Take down** removes the report and every file with it. The address then
behaves as if it had never existed.

## Readers

One PIN per person. *Give somebody a PIN* takes a name and, optionally, the
four digits; left blank, four random ones are made. **The PIN is shown once**,
in the confirmation, and kept only as a hash — write it down or read it out
then.

*Take away* revokes a PIN. It takes effect on that person's next click, not
when their session runs out.

The screen shows when each PIN was last used and how many times.

## What a four-digit PIN actually protects against

Four digits is ten thousand possibilities. No hashing slows that down, so the
protection is the lock, not the hash:

- five wrong guesses from one address in fifteen minutes, and that address
  waits fifteen minutes;
- forty wrong guesses from everywhere in fifteen minutes, and everybody waits
  — because that is what a guess spread across many addresses looks like;
- **a locked door does not open for the right PIN either.** A lock that did
  would only slow a guesser down until the guess that happens to be correct.

The hash is peppered with the installation's own secret all the same, so a
copy of the table on its own says nothing.

A PIN is right for "the six people who should see this". It is not right for
anything where the cost of a wrong person reading it is severe; that is what
accounts and passwords are for.

## For readers

Open the address. Type the PIN. That is all. The session lasts twelve hours;
`…/leave` on the end of the address ends it early, for a shared computer.

Search engines are told not to index any of it, on the page and in the
response headers.
