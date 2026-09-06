import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  priceHistory, priceGaps, possibleDuplicates, maverickSpend,
  payment, suppliers, roundNumbers, buyingAnalysis,
} from '../src/insight/buying.js';

/**
 * What the books say about buying.
 *
 * These are the findings somebody takes to a supplier, so the ways they could
 * be quietly wrong matter more than the ways they could be loudly wrong:
 *
 *   a mean where a median belongs, so one mistyped invoice line moves the
 *   answer and the real prices are reported as the anomaly;
 *
 *   an unweighted average price, which says a year was dear because one crate
 *   was, while a hundred cheap ones went unremarked;
 *
 *   a credit note counted as a purchase, which overstates every supplier;
 *
 *   a gap reported as a percentage, which ranks a rare item above the one the
 *   kitchen buys weekly.
 *
 * Each has a test.
 */

const line = (over) => ({
  day: '2026-05-04', item_id: 1, item: 'Eggs', supplier_id: 1, supplier: 'Kofi Farms',
  unit: 'crate', qty: 10, unit_cost: 2_000, amount: 20_000, ...over,
});

const bill = (over) => ({
  external_id: 'b1', day: '2026-05-04', supplier_id: 1, supplier: 'Kofi Farms',
  state: 'posted', payment_state: 'not_paid', vendor_ref: null,
  untaxed: 20_000, tax: 0, total: 20_000, residual: 0, from_order: 1, ...over,
});

/* ------------------------------------------------------------ price work -- */

test('a price history needs enough purchases to be a history', () => {
  const few = priceHistory([line({ day: '2026-05-01' }), line({ day: '2026-05-02' })]);
  assert.equal(few.length, 0, 'two purchases are not a trend');

  const enough = priceHistory(['01', '02', '03', '04'].map((d) => line({ day: `2026-05-${d}` })));
  assert.equal(enough.length, 1);
  assert.equal(enough[0].purchases, 4);
});

test('one mistyped line does not become the price', () => {
  // Four purchases at 2,000 and one keyed at 200,000 — a quantity typed as 1
  // instead of 100, which is the commonest invoice mistake there is.
  const rows = priceHistory([
    line({ day: '2026-05-01' }), line({ day: '2026-05-02' }),
    line({ day: '2026-05-03' }), line({ day: '2026-05-04' }),
    line({ day: '2026-05-05', unit_cost: 200_000 }),
  ]);
  assert.equal(rows[0].median, 2_000, 'the middle price is unmoved');
  // A mean would have been 41,600 — twenty times the real price, and every
  // genuine purchase would then read as suspiciously cheap.
  assert.notEqual(rows[0].median, 41_600);
  // And the line itself is not lost. A median that makes the analysis robust
  // also makes a lone wild line invisible — the deviation here is exactly
  // zero — so the outlier is reported rather than smoothed away.
  assert.equal(rows[0].volatilityBp, 0, 'four identical prices are not volatile');
  assert.equal(rows[0].outliers.length, 1);
  assert.equal(rows[0].outliers[0].unitCost, 200_000);
  assert.equal(rows[0].outliers[0].day, '2026-05-05');
  assert.ok(rows[0].outliers[0].awayBp > 900_000, 'a hundred times the usual price');
});

test('the average price is what was paid, not the average of the prices', () => {
  // Prices within an ordinary range, so what is being tested is the weighting
  // and not the outlier rule. One crate bought dear, three hundred cheap.
  const rows = priceHistory([
    line({ day: '2026-05-01', qty: 1, unit_cost: 1_400, amount: 1_400 }),
    line({ day: '2026-05-02', qty: 100, unit_cost: 1_000, amount: 100_000 }),
    line({ day: '2026-05-03', qty: 100, unit_cost: 1_000, amount: 100_000 }),
    line({ day: '2026-05-04', qty: 100, unit_cost: 1_000, amount: 100_000 }),
  ]);
  assert.deepEqual(rows[0].outliers, [], 'a 40% difference is buying, not an anomaly');
  // 301,400 over 301 units — a whisker over 1,000, not the 1,100 an unweighted
  // mean of the four prices would have given.
  assert.equal(rows[0].weighted, Math.round(301_400 / 301));
  assert.ok(rows[0].weighted < 1_010, 'one dear crate does not make a dear year');
});

test('a mistyped line does not become an accusation against a supplier', () => {
  // The bug this exists to prevent, found by looking at the rendered screen.
  //
  // One bread line keyed at 925 instead of 9.25 dragged that supplier's
  // average to eleven times the other's, and the top finding on the page
  // became "Makola Fresh charge 946% more for bread" — worth thousands, ranked
  // first, and entirely invented by a single typo.
  const history = priceHistory([
    ...['01', '02', '03', '04'].map((d) => line({
      day: `2026-05-${d}`, item_id: 5, item: 'Bread', qty: 20, unit_cost: 900, amount: 18_000,
    })),
    ...['01', '02', '03', '04'].map((d) => line({
      day: `2026-06-${d}`, item_id: 5, item: 'Bread', supplier_id: 2, supplier: 'Makola Fresh',
      qty: 20, unit_cost: 950, amount: 19_000,
    })),
    // The typo.
    line({
      day: '2026-06-09', item_id: 5, item: 'Bread', supplier_id: 2, supplier: 'Makola Fresh',
      qty: 20, unit_cost: 92_500, amount: 1_850_000,
    }),
  ]);

  const dear = history.find((r) => r.supplierId === 2);
  assert.equal(dear.weighted, 950, 'the comparison price is struck on the clean lines');
  assert.equal(dear.outliers.length, 1, 'and the bad line is reported on its own');

  // The gap is the real 5.5%, not a fabricated 946%.
  const gaps = priceGaps(history);
  const bread = gaps.find((g) => g.item === 'Bread');
  assert.ok(!bread || bread.gapBp < 1_000, `reported a gap of ${bread?.gapBp} basis points`);

  // But what was actually spent still counts everything. The money left the
  // account whatever the line said.
  assert.equal(dear.spend, 19_000 * 4 + 1_850_000);
});

test('a credit note is not a price observation', () => {
  const rows = priceHistory([
    line({ day: '2026-05-01' }), line({ day: '2026-05-02' }),
    line({ day: '2026-05-03' }), line({ day: '2026-05-04' }),
    // A return: negative quantity, and it must not be read as a purchase.
    line({ day: '2026-05-05', qty: -10, amount: -20_000 }),
    // Nor is a free line a price of nothing.
    line({ day: '2026-05-06', unit_cost: 0, amount: 0 }),
  ]);
  assert.equal(rows[0].purchases, 4);
  assert.equal(rows[0].totalQty, 40, 'the returned crates are not bought crates');
});

test('the same item from two suppliers is one finding, not two histories mixed', () => {
  const rows = priceHistory([
    ...['01', '02', '03', '04'].map((d) => line({ day: `2026-05-${d}` })),
    ...['01', '02', '03', '04'].map((d) => line({
      day: `2026-05-${d}`, supplier_id: 2, supplier: 'Accra Wholesale', unit_cost: 2_600,
    })),
  ]);
  assert.equal(rows.length, 2, 'a history per supplier');
  // Mixed together the spread would have looked like one volatile supplier
  // rather than two price lists.
  assert.equal(rows.find((r) => r.supplierId === 1).median, 2_000);
  assert.equal(rows.find((r) => r.supplierId === 2).median, 2_600);
});

test('a price gap is ranked by money, not by percentage', () => {
  const history = priceHistory([
    // Saffron: bought rarely, 50% dearer from one supplier.
    ...['01', '02', '03', '04'].map((d) => line({
      day: `2026-05-${d}`, item_id: 9, item: 'Saffron', qty: 1, unit_cost: 10_000, amount: 10_000,
    })),
    ...['01', '02', '03', '04'].map((d) => line({
      day: `2026-05-${d}`, item_id: 9, item: 'Saffron', supplier_id: 2, supplier: 'Accra Wholesale',
      qty: 1, unit_cost: 15_000, amount: 15_000,
    })),
    // Eggs: bought constantly, 20% dearer.
    ...['01', '02', '03', '04'].map((d) => line({ day: `2026-05-${d}` })),
    ...['01', '02', '03', '04'].map((d) => line({
      day: `2026-05-${d}`, supplier_id: 2, supplier: 'Accra Wholesale',
      qty: 200, unit_cost: 2_400, amount: 480_000,
    })),
  ]);
  const gaps = priceGaps(history);
  assert.equal(gaps[0].item, 'Eggs', 'the weekly item is the bigger prize');
  // Saffron has the worse percentage and is still second.
  assert.ok(gaps.find((g) => g.item === 'Saffron').gapBp > gaps[0].gapBp);
  // 400 pesewas a crate over 800 crates.
  assert.equal(gaps[0].worth, (2_400 - 2_000) * 800);
  assert.equal(gaps[0].cheapest.supplier, 'Kofi Farms');
  assert.equal(gaps[0].dearest.supplier, 'Accra Wholesale');
});

test('one supplier for an item is no gap at all', () => {
  const history = priceHistory(['01', '02', '03', '04'].map((d) => line({ day: `2026-05-${d}` })));
  assert.deepEqual(priceGaps(history), []);
});

/* --------------------------------------------------------- the documents -- */

test('the same supplier reference twice is flagged with confidence', () => {
  const found = possibleDuplicates([
    bill({ external_id: 'b1', vendor_ref: 'INV-4471', total: 50_000 }),
    bill({ external_id: 'b2', day: '2026-05-19', vendor_ref: 'INV-4471', total: 50_000 }),
    bill({ external_id: 'b3', vendor_ref: 'INV-4472', total: 50_000 }),
  ]);
  const exact = found.filter((f) => f.kind === 'same-reference');
  assert.equal(exact.length, 1);
  assert.equal(exact[0].confidence, 'high');
  assert.equal(exact[0].reference, 'INV-4471');
  assert.equal(exact[0].worth, 50_000, 'the second one is what a duplicate costs');
});

test('the same amount days apart is raised more quietly', () => {
  const found = possibleDuplicates([
    bill({ external_id: 'b1', day: '2026-05-04', total: 50_000 }),
    bill({ external_id: 'b2', day: '2026-05-07', total: 50_000 }),
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'same-amount');
  assert.equal(found[0].confidence, 'worth a look');
});

test('a monthly standing charge is not reported as a duplicate', () => {
  // The same round amount every month is a retainer, not a double payment.
  const found = possibleDuplicates([
    bill({ external_id: 'b1', day: '2026-03-01', total: 50_000 }),
    bill({ external_id: 'b2', day: '2026-04-01', total: 50_000 }),
    bill({ external_id: 'b3', day: '2026-05-01', total: 50_000 }),
  ]);
  assert.deepEqual(found, [], 'a month apart is not days apart');
});

test('different suppliers billing the same amount are not each other', () => {
  const found = possibleDuplicates([
    bill({ external_id: 'b1', total: 50_000 }),
    bill({ external_id: 'b2', supplier_id: 2, supplier: 'Someone else', total: 50_000 }),
  ]);
  assert.deepEqual(found, []);
});

test('spend with no order behind it is measured as a share', () => {
  const found = maverickSpend([
    bill({ external_id: 'b1', total: 60_000, from_order: 1 }),
    bill({ external_id: 'b2', total: 40_000, from_order: 0, supplier: 'Sunday plumber' }),
    bill({ external_id: 'b3', total: 0, from_order: 0 }),          // nothing to commit
    bill({ external_id: 'b4', total: 90_000, from_order: 0, state: 'draft' }), // not yet real
  ]);
  assert.equal(found.bills, 2, 'drafts and empties are not spend');
  assert.equal(found.total, 100_000);
  assert.equal(found.loose, 40_000);
  assert.equal(found.shareBp, 4_000);
  assert.equal(found.suppliers[0].supplier, 'Sunday plumber');
});

test('nothing posted means no maverick finding, rather than zero percent', () => {
  assert.equal(maverickSpend([]), null);
  assert.equal(maverickSpend([bill({ state: 'draft' })]), null);
});

/* ------------------------------------------------------------- the money -- */

test('what is overdue is bucketed by how late it is', () => {
  const found = payment([
    bill({ external_id: 'b1', day: '2026-04-01', due_day: '2026-05-01', total: 10_000, residual: 10_000 }),
    bill({ external_id: 'b2', day: '2026-03-01', due_day: '2026-03-15', total: 20_000, residual: 20_000 }),
    bill({ external_id: 'b3', day: '2026-01-01', due_day: '2026-01-15', total: 30_000, residual: 30_000 }),
    bill({ external_id: 'b4', day: '2026-05-01', due_day: '2026-06-30', total: 40_000, residual: 40_000 }),
    bill({ external_id: 'b5', day: '2026-05-01', due_day: '2026-05-15', total: 50_000, residual: 0 }),
  ], '2026-05-20');

  assert.equal(found.outstanding, 100_000, 'a paid bill is not outstanding');
  assert.equal(found.buckets.current, 40_000, 'not yet due is not overdue');
  assert.equal(found.buckets.d1_30, 10_000);
  assert.equal(found.buckets.d61_90, 20_000);
  assert.equal(found.buckets.over90, 30_000);
  assert.equal(found.overdue, 60_000);
  assert.equal(found.worstOverdue[0].daysLate, 125);
});

test('the usual payment term is the middle one, not the average', () => {
  const bills = [
    ...Array.from({ length: 10 }, (_, i) => bill({
      external_id: `t${i}`, day: '2026-05-01', due_day: '2026-05-15', residual: 0,
    })),
    // One supplier on ninety days must not turn a fortnight into a month.
    bill({ external_id: 'slow', day: '2026-05-01', due_day: '2026-07-30', residual: 0 }),
  ];
  assert.equal(payment(bills, '2026-05-20').typicalTermDays, 14);
});

test('a period with no bills has no payment finding', () => {
  assert.equal(payment([], '2026-05-20'), null);
});

/* --------------------------------------------------------- the suppliers -- */

test('supplier spend reports both the dependency and the tail', () => {
  const bills = [
    bill({ external_id: 'a', supplier: 'Big Supplier', total: 700_000 }),
    bill({ external_id: 'b', supplier: 'Second', total: 200_000 }),
    ...Array.from({ length: 12 }, (_, i) => bill({
      external_id: `t${i}`, supplier: `Tiny ${i}`, total: 8_000,
    })),
  ];
  const found = suppliers(bills, []);
  assert.equal(found.count, 14);
  assert.equal(found.biggestShareBp, Math.round((700_000 / 996_000) * 10_000));
  assert.equal(found.suppliersToEightyPct, 2, 'two suppliers carry four fifths');
  assert.equal(found.tail.count, 12, 'and twelve carry almost nothing');
  assert.equal(found.rows[0].supplier, 'Big Supplier');
});

test('round-number bills are counted only when there are enough to mean anything', () => {
  assert.equal(roundNumbers([bill({ total: 100_000 })]), null, 'one bill is not a pattern');

  const bills = [
    ...Array.from({ length: 8 }, (_, i) => bill({ external_id: `r${i}`, total: 100_000 })),
    ...Array.from({ length: 12 }, (_, i) => bill({ external_id: `o${i}`, total: 47_318 })),
  ];
  const found = roundNumbers(bills);
  assert.equal(found.bills, 20);
  assert.equal(found.round, 8);
  assert.equal(found.shareBp, 4_000);
});

/* ---------------------------------------------------------------- whole -- */

test('the whole analysis survives having nothing to analyse', () => {
  const a = buyingAnalysis({ bills: [], lines: [], asOf: '2026-05-20' });
  assert.equal(a.bills, 0);
  assert.deepEqual(a.history, []);
  assert.deepEqual(a.gaps, []);
  assert.deepEqual(a.duplicates, []);
  assert.equal(a.maverick, null);
  assert.equal(a.payment, null);
  assert.equal(a.suppliers, null);
  assert.equal(a.roundNumbers, null);
});

test('every money figure it returns is a whole number of pesewas', () => {
  const lines = [
    ...['01', '02', '03', '04'].map((d) => line({ day: `2026-05-${d}`, qty: 7, unit_cost: 333, amount: 2_331 })),
    ...['01', '02', '03', '04'].map((d) => line({
      day: `2026-05-${d}`, supplier_id: 2, supplier: 'Other', qty: 3, unit_cost: 401, amount: 1_203,
    })),
  ];
  const a = buyingAnalysis({ bills: [bill({})], lines, asOf: '2026-05-20' });
  for (const row of a.history) {
    for (const field of ['median', 'weighted', 'first', 'latest', 'spend']) {
      assert.ok(Number.isInteger(row[field]), `${row.item}.${field} is ${row[field]}`);
    }
  }
  for (const gap of a.gaps) assert.ok(Number.isInteger(gap.worth));
});


test('an ordinary amount of price variation is not a list of outliers', () => {
  const rows = priceHistory([2_000, 2_050, 1_960, 2_100, 1_980, 2_030].map((c, i) => line({
    day: `2026-05-0${i + 1}`, unit_cost: c, amount: c * 10,
  })));
  assert.deepEqual(rows[0].outliers, [], 'a few percent either way is buying, not an anomaly');
  assert.ok(rows[0].volatilityBp > 0, 'though it is still measurably unstable');
});
