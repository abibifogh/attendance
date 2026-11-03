# Stock from Odoo

The breakfast store and the Maintenance store fill themselves from Odoo.
Nobody types a PO number into either store any more.

**Buying & stock › Stock from Odoo** (admins) shows every line of every confirmed PO,
where it went, and the settings.

## How it works

1. A PO is confirmed in Odoo. It can be bought by anybody, or made from a float
   receipt.
2. Every 15 minutes, Insight reads each line of every PO confirmed on or after
   the first day.
3. Insight offers each line to the breakfast store first. Whatever breakfast
   does not take goes to the Maintenance store.
   - Each store keeps its own list of which Odoo product is which of its items.
     It is the same list its own "bring a PO in" uses.
   - Each store turns the quantity and price into its own unit. For example, a
     crate of 30 eggs at GH₵ 95 becomes 30 eggs at GH₵ 3.17.
4. A product neither store knows becomes **Which store?** in To sort out, for
   the person chosen. They pick:
   - the breakfast store or the Maintenance store, with its item (or a new one)
     and how many of the store's unit one Odoo unit is; or
   - **Not stock** (fuel, services, transport).

   The answer is written into that store's list, and the other store is told
   the product is not theirs. It is asked once per product. Every later PO with
   that product goes there too.
5. A product both stores say is not theirs is left alone.

Insight never counts or changes stock itself. Each store records it, by its
own rules: day locks, where deliveries go, who may receive.

## When it becomes stock

An admin chooses, under **When it becomes stock**:

| Choice | What happens |
|---|---|
| As soon as the PO is confirmed in Odoo (the default) | Recorded straight away. Nobody taps anything in the store. |
| When the storekeeper says Received | The line shows as **On its way** in the store's Deliveries, filled in. The storekeeper taps Received, changing the number if the delivery is short. |
| When the receipt is validated in Odoo | Only once Odoo says the line is received, for what it received. |

## Other settings

- **"Which store?" is asked of**: an active supervisor or admin. If nobody is
  chosen, the question is shared out like other to-dos.
- **Start from POs confirmed on**: 4 November 2026. Earlier POs are left as
  they are. They can still be brought in by number in each store.
- Lines already brought in by hand are skipped, so nothing goes on the shelf
  twice.

## What else lands in To sort out

- **Delivered short**: the storekeeper received less than the PO.
- **Not received yet**: still on its way three days after it was offered.
  This closes by itself once it is received or cancelled.
- **Cancelled PO, stock stayed**: the PO was cancelled in Odoo after its stock
  went in, and the store could not take it back (for example, a locked day).
  Correct the count in the store.

Each of these is also told to the chosen person (Notifications, and pushed).

## If a store does not answer

Its lines wait and are offered again 15 minutes later. The page says which
store was not read. Nobody is asked "Which store?" until both stores have
answered.

## Behind it

| Store | How Insight reaches it |
|---|---|
| Breakfast | `POST /api/link/stock` on the breakfast app, signed with `SSO_SECRET_BREAKFAST` |
| Maintenance | The `assets` function, signed with `SSO_SECRET_MAINTENANCE` (`INSIGHT_APPROVALS_SECRET` there) |

- Actions: `offer`, `status`, `cancel`, `items`, `map`.
- What Insight keeps:
  - `stock_line`: each Odoo line, the store it went to, and what the store said;
  - `stock_product`: products said to be not stock;
  - the setting `stock_feed`.
