# Fixed assets

Buying › **Fixed assets** (admins): Insight finds the fixed assets in Odoo,
an admin confirms each, and Maintenance keeps them: where each is, and its
servicing.

## What Insight reads from Odoo

Read-only, each night with the other systems, and on **Read Odoo now**:

- **Odoo's Assets app**, where it is installed: every asset except asset
  models and cancelled ones. Odoo without the app is fine: the accounts below
  are read instead.
- **The fixed asset accounts** (account type "Fixed Assets"): every posted
  debit, whatever the document (a bill, a journal entry, an opening balance).
  Depreciation credits them, so it is left out. A line already covered by an
  asset in the Assets app is not shown twice.
- **New purchases**: posted vendor bill lines, from the last two years (or
  the day set in the rules), that cost enough to be an asset.

## What counts (Rules)

A purchase is put up for review when **all** of these hold:

- its name has a word that points to an asset (freezer, AC, pump, generator,
  mattress, …), matched whole (“AC” is not in “vacuum”; plurals count);
- it has none of the words that never are (repair, service, fuel, parts, …);
- it costs at least **GH₵ 2,000 each**, or **GH₵ 10,000 on one line** (ten
  mattresses at GH₵ 1,450).

The amounts, both lists of words, and from when purchases are read are an
admin's to change under **Rules**. Everything on the fixed asset accounts is
always read, whatever its name or amount.

## Deciding

- **It's an asset** (or **Put on the register**, for one already on an asset
  account) opens a panel: how many, and for each its **NCA tag** (NCA-0001,
  one higher than any given before or on the register), a name and a room or
  area from Maintenance; then how often it is serviced (none, every month, 3
  months, 6 months, a year), the first service, and whether our artisans or
  the supplier service it. **Add to the register** puts each on Maintenance's
  equipment register with its cost (the line shared out), supplier, date and
  Odoo document.
- **Not an asset** is remembered for that product: a new purchase of it is
  kept as not an asset and not asked about. **Put back** under *Not assets*
  undoes it.
- A purchase booked to an expense account says so (*⚠ Booked to 6200 Repairs
  & maintenance, an expense*), for the accountant to move it. Insight never
  changes Odoo.

## In Maintenance

Rooms › **Equipment** shows each with its tag, cost and where its servicing
stands (overdue, due within 30 days, up to date), with a strip counting each.
Its servicing is a planned task (category *Servicing*, every N months), which
becomes a job on its day like every planned task; the job done is the service
done. **Move to another room** keeps where it has been and who moved it, and
its servicing follows it. See the Maintenance repository
(`db/maintenance/supabase/functions/assets/`, migration `20261112100000`).

## Tabs and totals

- **To review**: what waits for a decision.
- **In the asset account**: everything from the Assets app and the asset
  accounts, with whether it is on the register.
- **On the register**: Maintenance's register, by room, with each one's tag,
  cost and next service, or how many days its service is late.
- **Not assets**, and **Rules**.

The tiles: to review, in the asset account (and how many are not on the
register yet), on the register (in how many rooms), and services late or due
within 30 days. **Today** tells admins how many wait for review and which
assets are overdue for service.

## For whoever runs it

- `src/connectors/odoo.js` `fixedAssetData`: the four reads.
- `src/routes/fixedassets.js`: the rules, picking out (`looksLikeAsset`,
  `itemsFrom`), `scan`, `register`, `decide`, the page (`faView`), Today.
- Tables `fa_item`, `fa_not_asset`, `fa_tag` (migration 0064).
- Maintenance is called at its `assets` function: `MAINTENANCE_ASSETS_URL`, or
  next to `MAINTENANCE_APPROVALS_URL`, signed with `SSO_SECRET_MAINTENANCE`.
- Endpoints (admins): `GET /api/assets`; `POST /api/assets/scan`,
  `/api/assets/rules`, `/api/assets/register`, `/api/assets/decide`.
