# Floats

Money given to people to spend: a driver for market runs, a housekeeper for
supplies. They send a picture of each receipt from their own link; each
becomes a draft PO in Odoo marked with **their reference**, and comes off what
they hold.

## Giving money (Buying › Floats)

Everybody holding a float is a card on the left: what is still with them, a
bar of spent and given back, and a flag (receipts to look at, days with
nothing sent, settled). The person open is beside it: their totals, the
buttons below, their link with **Copy**, and everything newest first, with
**Refuse…**, **Open the PO in Odoo**, **See the receipt** and the note right
on each line. On a phone the list comes first; **‹ Everybody** goes back.

- **＋ Give money**: choose the person, or somebody new (their name and their
  reference, e.g. `KOFI`), how much, the day, and where it came from (the
  safe, the bank, a drawer). Somebody new gets a reference and a link.
- **Their link** (Copy, or **Change…**): a short one, `insight.niceoperation.com/float/igna`:
  the first four letters of their name (with a number when two names start
  the same). Copy it and send it to them by SMS or WhatsApp. No login:
  whoever has or guesses the link can see what they hold and send receipts as
  them, so choose a less obvious ending if that matters. **Change the link**
  takes the ending you type; every link they had before stops working.
  **Switch it off** stops receipts. Long links sent before (`float.html?t=…`)
  keep working until the link is changed.
- **Given back…**: money they hand back, off what they hold.
- **📷 Add a receipt for them**: paper receipts handed in, photographed here.
- **Take out**: a "given" or "given back" typed wrong.

## Their page

On their link they see, first, what is still with them, with what was given,
spent and given back. A receipt refused in the last two weeks is said in red
with why. Then one list by day: **All** (money given them, with its note, and
their receipts with each one's state: Being checked, ✓ Accepted, ✕ Refused
with why, or Could not be read, which the office fills in), **Given**,
**Receipts**, and **Statement**: this month, last month, all of it, or dates
they choose, with the totals shown, then **View · print** or **Spreadsheet**:
the same statement the office downloads.

**📷 Send a receipt** stays at the bottom: they choose one or several
pictures, or a PDF, say what it was for if the receipt does not, and send.

## Their receipts


Each receipt is read like Buying › Receipts (vendor, total, date, what was
bought) and becomes a **draft PO** in Odoo with:

| In Odoo | What goes there |
| --- | --- |
| Vendor Reference | `FLT/KOFI/005`: their reference and the receipt's number |
| Source Document | `FLT/KOFI/005 · Float · Kofi Test` |
| The line | what was bought, with "(Kofi Test's float)" |
| A note | whose float, when it was last given, the reference |
| Attachment | the receipt |

In Odoo's list of POs, search `FLT/KOFI` to see every PO from Kofi's float.

## What they hold

**Given − given back − receipts.** A receipt counts as soon as it is sent
("Being checked"). It is **accepted** once its PO is confirmed in Odoo. It is
**refused**, and no longer counts, when its PO is cancelled in Odoo or an
admin presses **Refuse…** with a reason (they see the reason). A receipt that
could not be read counts nothing until it is filled in (**Fill it in** opens
the usual ＋ PO form; its PO still gets the reference). The same picture sent
twice counts once.

### A PO changed in Odoo

When a receipt's PO is changed in Odoo to another total (GH₵2,200 on the
receipt, GH₵2,250 on the PO), the receipt's own amount still counts, and both
are asked. On their page the person sees **The PO was changed in Odoo to …**,
in a box at the top and on the receipt, with **Yes** or **No, it is not
right**; saying Yes, they say why the amount changed, which an admin sees. In Buying › Floats the receipt says what changed and what they said,
with **Accept** or **Keep** for an admin; until then it counts among the
receipts to look at. The new total counts once they accept it, unless an
admin keeps the receipt's amount: an admin's answer stands over theirs, and
**Change** takes it off. The person is asked only when the PO changed within
30 days of their sending the receipt; after that, only an admin is asked
(their page says the office will decide). Changed again in Odoo, both are asked again;
changed back to the receipt's amount, nothing is asked.

## Notes on money given

Every amount given can carry a note: typed in **Note on this money** when it
is given, or added and changed later on the person's page (**＋ Add a note**
or **Change the note** under the line, admins). The note shows who wrote it
last, and goes on their page and on the statement, under the line. A receipt's note is what the person typed when sending it.

## Statements

On a person, **⬇ Statement**: choose the dates, then

- **Open to print or save as PDF**: what they held at the start, every amount
  given, spent and given back, by month, with its note, the receipt's state,
  reference and PO, the balance after each line, what they hold at the end,
  and lines to sign; or
- **Spreadsheet (CSV)**: the same, for Excel.

## For whoever runs it

- `src/routes/floats.js`: people, money given and back, receipts, their link,
  statements. `src/routes/receipts.js` reads the receipt and makes the PO
  (`mark` carries the reference); `src/connectors/odoo.js` `createDraftPo`
  sets `partner_ref`.
- `public/js/views/floats.js` (Buying › Floats), `public/float.html` and
  `public/js/float.js` (their link).
- Tables `float_person`, `float_move`, `float_receipt` (migration 0040).
