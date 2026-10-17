# Create PO

**＋ PO** in Insight's header makes a draft purchase order in Odoo from any
screen, on a phone or a computer. Admins only for now.

## Filling it in

Three details are enough: **Vendor** (picked from Odoo's vendors as you
type), **Amount** in GH₵ and **Description**. The **Date** is today unless
changed. **Item in Odoo** (the product on the PO line, which Odoo needs) is
matched from the description; choose another if it is wrong. When no item's
name shares the description's words, the reader picks the nearest by meaning
("Diesel Excellium" is Fuel): green if it is sure, amber with "check it" if
not.

Or let Insight fill it in, under **Fill it in for me**:

- **A sentence**, like "create PO for fuel 800ghs with today's date", then
  **Read**. "today" and "yesterday" are understood. When no vendor is named,
  the vendor of the last PO for that item is suggested.
- **A receipt** (📎): a photo, or a PDF up to 5 MB. The seller, the total, the
  date and what was bought are read off it, and the receipt is attached to the
  PO in Odoo. A PDF that is a scan with no text in it cannot be read: take a
  photo of it instead.

Green is what was read; amber is for you to choose or check. Nothing is ever
guessed: a number the reader is not sure of is left empty. The reader is
Cloudflare's Workers AI, the same one that reads the Nice Place counters; if
it cannot be reached, a sentence is still read for its amount and date, and a
receipt is filled in by hand (it is still attached).

## Before it is created

**Check** shows the PO as it will be, and warns when Odoo already has a PO to
the same vendor on the same day for the same amount (within GH₵1): create it
anyway only if it is a second purchase.

## In Odoo

**Create in Odoo** makes a **draft** (a request for quotation) with one line:
the item, the description, quantity 1, at the amount. Its Source Document says
`Insight · <your name>`. Approving it stays in Odoo, as for any PO. If the
item carries a tax in Odoo, Odoo adds it, and Insight says the total Odoo now
shows.

Insight never creates a vendor, and never changes, approves or deletes a PO:
the only things it creates in Odoo are the draft and the receipt attached to
it. Each PO made is also kept in Insight (`po_created`), with who made it.

## Paid from a shift's drawer

A PO made here is **not** a shift's expense unless an admin allows it, so an
admin's own PO (a water bill paid by MoMo from the office, say) can never be
used to cover cash missing from a drawer.

- **When making it:** tick **Staff may pay this from a drawer** if the cash for
  it will come out of a drawer. Left off, it is not allowed (yet).
- **When staff try:** a member of staff who types it on a closing report (or
  as the PO for cash out on their list) is told it is waiting for an admin,
  and the admins are asked: Shifts › Inbox › Waiting for admin, "Ama wants to
  pay P02517 from a drawer". **Allow on a shift**, or **Refuse** with a reason
  (then it can never go on a shift). Once allowed, "check again" on HIVE
  counts it like any other PO.
- A PO already paid from a drawer is not affected.
