# Floats

Money given to people to spend: a driver for market runs, a housekeeper for
supplies. They send a picture of each receipt from their own link; each
becomes a draft PO in Odoo marked with **their reference**, and comes off what
they hold.

## Giving money (Money › Floats)

- **＋ Give money**: choose the person, or somebody new (their name and their
  reference, e.g. `KOFI`), how much, the day, and where it came from (the
  safe, the bank, a drawer). Somebody new gets a reference and a link.
- **🔗 Their link**: a short one, `insight.niceoperation.com/float/igna`:
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

## Their receipts

On their link they see what they still hold, add receipts (one or several
pictures, or a PDF), and see each one's state: Being checked, ✓ Accepted,
✕ Refused (with why), or Could not be read (the office fills it in).

Each receipt is read like Money › Receipts (vendor, total, date, what was
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

## Notes on money given

Every amount given can carry a note: typed in **Note on this money** when it
is given, or added and changed later on the person's page (**＋ Add a note**
or **Change the note** under the line, admins). The note shows who wrote it
last, and goes on the statement in its own Note column, with what was given
or given back. A receipt's note is what the person typed when sending it.

## Statements

On a person, **⬇ Statement**: choose the dates, then

- **Open to print or save as PDF**: what they held at the start, every amount
  given, spent and given back with its note, references and POs, what they hold at the
  end, and lines to sign; or
- **Spreadsheet (CSV)**: the same, for Excel.

## For whoever runs it

- `src/routes/floats.js`: people, money given and back, receipts, their link,
  statements. `src/routes/receipts.js` reads the receipt and makes the PO
  (`mark` carries the reference); `src/connectors/odoo.js` `createDraftPo`
  sets `partner_ref`.
- `public/js/views/floats.js` (Money › Floats), `public/float.html` and
  `public/js/float.js` (their link).
- Tables `float_person`, `float_move`, `float_receipt` (migration 0040).
