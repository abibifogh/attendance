import { emptyBundle } from './bundle.js';
import { getJson, getPaged } from './http.js';
import { minor } from '../lib/money.js';

/**
 * The restaurant POS, over its read-only reporting API.
 *
 * The POS is on Appwrite, in somebody else's account as far as this Worker is
 * concerned, so unlike attendance and breakfast there is no database to bind.
 * It offers exactly what is needed instead: a documented, read-only, key-gated
 * `/reports/*` API that hands out orders, payments, shifts and expenses and
 * refuses to hand out a customer's email address. See doc 18 in that repo.
 *
 * Two things about it shape this file.
 *
 * Money already arrives as whole minor units, which is the convention this
 * warehouse uses throughout, so nothing here multiplies by a hundred. Doing it
 * anyway would inflate the restaurant's takings by a factor of a hundred and,
 * because every other source needs converting, that is an easy mistake to make
 * once and never catch.
 *
 * And the API can legitimately be switched off — its execute permission is
 * empty by default. A 503 from it is a configuration state, not a fault, and
 * the run log says so rather than raising an alarm every night.
 */

/** Which side of the business a POS venue or module belongs to. */
function lineFor(row) {
  const text = `${row?.module || ''} ${row?.venue_name || ''} ${row?.venue_id || ''}`.toLowerCase();
  if (/bar|pub|lounge/.test(text)) return 'bar';
  return 'restaurant';
}

export async function pull({ config, token, from, to }) {
  const bundle = emptyBundle();
  const base = String(config?.base || '').trim();
  if (!base) {
    bundle.notes.push('No POS reporting address is configured.');
    return bundle;
  }
  if (!token) {
    bundle.notes.push('No POS reporting key is set on this Worker.');
    return bundle;
  }

  const range = { from, to };

  // Staff first: every later row refers to a person by id, and a variance
  // attributed to "68a1f3c2" helps nobody.
  const staff = await getPaged(base, '/reports/staff', {}, { token }).catch(() => []);
  const staffName = new Map();
  for (const row of staff) {
    const id = String(row.id ?? row.$id ?? '');
    if (!id) continue;
    staffName.set(id, row.name || null);
    bundle.people.push({
      externalId: id,
      name: row.name || id,
      jobTitle: row.role || null,
      line: 'restaurant',
      active: row.active !== false,
    });
  }

  // ------------------------------------------------------------- orders --
  const orders = await getPaged(base, '/reports/orders', { ...range, limit: 500 }, { token });
  const byDay = new Map();
  const dayBucket = (day, line) => {
    const key = `${day}|${line}`;
    if (!byDay.has(key)) {
      byDay.set(key, {
        day, line, gross: 0, discounts: 0, net: 0, collected: 0, outstanding: 0,
        cash: 0, card: 0, other: 0, orders: 0, covers: 0, units: 0,
      });
    }
    return byDay.get(key);
  };

  for (const order of orders) {
    const day = dayOf(order.closed_at || order.created_at || order.at);
    if (!day || day < from || day > to) continue;
    const bucket = dayBucket(day, lineFor(order));
    bucket.orders += 1;
    bucket.covers += Number(order.covers) || 0;
    bucket.gross += minor(order.subtotal ?? order.gross ?? order.total);
    bucket.discounts += minor(order.discount_total ?? order.discounts);
    bucket.net += minor(order.total ?? order.net);
  }

  // --------------------------------------------------------- payments ----
  // Counted separately and by when the money moved, not by when the order was
  // placed. A bill opened on Friday and settled on Saturday is Friday's sale
  // and Saturday's cash, and a dashboard that confuses the two makes every
  // shift reconciliation look wrong.
  const methods = await getPaged(base, '/reports/payment_methods', {}, { token }).catch(() => []);
  const methodKind = new Map();
  for (const m of methods) {
    const id = String(m.id ?? m.$id ?? '');
    const text = `${m.kind || ''} ${m.name || ''}`.toLowerCase();
    methodKind.set(id, /card|visa|master|pos\s*terminal/.test(text) ? 'card'
      : /cash/.test(text) ? 'cash' : 'other');
  }

  for (const payment of await getPaged(base, '/reports/payments', { ...range, limit: 500 }, { token })) {
    const day = dayOf(payment.at || payment.created_at);
    if (!day || day < from || day > to) continue;
    if (payment.voided || payment.refunded) continue;
    const bucket = dayBucket(day, lineFor(payment));
    const amount = minor(payment.amount);
    bucket.collected += amount;
    const kind = methodKind.get(String(payment.method_id ?? '')) || guessTender(payment);
    if (kind === 'card') bucket.card += amount;
    else if (kind === 'cash') bucket.cash += amount;
    else bucket.other += amount;
  }

  for (const bucket of byDay.values()) {
    bucket.outstanding = Math.max(0, bucket.net - bucket.collected);
    bundle.revenue.push(bucket);
    if (bucket.covers) bundle.demand.push({ day: bucket.day, covers: bucket.covers });
  }

  // --------------------------------------------------------- expenses ----
  for (const expense of await getPaged(base, '/reports/expenses', { ...range, limit: 500 }, { token }).catch(() => [])) {
    const day = dayOf(expense.at || expense.created_at);
    if (!day || day < from || day > to) continue;
    bundle.costs.push({
      day, line: lineFor(expense),
      category: expense.category || 'shift expenses',
      supplierName: expense.payee || expense.supplier || null,
      amount: minor(expense.amount),
    });
  }

  // ----------------------------------------------------------- shifts ----
  // The variance column is the reason this connector bothers with shifts at
  // all. On its own it is a note in a POS; joined to attendance it becomes the
  // only evidence the group has about who is on the floor when money is short.
  for (const shift of await getPaged(base, '/reports/shifts', { ...range, limit: 500 }, { token }).catch(() => [])) {
    const day = dayOf(shift.closed_at || shift.opened_at);
    if (!day || day < from || day > to) continue;
    const expected = minor(shift.expected_cash ?? shift.expected);
    const counted = minor(shift.counted_cash ?? shift.counted);
    const staffId = String(shift.closed_by ?? shift.opened_by ?? '');
    bundle.cashControl.push({
      day,
      externalId: String(shift.id ?? shift.$id ?? `${day}-${staffId}`),
      line: lineFor(shift),
      shift: shift.name || shift.label || '',
      personExternalId: staffId || null,
      personName: staffName.get(staffId) || null,
      expected,
      counted,
      variance: minor(shift.variance ?? (counted - expected)),
    });
  }

  // -------------------------------------------------------- purchases ----
  for (const line of await getPaged(base, '/reports/movements', { ...range, limit: 500 }, { token }).catch(() => [])) {
    if (String(line.kind || line.direction || '').toLowerCase() !== 'in') continue;
    const day = dayOf(line.at || line.created_at);
    if (!day || day < from || day > to) continue;
    const qty = Number(line.qty) || 0;
    const unitCost = minor(line.unit_cost);
    bundle.purchaseLines.push({
      day,
      externalId: `pos-movement:${line.id ?? line.$id}`,
      line: 'restaurant',
      itemName: line.ingredient_name || line.item_name || 'unnamed',
      unit: line.unit || null,
      supplierName: line.supplier_name || null,
      qty,
      unitCost,
      amount: minor(line.value ?? Math.round(unitCost * qty)),
    });
  }

  bundle.notes.push(`${orders.length} orders, ${bundle.cashControl.length} shifts`);
  return bundle;
}

/** Is the reporting API answering, and does it like the key? */
export async function check({ config, token }) {
  const base = String(config?.base || '').trim();
  if (!base) return { ok: false, detail: 'No address configured' };
  if (!token) return { ok: false, detail: 'No key set' };
  const body = await getJson(new URL('/reports', base).toString(), { token });
  return { ok: body?.ok !== false, detail: `${(body?.resources || body?.data || []).length || 0} resources offered` };
}

const dayOf = (value) => (typeof value === 'string' && value.length >= 10 ? value.slice(0, 10) : null);

function guessTender(payment) {
  const text = `${payment.method || ''} ${payment.method_name || ''} ${payment.kind || ''}`.toLowerCase();
  if (/card|visa|master/.test(text)) return 'card';
  if (/cash/.test(text)) return 'cash';
  if (/momo|mobile|mtn|vodafone|telecel|airtel/.test(text)) return 'other';
  return 'other';
}
