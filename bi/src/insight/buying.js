import { median, mad } from './stats.js';

/**
 * What the books say about buying, at the finest grain the documents allow.
 *
 * Every other cost analysis in this warehouse works from operational records —
 * the kitchen booking a delivery in, the bar counting a shelf. Those record
 * what somebody inside the business typed. A vendor bill is a document that
 * came from outside, that somebody approved, and that the accounts carry, and
 * the questions it can answer are a different set entirely.
 *
 * Pure. Nothing here reads a database or a clock: it is given rows and returns
 * findings, so every number below can be checked without a deploy. That
 * matters more here than anywhere else in the app, because these are the
 * findings somebody will take to a supplier.
 *
 * Each function returns `null` rather than a shrug when there is not enough
 * evidence. A supplier seen twice has no price trend; a month with four bills
 * has no payment pattern. Saying "no finding" is a different and more useful
 * answer than saying "0%".
 */

const sum = (list) => list.reduce((t, n) => t + (Number(n) || 0), 0);
const bp = (part, whole) => (whole ? Math.round((part / whole) * 10_000) : 0);

/* ------------------------------------------------------------ price work -- */

/**
 * What one thing cost each time it was bought, and whether that is drifting.
 *
 * The comparison is per item *and* per supplier, not per item alone. Two
 * suppliers charging different prices for the same thing is a different
 * finding from one supplier's price creeping, and mixing them produces a
 * spread that is really just the gap between two price lists — which looks
 * alarming and means nothing.
 *
 * Robust throughout: the middle price rather than the mean, and the median
 * absolute deviation rather than the standard one. A single mistyped invoice
 * line — a quantity entered as 1 instead of 100 — moves a mean enormously and
 * a median not at all, and mistyped invoice lines are common.
 */
export function priceHistory(lines, { minPurchases = 4 } = {}) {
  const groups = new Map();
  for (const line of lines) {
    const qty = Number(line.qty) || 0;
    const unitCost = Number(line.unit_cost ?? line.unitCost) || 0;
    // A credit note is a negative line and is not a price observation. A free
    // line is not one either: a unit cost of nothing is a promotion or an
    // error, and averaging it in makes every real price look inflated.
    if (qty <= 0 || unitCost <= 0) continue;

    const key = `${line.item_id ?? line.itemId}|${line.supplier_id ?? line.supplierId}`;
    const group = groups.get(key) || {
      itemId: line.item_id ?? line.itemId,
      item: line.item || line.itemName || '',
      supplierId: line.supplier_id ?? line.supplierId,
      supplier: line.supplier || line.supplierName || '',
      unit: line.unit || null,
      points: [],
    };
    group.points.push({ day: line.day, unitCost, qty, amount: Number(line.amount) || 0 });
    groups.set(key, group);
  }

  const out = [];
  for (const group of groups.values()) {
    if (group.points.length < minPurchases) continue;
    group.points.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

    const prices = group.points.map((p) => p.unitCost);
    const mid = median(prices);
    const spread = mad(prices);

    // Lines a long way from the middle price.
    //
    // Reported rather than smoothed away, because the median that makes this
    // analysis robust also makes a single wild line invisible: four purchases
    // at 2,000 and one at 200,000 have a median absolute deviation of exactly
    // zero, so the price reads as perfectly stable and the one line worth
    // looking at is the one nobody is shown.
    //
    // Two tests, because either alone fails. Three MADs catches a price that
    // is drifting among prices that vary; half the median catches a lone
    // mistyped line among prices that do not vary at all, where the MAD is
    // zero and no multiple of it can catch anything.
    const far = Math.max(spread * 3, mid * 0.5);
    const isOutlier = (p) => Math.abs(p.unitCost - mid) > far;

    const outliers = group.points
      .filter(isOutlier)
      .map((p) => ({
        ...p,
        awayBp: mid > 0 ? bp(p.unitCost - mid, mid) : 0,
      }))
      .sort((a, b) => Math.abs(b.unitCost - mid) - Math.abs(a.unitCost - mid));

    // Every price *except* the ones already reported as not looking like a
    // price.
    //
    // This is not tidying. A single bread line keyed at 925 instead of 9.25
    // dragged one supplier's average to eleven times the other's, and the
    // screen's top finding became "Makola Fresh charge 946% more for bread",
    // ranked first, worth thousands — an entirely invented accusation about a
    // real supplier, produced by one typo.
    //
    // So the comparison price is struck on the clean lines, and the bad line
    // is reported on its own where it can be fixed. What was actually spent
    // still counts everything: the money left the account whatever the line
    // said.
    const clean = group.points.filter((p) => !isOutlier(p));
    const usable = clean.length ? clean : group.points;

    const cleanQty = sum(usable.map((p) => p.qty));
    const weighted = cleanQty > 0
      // Weighted by quantity, because what the business actually paid on
      // average is not the average of the prices. Buying one crate dear and a
      // hundred cheap is a cheap year, and an unweighted mean says otherwise.
      ? Math.round(sum(usable.map((p) => p.unitCost * p.qty)) / cleanQty)
      : mid;

    const first = usable[0];
    const last = usable[usable.length - 1];
    const totalQty = sum(group.points.map((p) => p.qty));

    out.push({
      ...group,
      outliers,
      purchases: group.points.length,
      totalQty,
      spend: sum(group.points.map((p) => p.amount)),
      median: mid,
      mad: spread,
      weighted,
      first: first.unitCost,
      latest: last.unitCost,
      firstDay: first.day,
      latestDay: last.day,
      // Against the middle price rather than the first, so one cheap
      // introductory invoice does not make every later one look like a rise.
      moveBp: mid > 0 ? bp(last.unitCost - mid, mid) : 0,
      // How unstable this price is, as a share of itself. A supplier whose
      // price moves 2% is doing business; one whose price moves 40% either has
      // a volatile input or is not quoting the same thing each time.
      volatilityBp: mid > 0 ? bp(spread, mid) : 0,
    });
  }
  return out.sort((a, b) => b.spend - a.spend);
}

/**
 * The same thing, bought from two suppliers, at two prices.
 *
 * The single most actionable purchasing finding there is, and it is invisible
 * to every system that only sees its own buying. Reported as money — what the
 * dearer buying would have cost at the cheaper price — rather than as a
 * percentage, because a 40% gap on a rarely-bought item is worth less than a
 * 6% gap on the thing the kitchen orders every week.
 */
export function priceGaps(history, { minGapBp = 500, minSpend = 5_000 } = {}) {
  const byItem = new Map();
  for (const row of history) {
    const list = byItem.get(row.itemId) || [];
    list.push(row);
    byItem.set(row.itemId, list);
  }

  const out = [];
  for (const rows of byItem.values()) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort((a, b) => a.weighted - b.weighted);
    const cheapest = sorted[0];
    const dearest = sorted[sorted.length - 1];
    if (cheapest.weighted <= 0) continue;

    const gapBp = bp(dearest.weighted - cheapest.weighted, cheapest.weighted);
    if (gapBp < minGapBp) continue;

    // What the dear buying would have cost at the cheap price. Only the
    // quantities actually bought dear — this is a size, not a promise, and
    // pretending the cheap supplier could have supplied everything is how a
    // finding stops being believed.
    const worth = Math.round((dearest.weighted - cheapest.weighted) * dearest.totalQty);
    if (worth < minSpend) continue;

    out.push({
      itemId: dearest.itemId,
      item: dearest.item,
      unit: dearest.unit,
      cheapest: { supplier: cheapest.supplier, price: cheapest.weighted, qty: cheapest.totalQty },
      dearest: { supplier: dearest.supplier, price: dearest.weighted, qty: dearest.totalQty },
      gapBp,
      worth,
      suppliers: rows.length,
    });
  }
  return out.sort((a, b) => b.worth - a.worth);
}

/* --------------------------------------------------------- the documents -- */

/**
 * Two bills that look like the same bill.
 *
 * The same supplier's own reference twice is the classic duplicate payment,
 * and it is invisible in Odoo's own lists because its internal numbers differ
 * by construction. Reported alongside the near-miss case — same supplier, same
 * amount, within a few days, different reference — which catches the same
 * invoice keyed twice with a typo in the number.
 *
 * Both are *suspicions*, and the wording has to keep saying so. A supplier who
 * bills the same round amount monthly is not a duplicate, and a report that
 * cries wolf at a standing order gets switched off.
 */
export function possibleDuplicates(bills, { withinDays = 10 } = {}) {
  const out = [];

  const byRef = new Map();
  for (const bill of bills) {
    const ref = String(bill.vendor_ref ?? bill.vendorRef ?? '').trim().toLowerCase();
    if (!ref) continue;
    const key = `${bill.supplier_id ?? bill.supplierId}|${ref}`;
    const list = byRef.get(key) || [];
    list.push(bill);
    byRef.set(key, list);
  }
  for (const list of byRef.values()) {
    if (list.length < 2) continue;
    out.push({
      kind: 'same-reference',
      confidence: 'high',
      supplier: list[0].supplier || '',
      reference: list[0].vendor_ref ?? list[0].vendorRef,
      bills: list.map((b) => ({ id: b.external_id ?? b.externalId, day: b.day, total: b.total })),
      worth: sum(list.slice(1).map((b) => b.total)),
    });
  }

  // The near miss. Same supplier, same total, close together, and not already
  // caught above.
  const seen = new Set(out.flatMap((d) => d.bills.map((b) => b.id)));
  const byAmount = new Map();
  for (const bill of bills) {
    if (seen.has(bill.external_id ?? bill.externalId)) continue;
    if (!bill.total) continue;
    const key = `${bill.supplier_id ?? bill.supplierId}|${bill.total}`;
    const list = byAmount.get(key) || [];
    list.push(bill);
    byAmount.set(key, list);
  }
  for (const list of byAmount.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => (a.day < b.day ? -1 : 1));
    for (let i = 1; i < sorted.length; i += 1) {
      if (daysBetween(sorted[i - 1].day, sorted[i].day) > withinDays) continue;
      out.push({
        kind: 'same-amount',
        confidence: 'worth a look',
        supplier: sorted[i].supplier || '',
        reference: null,
        bills: [sorted[i - 1], sorted[i]].map((b) => ({
          id: b.external_id ?? b.externalId, day: b.day, total: b.total,
        })),
        worth: sorted[i].total,
      });
    }
  }

  return out.sort((a, b) => b.worth - a.worth);
}

function daysBetween(a, b) {
  const x = Date.parse(`${a}T00:00:00Z`);
  const y = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(x) || Number.isNaN(y)) return Infinity;
  return Math.abs(y - x) / 86_400_000;
}

/**
 * Spend nobody agreed to in advance.
 *
 * A bill with no purchase order behind it is not wrong — a plumber called out
 * on a Sunday will never have one — but it is money committed without the step
 * that was meant to check it, and the share of it is the number worth
 * watching. A property where four fifths of buying skips the order is a
 * property where the purchase-order process exists on paper only.
 */
export function maverickSpend(bills) {
  const posted = bills.filter((b) => (b.state || '') === 'posted' && (b.total || 0) > 0);
  if (posted.length === 0) return null;

  const without = posted.filter((b) => !(b.from_order ?? b.fromOrder));
  const total = sum(posted.map((b) => b.total));
  const loose = sum(without.map((b) => b.total));

  const bySupplier = new Map();
  for (const bill of without) {
    const name = bill.supplier || 'Unknown supplier';
    bySupplier.set(name, (bySupplier.get(name) || 0) + bill.total);
  }

  return {
    bills: posted.length,
    withoutOrder: without.length,
    total,
    loose,
    shareBp: bp(loose, total),
    suppliers: [...bySupplier.entries()]
      .map(([supplier, amount]) => ({ supplier, amount }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 8),
  };
}

/**
 * How long the business takes to pay, and what is overdue right now.
 *
 * Days payable outstanding is a supplier-relationship number as much as a cash
 * one: a property that pays at ninety days has cheaper cash and dearer prices,
 * and the two are worth seeing together.
 *
 * `asOf` is passed in rather than read from a clock, so the same rows always
 * produce the same answer and a test does not have to be run on a Tuesday.
 */
export function payment(bills, asOf) {
  const posted = bills.filter((b) => (b.state || '') === 'posted' && (b.total || 0) > 0);
  if (posted.length === 0) return null;

  const open = posted.filter((b) => (b.residual || 0) > 0);
  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, over90: 0 };

  for (const bill of open) {
    const due = bill.due_day ?? bill.dueDay;
    const late = due ? daysPast(due, asOf) : 0;
    const amount = bill.residual || 0;
    if (late <= 0) buckets.current += amount;
    else if (late <= 30) buckets.d1_30 += amount;
    else if (late <= 60) buckets.d31_60 += amount;
    else if (late <= 90) buckets.d61_90 += amount;
    else buckets.over90 += amount;
  }

  const terms = posted
    .map((b) => {
      const due = b.due_day ?? b.dueDay;
      return due ? daysPast(b.day, due) : null;
    })
    .filter((n) => n != null && n >= 0);

  const overdue = buckets.d1_30 + buckets.d31_60 + buckets.d61_90 + buckets.over90;

  return {
    bills: posted.length,
    billed: sum(posted.map((b) => b.total)),
    outstanding: sum(open.map((b) => b.residual)),
    overdue,
    buckets,
    // The middle term rather than the mean: one bill on ninety days among
    // thirty on fourteen is not "a business that pays in twenty days".
    typicalTermDays: terms.length ? median(terms) : null,
    worstOverdue: open
      .filter((b) => (b.due_day ?? b.dueDay) && daysPast(b.due_day ?? b.dueDay, asOf) > 0)
      .map((b) => ({
        supplier: b.supplier || '',
        day: b.day,
        dueDay: b.due_day ?? b.dueDay,
        residual: b.residual,
        daysLate: daysPast(b.due_day ?? b.dueDay, asOf),
      }))
      .sort((a, b) => b.daysLate - a.daysLate)
      .slice(0, 8),
  };
}

function daysPast(from, to) {
  const x = Date.parse(`${from}T00:00:00Z`);
  const y = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(x) || Number.isNaN(y)) return 0;
  return Math.round((y - x) / 86_400_000);
}

/**
 * Who the money goes to, and how much of it goes to very few of them.
 *
 * Two opposite risks in one shape. Concentration is a dependency: one supplier
 * carrying a third of the spend has pricing power and is a single point of
 * failure. The tail is the other one — dozens of suppliers each taking almost
 * nothing is administration nobody is being paid for, and usually the place
 * where an unchecked price hides.
 */
export function suppliers(bills, lines) {
  const spend = new Map();
  for (const bill of bills) {
    if ((bill.state || '') !== 'posted') continue;
    const name = bill.supplier || 'Unknown supplier';
    const row = spend.get(name) || { supplier: name, amount: 0, bills: 0, items: new Set() };
    row.amount += bill.total || 0;
    row.bills += 1;
    spend.set(name, row);
  }
  for (const line of lines || []) {
    const name = line.supplier || line.supplierName;
    const row = name ? spend.get(name) : null;
    if (row) row.items.add(line.item_id ?? line.itemId);
  }

  const rows = [...spend.values()]
    .map((r) => ({ ...r, items: r.items.size }))
    .sort((a, b) => b.amount - a.amount);
  const total = sum(rows.map((r) => r.amount));
  if (total <= 0) return null;

  let running = 0;
  let topToEighty = 0;
  for (const row of rows) {
    running += row.amount;
    topToEighty += 1;
    if (running >= total * 0.8) break;
  }

  const tail = rows.filter((r) => r.amount < total * 0.01);

  return {
    total,
    count: rows.length,
    rows: rows.map((r) => ({ ...r, shareBp: bp(r.amount, total) })),
    biggestShareBp: bp(rows[0]?.amount || 0, total),
    // How few suppliers carry four fifths of the money. A small number is a
    // dependency; a large one is a purchasing function nobody is running.
    suppliersToEightyPct: topToEighty,
    tail: { count: tail.length, amount: sum(tail.map((r) => r.amount)) },
  };
}

/**
 * Bills whose total is suspiciously round.
 *
 * Not fraud detection — it is a prompt. A real invoice for goods has an
 * awkward total because it is quantities times prices plus tax. A round one is
 * usually a service, a retainer or a deposit, all of which are fine; but it is
 * also what an estimate looks like when somebody entered a figure rather than
 * a document, and a business where a fifth of buying is round numbers is not
 * being invoiced properly.
 */
export function roundNumbers(bills, { minimum = 10_000 } = {}) {
  const posted = bills.filter((b) => (b.state || '') === 'posted' && (b.total || 0) >= minimum);
  if (posted.length < 10) return null;
  // Round to the nearest hundred *cedis* — ten thousand pesewas.
  const round = posted.filter((b) => b.total % 10_000 === 0);
  return {
    bills: posted.length,
    round: round.length,
    shareBp: bp(round.length, posted.length),
    amount: sum(round.map((b) => b.total)),
    examples: round
      .sort((a, b) => b.total - a.total)
      .slice(0, 6)
      .map((b) => ({ supplier: b.supplier || '', day: b.day, total: b.total })),
  };
}

/**
 * The whole Odoo picture, in one call.
 *
 * Assembled here rather than in the route so the panel is a rendering of an
 * analysis rather than an analysis of its own — and so all of it can be tested
 * without an HTTP layer.
 */
export function buyingAnalysis({ bills = [], lines = [], asOf }) {
  const history = priceHistory(lines);
  return {
    bills: bills.length,
    lines: lines.length,
    history,
    gaps: priceGaps(history),
    duplicates: possibleDuplicates(bills),
    maverick: maverickSpend(bills),
    payment: payment(bills, asOf),
    suppliers: suppliers(bills, lines),
    roundNumbers: roundNumbers(bills),
  };
}
