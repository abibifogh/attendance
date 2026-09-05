import { add, h, money, num, percent, dayRange } from '../util.js';
import { api } from '../api.js';
import { barChart } from '../charts.js';
import { table, banner, caveats } from './components.js';

/**
 * The books.
 *
 * Everything else in this app reads what somebody inside the business typed.
 * This reads what suppliers invoiced and what the accounts did about it — and
 * because a bill is a document from outside that somebody approved, it can be
 * asked things no operational record can answer. Whether the same thing was
 * bought twice. Whether it was bought without anybody agreeing to it first.
 * Whether it has been paid.
 *
 * The screen is ordered by what it is worth acting on, not by what is easiest
 * to compute: money on the table first, then documents that look wrong, then
 * the standing picture of who gets paid and when.
 */
export async function renderBooks(root, { range }) {
  const data = await api(`/books?from=${range.from}&to=${range.to}`);

  const nothing = data.bills === 0;

  add(root,
    data.demoMode
      ? banner('demo', h('strong', 'Demonstration data.'), ' The bills below are invented.')
      : null,

    nothing
      ? h('div.card',
        h('h2', 'Nothing from Odoo in this window'),
        h('p.sub',
          data.connected.length
            ? 'Odoo is connected but has no vendor bills dated in these days. Widen the range, '
              + 'or check that bills are being posted with an accounting date rather than left as drafts.'
            : 'Odoo has not been connected yet. Add it under Setup, then load again.'))
      : null,

    !nothing ? h('div.card',
      h('h2', 'What was invoiced'),
      h('p.sub', `${dayRange(data.range.from, data.range.to)}. ${num(data.bills)} bills, ${num(data.lines)} lines.`),
      h('div.grid.three',
        stat('Billed', money(data.payment?.billed ?? 0), `${num(data.bills)} bills`),
        stat('Still owed', money(data.payment?.outstanding ?? 0),
          data.payment?.overdue ? `${money(data.payment.overdue)} of it overdue` : 'none of it overdue'),
        stat('Usual terms',
          data.payment?.typicalTermDays == null ? '—' : `${num(data.payment.typicalTermDays)} days`,
          'from invoice to due date'))) : null,

    // ------------------------------------------------ money on the table --
    data.gaps?.length ? h('div.card',
      h('h2', 'The same thing, two prices'),
      h('p.sub',
        'Items bought from more than one supplier in this window, compared before tax. '
        + 'Ranked by what the gap is worth at the quantities actually bought — not by the '
        + 'percentage, because a big gap on a rare item is worth less than a small one on '
        + 'the thing you buy every week.'),
      table([
        { label: 'Item', get: (r) => r.item },
        { label: 'Cheapest', get: (r) => `${r.cheapest.supplier} · ${money(r.cheapest.price)}` },
        { label: 'Dearest', get: (r) => `${r.dearest.supplier} · ${money(r.dearest.price)}` },
        { label: 'Gap', num: true, get: (r) => percent(r.gapBp / 100) },
        { label: 'Worth', num: true, get: (r) => money(r.worth) },
      ], data.gaps.slice(0, 15))) : null,

    // ------------------------------------------- documents that look odd --
    data.duplicates?.length ? h('div.card',
      h('h2', 'Bills that may be the same bill'),
      h('p.sub',
        'Two kinds. The same supplier reference twice is almost always a duplicate — Odoo’s '
        + 'own numbers differ by construction, so this is invisible in its lists. The same '
        + 'amount days apart is a weaker signal and often innocent; it is here to be checked, '
        + 'not to be believed.'),
      table([
        { label: 'Supplier', get: (r) => r.supplier },
        { label: 'Why', get: (r) => (r.kind === 'same-reference' ? `Same reference ${r.reference}` : 'Same amount, days apart') },
        { label: 'Confidence', get: (r) => r.confidence },
        { label: 'Days', get: (r) => r.bills.map((b) => b.day).join(' · ') },
        { label: 'At risk', num: true, get: (r) => money(r.worth) },
      ], data.duplicates.slice(0, 15))) : null,

    outliersCard(data),

    // ----------------------------------------------------- the standing --
    data.maverick ? h('div.card',
      h('h2', 'Spend nobody agreed to first'),
      h('p.sub',
        `${percent(data.maverick.shareBp / 100)} of what was billed — ${money(data.maverick.loose)} `
        + `across ${num(data.maverick.withoutOrder)} of ${num(data.maverick.bills)} bills — arrived `
        + 'without a purchase order behind it. That is not wrong in itself; a plumber called out on '
        + 'a Sunday never has one. It is money committed without the step meant to check it, and '
        + 'the share is the thing to watch.'),
      data.maverick.suppliers.length
        ? table([
          { label: 'Supplier', get: (r) => r.supplier },
          { label: 'Without an order', num: true, get: (r) => money(r.amount) },
        ], data.maverick.suppliers)
        : null) : null,

    data.suppliers ? h('div.card',
      h('h2', 'Where the money goes'),
      h('p.sub',
        `${num(data.suppliers.count)} suppliers. `
        + `${num(data.suppliers.suppliersToEightyPct)} of them carry four fifths of the spend, and `
        + `the largest alone takes ${percent(data.suppliers.biggestShareBp / 100)}. `
        + (data.suppliers.tail.count
          ? `${num(data.suppliers.tail.count)} take under one per cent each, together `
            + `${money(data.suppliers.tail.amount)} — that tail is administration nobody is paid for, `
            + 'and usually where an unchecked price hides.'
          : '')),
      barChart(data.suppliers.rows.slice(0, 12), {
        label: (r) => r.supplier,
        value: (r) => r.amount,
      }),
      table([
        { label: 'Supplier', get: (r) => r.supplier },
        { label: 'Billed', num: true, get: (r) => money(r.amount) },
        { label: 'Share', num: true, get: (r) => percent(r.shareBp / 100) },
        { label: 'Bills', num: true, get: (r) => num(r.bills) },
        { label: 'Distinct items', num: true, get: (r) => num(r.items) },
      ], data.suppliers.rows.slice(0, 20))) : null,

    ageingCard(data),

    data.roundNumbers && data.roundNumbers.round > 0 ? h('div.card',
      h('h2', 'Suspiciously round bills'),
      h('p.sub',
        `${num(data.roundNumbers.round)} of ${num(data.roundNumbers.bills)} bills — `
        + `${percent(data.roundNumbers.shareBp / 100)}, ${money(data.roundNumbers.amount)} — come to `
        + 'an exact round figure. A real invoice for goods is quantities times prices plus tax and '
        + 'lands somewhere awkward. Round is normal for a retainer or a deposit, and is also what an '
        + 'estimate looks like when somebody typed a number instead of entering a document.'),
      table([
        { label: 'Supplier', get: (r) => r.supplier },
        { label: 'Day', get: (r) => r.day },
        { label: 'Total', num: true, get: (r) => money(r.total) },
      ], data.roundNumbers.examples)) : null,

    // -------------------------------------------------- the price detail --
    data.history?.length ? h('div.card',
      h('h2', 'Every price, item by item'),
      h('p.sub',
        'The finest grain the documents allow: one row per item per supplier. The middle price '
        + 'rather than the average, because one mistyped line moves an average enormously and a '
        + 'median not at all. "Moved" is the latest price against that middle.'),
      table([
        { label: 'Item', get: (r) => r.item },
        { label: 'Supplier', get: (r) => r.supplier },
        { label: 'Bought', num: true, get: (r) => num(r.purchases) },
        { label: 'Usual price', num: true, get: (r) => money(r.median) },
        { label: 'Paid on average', num: true, get: (r) => money(r.weighted) },
        { label: 'Latest', num: true, get: (r) => money(r.latest) },
        { label: 'Moved', num: true, get: (r) => percent(r.moveBp / 100) },
        { label: 'Spend', num: true, get: (r) => money(r.spend) },
      ], data.history.slice(0, 40))) : null,

    caveats(data.caveats));
}

/**
 * Lines a long way from their own usual price.
 *
 * Its own card because it is the one thing on this screen that is probably a
 * mistake rather than a decision — and because the median that makes every
 * other figure here robust is exactly what would otherwise hide it.
 */
function outliersCard(data) {
  const rows = (data.history || [])
    .flatMap((h2) => h2.outliers.map((o) => ({ ...o, item: h2.item, supplier: h2.supplier, usual: h2.median })))
    .sort((a, b) => Math.abs(b.awayBp) - Math.abs(a.awayBp))
    .slice(0, 12);
  if (!rows.length) return null;

  return h('div.card',
    h('h2', 'Lines that do not look like the others'),
    h('p.sub',
      'A price far from what that supplier usually charges for that item. Most often a quantity '
      + 'keyed wrongly — one instead of a hundred — which is the commonest invoice mistake there '
      + 'is and never shows up in a total anybody looks at.'),
    table([
      { label: 'Item', get: (r) => r.item },
      { label: 'Supplier', get: (r) => r.supplier },
      { label: 'Day', get: (r) => r.day },
      { label: 'Usually', num: true, get: (r) => money(r.usual) },
      { label: 'This line', num: true, get: (r) => money(r.unitCost) },
      { label: 'Away by', num: true, get: (r) => percent(r.awayBp / 100) },
    ], rows));
}

/** What is owed, by how late it is. */
function ageingCard(data) {
  const p = data.payment;
  if (!p || p.outstanding <= 0) return null;
  const buckets = [
    ['Not yet due', p.buckets.current],
    ['1–30 days late', p.buckets.d1_30],
    ['31–60 days late', p.buckets.d31_60],
    ['61–90 days late', p.buckets.d61_90],
    ['Over 90 days late', p.buckets.over90],
  ].filter(([, amount]) => amount > 0).map(([label, amount]) => ({ label, amount }));

  return h('div.card',
    h('h2', 'What is still owed'),
    h('p.sub',
      `${money(p.outstanding)} outstanding at the end of this window`
      + (p.overdue ? `, of which ${money(p.overdue)} was already past its due date.` : ', none of it overdue.')
      + ' Ageing is worked out as at the end of the range, not today, so re-reading an old quarter '
      + 'reports what was overdue then.'),
    barChart(buckets, { label: (r) => r.label, value: (r) => r.amount }),
    p.worstOverdue.length
      ? table([
        { label: 'Supplier', get: (r) => r.supplier },
        { label: 'Billed', get: (r) => r.day },
        { label: 'Was due', get: (r) => r.dueDay },
        { label: 'Days late', num: true, get: (r) => num(r.daysLate) },
        { label: 'Still owed', num: true, get: (r) => money(r.residual) },
      ], p.worstOverdue)
      : null);
}

function stat(label, value, note) {
  return h('div.tile',
    h('div.label', label),
    h('div.value', value),
    note ? h('div.note', note) : null);
}
