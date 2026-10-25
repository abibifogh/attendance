# Receipts into draft POs

Two ways to turn receipts into draft purchase orders in Odoo, with no form to
fill in:

1. **In Insight:** ＋ PO › **Just the receipts**, or Money › Receipts ›
   **＋ Add receipts**. Take pictures, or choose several photos or PDFs, and
   press **Make the draft POs**. Each one is read and becomes a draft.
2. **By email:** send or forward the receipts to the receipts address (for
   example `receipts@po.niceoperation.com`) from an address on the list. Each
   photo or PDF attached (ten at most in one email) becomes a draft. A
   minute later you get a reply saying what became of each.

The one-at-a-time ＋ PO form is still there for when you want to check each
one before it goes to Odoo.

## What Insight does with each receipt

- **Reads it:** who sold it, the total, the date, what was bought. A line in
  the email (or the "what they are" box) is used as a hint.
- **Matches it to Odoo:** the vendor and the item, as the ＋ PO form does.
  Insight never creates a vendor. When no item's name shares the words of
  what was bought, the reader picks the nearest item in Odoo by meaning
  ("Diesel Excellium" goes on Fuel, a pulley on spare parts). The list says
  "picked by the reader", and so does the note on the PO. If the reader is
  not sure, the PO is marked to check and the accountant gets a To-Do. Only
  when nothing fits is the placeholder item used.
- **Makes a draft PO** with the receipt attached, and a note on the PO of
  exactly what was read. Approving stays in Odoo.
- **Vendor or item not in Odoo:** the PO uses the placeholders you choose in
  Settings ("Vendor to confirm", "Item to classify"). Odoo needs an item on
  every priced PO line (only notes and section headings can be text alone,
  and they carry no price), so the line goes on the placeholder item and its
  label is the receipt's own words, e.g. "Diesel Excellium". With the
  placeholder vendor, the seller's name is added to the label: "Cash blower
  blaster (from Ike Automobile Machine Shop)". The person you choose
  gets a **To-Do in Odoo** on that PO saying exactly what to change. Complete
  ones get no To-Do.
- **Seen before:** the same file sent twice, or a PO already in Odoo for the
  same vendor, day and amount, is said, with the PO it looks like and the date
  read off the receipt, and no PO is made yet. You decide: **Make it anyway**
  (a different receipt: another day misread, two of the same bought) makes the
  draft PO from the receipt kept here; **It is the same** sets it aside and
  lets its file go. Both are on the upload form and in Money › Receipts.
- **Could not be read** (too dark, cut off, an iPhone HEIC picture), or Odoo
  refused it: no PO is made. The receipt is kept, and **Fill it in** opens the
  usual ＋ PO form with the receipt already there. **Try again** reads it
  again and makes the PO, for instance once the placeholders are chosen
  (**Try all again** does every one). **Set aside** takes off the list one
  that is not a receipt.

A PO made this way is like any PO made in Insight: staff cannot put it on a
shift's expenses unless an admin allows it.

## Money › Receipts

Every receipt, newest first: how it came in and from whom, what was read,
the PO it became (with **Open in Odoo**), and what to check. **To look at**
shows only those needing something. At the bottom, every email that came to
the address and what was done with it, so a sender not on the list is seen.

## Settings (Money › Receipts › Settings)

- **Vendor used when the receipt's seller is not in Odoo:** make a contact in
  Odoo called "Vendor to confirm" once, then type its name here and pick it.
  Odoo is searched as you type, so a contact made a minute ago is found (Odoo
  itself lists a contact as a vendor only once a purchase or bill has used it).
- **Item used when what was bought is not matched:** a product in Odoo with
  "Can be purchased" ticked, such as "Item to classify", found by typing its
  name. One without that tick is shown, and says so.
- **Who gets a To-Do:** the accountant.
- **The receipts email address:** what you set up below, shown on the page.
- **Who may email receipts in:** one address per line. Anything from anybody
  else is ignored and listed. An email that the receiving server says is not
  really from that address (SPF, DKIM or DMARC failed) is ignored too.

Until both placeholders are chosen, a receipt whose vendor or item is not in
Odoo is kept with no PO.

## Setting up the email address (once, in Cloudflare)

The address lives on its own sub-address (`po.niceoperation.com`), so the
email you already use on niceoperation.com is not touched.

1. In Cloudflare, open the **niceoperation.com** domain, then **Email** ›
   **Email Routing**. (In the newer dashboard: **Compute** › **Email Service**
   › **Email Routing**, then choose niceoperation.com.)
   - If Email Routing is not switched on yet and Cloudflare offers to add or
     replace the **MX records for niceoperation.com itself**, stop. Those
     records are what deliver your existing email. Ask for help before going
     on.
2. Open **Settings** › **Subdomains**, type `po`, and add it. Cloudflare adds
   the records for `po.niceoperation.com` only. Wait a few minutes.
3. Open **Routing rules** › **Create address**. Choose the `po` subdomain,
   type `receipts` as the address, set the action to **Send to a Worker**, and
   choose **niceoperation-insight**. Save.
4. In Insight, open Money › Receipts › Settings. Type
   `receipts@po.niceoperation.com` as the address, list who may send, choose
   the placeholders and the accountant, and press **Save**.
5. Send one receipt from an address on the list. It shows in Money ›
   Receipts, and the reply comes back by email.

The reply is sent through HIVE's email, like Insight's other emails, so HIVE's
email must be set up (it already is if HIVE sends notices by email).

## For whoever runs it

- `bi/src/routes/receipts.js`: reading, matching, making the PO, the list,
  the settings, the email.
- `bi/src/lib/mime.js`: takes an email apart.
- `bi/src/index.js`: the Worker's `email` handler.
- Tables: `receipt`, `receipt_file` (a file is kept only while it is needed
  here), and `receipt_mail` (migration 0036).
- Odoo: the draft PO, an attachment, a note (`message_post`) and a To-Do
  (`activity_schedule`). Insight's Odoo login needs to be allowed to do all
  four. Creating POs and attaching files it can already do.
