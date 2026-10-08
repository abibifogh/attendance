# Inviting somebody to Insight

An owner invites; the person chooses their own password. Nobody else ever
knows it.

## Sending one

**Accounts → Invite somebody.** Their name, their email address, an access
level (Owner, Admin, Supervisor or No reports), which other systems they may
open from the hub, and an optional note that goes in the email under your name.

- **Send invitation** emails them a link.
- **Copy the link instead** gives you the link to paste into WhatsApp or a
  message, and sends nothing.

Either way their account is made at once, with no password, and appears on the
grid below. The link works once and lasts 7 days.

The email goes out through HIVE, from the address HIVE already sends from
(HIVE → Setup → Email), under the name "Insight", with replies coming back to
you. It needs HIVE and Insight joined (Actions → **Set Insight's secrets**, the
same step as the sign-in hand-off). If HIVE cannot send, the invitation is still
made, and you are given the link to pass on yourself.

## Following it up

The **Invitations** list shows each person's newest link: Not opened, Opened,
Expired, Asked again, Joined or Withdrawn, and when each happened.

- **Resend** emails a fresh link. The old one stops working at once, so a link
  that has been forwarded around does not keep working.
- **New link to copy** does the same, but hands you the link instead.
- **Withdraw** stops the link and switches the account off. **Invite again**
  brings it back.

Somebody already on the grid who has never set a password gets an **Invite**
button on their row.

## What the person sees

The link opens a page, on a phone or a PC, that asks for their name (filled in),
a password of at least 10 characters, twice, and signs them in. You get an email
saying they joined.

A link that no longer works says why:

| The link | What it says | What they can do |
| --- | --- | --- |
| Expired (older than 7 days) | This invitation has expired | **Ask for a new link** |
| Replaced by a resend | This link has been replaced | **Ask for a new link**, or use the newer email |
| Already used | This invitation has already been used | Sign in |
| Withdrawn | This invitation was withdrawn | Ask you directly |

Asking emails you once, and their row shows **Asked again** until you resend.

## How it is kept

`invitations` (migration `0011`) holds one row per link sent. Only the
SHA-256 of each link's token is stored, so a copy of the database contains no
working links. The token rides after the `#` in the address, so it never
reaches a server log. The password is stretched in the browser exactly as at
sign-in; the server sees a derived key, never the password.
