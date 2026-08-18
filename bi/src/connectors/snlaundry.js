import { emptyBundle } from './bundle.js';
import { getJson } from './http.js';
import { toMinor } from '../lib/money.js';

/**
 * The laundry, over its revenue report.
 *
 * The laundry is a Netlify app keeping its data in Netlify Blobs, so there is
 * no database to read and no cursor-paged export: there is one report endpoint
 * that already does the aggregation, and it does it thoughtfully. It separates
 * what was *charged* (by the day an order was accepted) from what was
 * *collected* (by the moment a payment was taken, and by whom), which is the
 * distinction most small systems get wrong and the one that makes the
 * laundry's numbers usable beside the POS's without adjustment.
 *
 * Money comes back as cedis with decimals, so every figure is converted once,
 * here, and is whole pesewas everywhere after this file.
 *
 * The laundry is the smallest line in the group and the one most worth
 * watching, because it is the only one that routinely lets guests leave
 * without paying — `outstanding` is a real number here in a way it is not
 * anywhere else, and it is money the group has earned and not been given.
 */

export async function pull({ config, token, from, to }) {
  const bundle = emptyBundle();
  const base = String(config?.base || '').trim();
  if (!base) {
    bundle.notes.push('No laundry address is configured.');
    return bundle;
  }
  if (!token) {
    bundle.notes.push('No laundry staff token is set on this Worker.');
    return bundle;
  }

  const url = new URL('/api/report', base);
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  const report = await getJson(url.toString(), { token });

  const staffSeen = new Map();
  const noteStaff = (name) => {
    if (!name) return;
    const key = String(name).trim().toLowerCase();
    if (!key || staffSeen.has(key)) return;
    staffSeen.set(key, true);
    bundle.people.push({ externalId: key, name: String(name).trim(), line: 'laundry', active: true });
  };
  for (const person of Object.values(report?.staff || {})) noteStaff(person?.name);

  // The daily breakdown carries revenue, orders, loads and items. Collected
  // and outstanding are reported for the window as a whole rather than per
  // day, so they are apportioned across the days by that day's share of the
  // charged revenue. That is an approximation and it is written down as one:
  // it keeps a month's totals exactly right and a single day's collection
  // figure indicative. Nothing in this app decides anything on one day's
  // laundry collection alone.
  const days = Array.isArray(report?.byDay) ? report.byDay : [];
  const chargedTotal = days.reduce((sum, d) => sum + toMinor(d.revenue), 0);
  const collectedTotal = toMinor(report?.collected);
  const cashTotal = toMinor(report?.byMethod?.cash);
  const cardTotal = toMinor(report?.byMethod?.card);
  const outstandingTotal = toMinor(report?.outstanding);

  let collectedAllocated = 0;
  let cashAllocated = 0;
  let cardAllocated = 0;
  let outstandingAllocated = 0;

  days.forEach((row, index) => {
    const day = String(row.date || '').slice(0, 10);
    if (!day) return;
    const net = toMinor(row.revenue);
    const last = index === days.length - 1;
    // The last day takes the rounding, so the parts add up to the whole.
    const share = (total, allocated) => {
      if (last) return Math.max(0, total - allocated);
      if (!chargedTotal) return 0;
      return Math.round((total * net) / chargedTotal);
    };
    const collected = share(collectedTotal, collectedAllocated);
    const cash = share(cashTotal, cashAllocated);
    const card = share(cardTotal, cardAllocated);
    const outstanding = share(outstandingTotal, outstandingAllocated);
    collectedAllocated += collected;
    cashAllocated += cash;
    cardAllocated += card;
    outstandingAllocated += outstanding;

    bundle.revenue.push({
      day, line: 'laundry',
      gross: net, discounts: 0, net,
      collected, outstanding,
      cash, card, other: 0,
      orders: Number(row.orders) || 0,
      covers: 0,
      units: Number(row.loads) || 0,
    });
    bundle.demand.push({
      day,
      laundryOrders: Number(row.orders) || 0,
      laundryLoads: Number(row.loads) || 0,
    });
  });

  // Shift totals become cash-control rows so the laundry sits on the same
  // screen as the POS. There is no float and no drawer count here — the
  // laundry never counts cash — so `expected` and `counted` are equal and the
  // variance is always zero. What the row carries is who collected what, which
  // is the half of cash control this line actually has.
  for (const [name, bucket] of Object.entries(report?.byShift || {})) {
    const collected = toMinor(bucket?.collected);
    if (!collected) continue;
    bundle.cashControl.push({
      day: to,
      externalId: `laundry-shift:${from}:${to}:${name}`,
      line: 'laundry',
      shift: name,
      personName: null,
      expected: collected,
      counted: collected,
      variance: 0,
      note: 'The laundry does not count a drawer; this records who took what.',
    });
  }

  bundle.notes.push(`${days.length} days, ${Object.keys(report?.staff || {}).length} staff`);
  return bundle;
}

export async function check({ config, token }) {
  const base = String(config?.base || '').trim();
  if (!base) return { ok: false, detail: 'No address configured' };
  const body = await getJson(new URL('/api/health', base).toString(), { token });
  return { ok: body?.ok === true, detail: body?.storage?.mode || 'answered' };
}
