/**
 * Which way each difference's money goes, so a set of them can be seen to
 * net out. Pure: shared by the reconciliations (routes/shifts.js), staff
 * accounts and suspense (routes/till.js, routes/suspense.js), and set the
 * same way as the Shifts screen has it.
 */

/**
 * Which way an exception's money goes, in minor units: plus is money in that
 * ASSD does not show, minus is money ASSD shows that is not there. Null when
 * its kind has no amount that nets against others. As the Shifts screen has it.
 */
export function flowOf(x) {
  if (x?.amount == null) return null;
  const a = Math.abs(x.amount);
  if (['not-recorded', 'bank-only', 'double-charge', 'paid-more', 'refund'].includes(x.kind)) return a;
  if (['not-found', 'failed', 'zero', 'never-settled', 'reversal', 'duplicate', 'paid-less'].includes(x.kind)) return -a;
  // The laundry is ASSD less the laundry system, as it stands: it pulls against the
  // drawer or card difference that is the same money seen from the other side.
  if (['drawer-over', 'drawer-short', 'handover-gap', 'laundry-mismatch'].includes(x.kind)) return x.amount;
  // A card paid at the laundry and not in ASSD: money in that ASSD does not show.
  if (x.kind === 'laundry-card') return a;
  // Cash out of the drawer with no label, or as expenses with no PO: ASSD shows it gone, nothing says where.
  if (['movement-unlabelled', 'expense-no-po'].includes(x.kind)) return -a;
  // Expenses less the POs: more paid out than the POs show is minus, POs above what was paid out is plus.
  if (x.kind === 'expense-po-gap') return -x.amount;
  // A slip of the finger: ASSD has more (or less) than the terminal took.
  if (['keying', 'transposition', 'decimal'].includes(x.kind)) return x.difference == null ? null : -x.difference;
  if (x.kind === 'movement-twice') return a;
  // Cash keyed as taken while the drawer did not move: ASSD shows money that never came in.
  if (x.kind === 'keyed-no-cash') return -x.amount;
  // Money gone back out, or expected in and not there: ASSD shows money that is not there.
  if (['chargeback', 'prepaid-not-banked', 'deposit-not-banked'].includes(x.kind)) return -a;
  // Taken on the back office: money ASSD shows that the drawer never held.
  if (x.kind === 'back-office') return -x.amount;
  return null;
}

/**
 * Each exception's flow when reconciled with the others chosen. Cash keyed
 * while the drawer did not move, and a movement out keyed twice, are part of
 * their own shift's drawer difference: chosen with it, each takes back the
 * part of it that it explains, so what is left is what nothing explains.
 * With differences on other shifts each counts as it is.
 */
export const EXPLAINS_DRAWER = ['keyed-no-cash', 'movement-twice'];
export const besideOwnDrawer = (x, chosen) => EXPLAINS_DRAWER.includes(x.kind)
  && chosen.some((o) => ['drawer-short', 'drawer-over'].includes(o.kind) && o.day === x.day && o.slot === x.slot);
export function netFlows(chosen) {
  return chosen.map((x) => (besideOwnDrawer(x, chosen) ? -flowOf(x) : flowOf(x)));
}
