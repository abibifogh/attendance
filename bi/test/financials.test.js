import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  costStructure, breakEven, daysBelowBreakEven, sensitivity,
  groupBridge, lineBridge, workingCapital, earningsQuality,
  unitEconomics, concentration, runRate, financialAnalysis,
  MIN_DAYS_FOR_STRUCTURE,
} from '../src/insight/financials.js';

/**
 * The yardstick.
 *
 * These numbers get taken into a room where somebody decides whether to close
 * a line or hire a cook, so the failures worth testing for are the ones that
 * produce a confident, plausible, wrong answer:
 *
 *   a bridge whose parts do not add up to the change printed above them, which
 *   lets the reader believe whichever bar suits the argument;
 *
 *   a break-even computed for a line that loses money on every cover, which is
 *   a large positive number where the truth is "there isn't one";
 *
 *   operating leverage read off a period that barely broke even, where the
 *   arithmetic is right and the 3,000× on the screen is not information;
 *
 *   a cost structure fitted to a fortnight of noise and presented in the same
 *   type as one fitted to a clear relationship;
 *
 *   a concentration figure that counts loss-making lines in the denominator,
 *   so the earners' shares sum past 100% and the risk reads as worse than it
 *   is;
 *
 *   a mean where a median belongs in the forecast, so one wedding sets the
 *   month.
 *
 * Each has a test, and each was checked by breaking the guard and watching the
 * suite fail.
 */

const dayRow = (day, net, cost, labour) => ({
  day, net, cost, labour, contribution: net - cost - labour,
});

/** Thirty days whose spend is genuinely 40,000 fixed plus 30% of takings. */
const cleanDays = () => Array.from({ length: 30 }, (_, i) => {
  const net = 200000 + (i % 10) * 25000;
  const spend = 40000 + Math.round(net * 0.3);
  // Split the modelled spend between purchases and wages, roughly as a
  // kitchen does: the bought-in part moves, the wage part is the standing one.
  const cost = Math.round(net * 0.3);
  return dayRow(`2026-05-${String(i + 1).padStart(2, '0')}`, net, cost, spend - cost);
});

const lineRow = (line, over = {}) => ({
  line,
  label: line,
  net: 0, cost: 0, labour: 0, hours: 0, covers: 0, orders: 0, days: 30,
  ...over,
  contribution: (over.net || 0) - (over.cost || 0) - (over.labour || 0),
});

// ------------------------------------------------------------- structure --

test('the split is measured, not modelled: purchases vary, wages do not', () => {
  const s = costStructure(cleanDays());
  assert.equal(s.known, true);
  // 30% of takings goes on purchases, by construction.
  assert.equal(s.variableRatio, 0.3);
  assert.equal(s.contributionRatio, 0.7);
  // The wage bill is the fixed cost, taken as it is rather than inferred.
  assert.equal(s.wagesPerDay, Math.round(s.wages / 30));
  assert.equal(s.fixedPerDay, s.wagesPerDay + s.standingPerDay);
});

test('rent is asked for, never invented from the data', () => {
  // The costs in these systems are purchases and wages. An earlier version
  // regressed total spend on takings and called the intercept the standing
  // cost; on data containing no standing cost at all that intercept is just
  // the average wage bill wearing a different name, and it was reported as a
  // discovery. Nothing may appear here that was not put here.
  const bare = costStructure(cleanDays());
  assert.equal(bare.standingPerDay, 0);
  assert.equal(bare.standingKnown, false);
  assert.equal(bare.fixedPerDay, bare.wagesPerDay);

  const told = costStructure(cleanDays(), { standingPerDay: 50000 });
  assert.equal(told.standingKnown, true);
  assert.equal(told.standingTotal, 50000 * 30);
  assert.equal(told.fixedPerDay, told.wagesPerDay + 50000);
});

test('a negative standing cost is floored, never credited', () => {
  const s = costStructure(cleanDays(), { standingPerDay: -90000 });
  assert.equal(s.standingPerDay, 0);
  assert.equal(s.fixedPerDay, s.wagesPerDay);
});

test('food bought to a schedule rather than to demand is a finding, not a refusal', () => {
  // Deliveries on set days, eaten all week: the food bill does not track the
  // day's takings. That is a real fact about how the kitchen buys, and it must
  // not stop a break-even being drawn — the break-even does not depend on it.
  const lumpy = Array.from({ length: 28 }, (_, i) => dayRow(
    `2026-05-${String(i + 1).padStart(2, '0')}`,
    150000 + (i * 41 % 13) * 12000,
    i % 7 === 0 ? 400000 : 0,
    30000,
  ));
  const s = costStructure(lumpy);
  assert.equal(s.known, true, 'a break-even is still available');
  assert.equal(s.tracking.known, true);
  assert.equal(s.tracking.followsDemand, false, 'and the buying pattern is reported');
});

test('a kitchen buying to demand is recognised as doing so', () => {
  const s = costStructure(cleanDays());
  assert.equal(s.tracking.followsDemand, true);
  assert.equal(s.tracking.perCediOfTakings, 0.3);
});

test('a window with no takings has no cost structure to describe', () => {
  const empty = Array.from({ length: 20 }, (_, i) => dayRow(`2026-05-${i + 1}`, 0, 5000, 5000));
  assert.equal(costStructure(empty).known, false);
});

// ------------------------------------------------------------ break-even --

test('break-even is fixed cost over the contribution ratio', () => {
  const s = costStructure(cleanDays());
  const revenue = 30 * 300000;
  const be = breakEven(s, { revenue, days: 30 });
  assert.equal(be.known, true);
  assert.equal(be.perDay, Math.round(40000 / 0.7));
  assert.equal(be.forPeriod, Math.round(40000 / 0.7) * 30);
});

test('a business that loses money on every cedi has no break-even at all', () => {
  // A large positive number here — fixed / a negative ratio flipped, or an
  // unchecked division — would be read as a target somebody could aim at.
  const be = breakEven(
    { known: true, fixedPerDay: 40000, fixedTotal: 1200000, contributionRatio: -0.2 },
    { revenue: 9000000, days: 30 },
  );
  assert.equal(be.known, false);
  assert.equal(be.why, 'no-break-even');
});

test('margin of safety goes negative below break-even rather than clamping to zero', () => {
  const s = { known: true, fixedPerDay: 100000, fixedTotal: 3000000, contributionRatio: 0.5 };
  const be = breakEven(s, { revenue: 3000000, days: 30 });
  assert.equal(be.known, true);
  assert.ok(be.marginOfSafetyPct < 0, 'how far under is the whole question at that point');
});

test('operating leverage is withheld near break-even instead of printing a huge multiple', () => {
  const s = { known: true, fixedPerDay: 100000, fixedTotal: 3000000, contributionRatio: 0.5 };
  // Contribution 3,000,100 against 3,000,000 of fixed cost: profit of 100
  // pesewas, leverage of 30,001×. Arithmetically right, informationally noise.
  const be = breakEven(s, { revenue: 6000200, days: 30 });
  assert.equal(be.leverage, null);
  assert.equal(be.leverageCapped, true);
});

test('leverage is withheld where there is no profit for it to multiply', () => {
  // The arithmetic still yields a number on a loss-making month — gross margin
  // over a negative profit — and "-6×" reads as a fact about volatility rather
  // than what it is, which is a division by a negative.
  const s = { known: true, fixedPerDay: 300000, fixedTotal: 9000000, contributionRatio: 0.5,
    purchases: 3000000 };
  const be = breakEven(s, { revenue: 6000000, days: 30 });
  assert.ok(be.operatingProfit < 0);
  assert.equal(be.leverage, null);
  assert.equal(be.hasProfit, false);
});

test('leverage survives where the profit is real', () => {
  const s = { known: true, fixedPerDay: 40000, fixedTotal: 1200000, contributionRatio: 0.5 };
  const be = breakEven(s, { revenue: 6000000, days: 30 });
  assert.equal(be.grossMargin, 3000000);
  assert.equal(be.operatingProfit, 1800000);
  assert.equal(be.leverage, Math.round((3000000 / 1800000) * 10) / 10);
});

test('days below break-even names the worst of them', () => {
  const daily = [
    dayRow('2026-05-01', 10000, 0, 0),
    dayRow('2026-05-02', 500000, 0, 0),
    dayRow('2026-05-03', 500000, 0, 0),
  ];
  const below = daysBelowBreakEven(daily, { known: true, fixedPerDay: 100000, contributionRatio: 0.5 });
  assert.equal(below.line, 200000);
  assert.equal(below.days, 1);
  assert.equal(below.worst[0].day, '2026-05-01');
  assert.equal(below.worst[0].short, 190000);
});

// ----------------------------------------------------------- sensitivity --

test('a fall in takings takes the bought-in cost down with it, but not the wages', () => {
  const s = sensitivity({ revenue: 1000000, cost: 300000, labour: 200000, fixed: 100000 }, 10);
  assert.equal(s.base, 400000);
  // 900,000 taken, 270,000 bought, 200,000 paid, 100,000 standing.
  const takings = s.scenarios.find((x) => x.label.startsWith('Takings'));
  assert.equal(takings.profit, 330000);
  // Treating food as fixed too would give 400,000 - 100,000 = 300,000, which
  // overstates the damage by a third and would sell a panic.
  assert.notEqual(takings.profit, 300000);
});

test('headroom says how big a shock of each kind wipes the profit out', () => {
  const s = sensitivity({ revenue: 1000000, cost: 300000, labour: 200000, fixed: 100000 }, 10);
  assert.equal(s.hasProfit, true);
  assert.equal(s.headroom.wageRisePct, 200);
  assert.equal(s.headroom.purchaseRisePct, Math.round((400000 / 300000) * 1000) / 10);
});

test('there is no headroom to report where there is no profit', () => {
  // A loss-making period yields negative headroom figures that read as smaller
  // warnings than they are: "takings can fall -14% before the profit goes" is
  // not a softer version of "you are losing money", it is a false statement.
  const s = sensitivity({ revenue: 1000000, cost: 600000, labour: 500000, fixed: 100000 }, 10);
  assert.equal(s.hasProfit, false);
  assert.equal(s.headroom.wageRisePct, null);
  assert.equal(s.headroom.revenueFallPct, null);
});

test('rent that is not in the data gets no scenario, rather than a nil one', () => {
  // "Standing costs rise 10%: no change" reads as rent not mattering, which is
  // the opposite of what an unset standing cost means.
  const none = sensitivity({ revenue: 1000000, cost: 300000, labour: 200000, fixed: 0 }, 10);
  assert.equal(none.scenarios.length, 3);
  const some = sensitivity({ revenue: 1000000, cost: 300000, labour: 200000, fixed: 100000 }, 10);
  assert.equal(some.scenarios.length, 4);
});

test('the two operating profits on the screen are the same number', () => {
  // breakEven works from a contribution ratio rounded to four places. Taking
  // gross margin as revenue times that ratio put its operating profit three
  // cedis away from the one in the tile above it — a gap nobody could explain
  // and everybody would eventually spot.
  const daily = Array.from({ length: 31 }, (_, i) => dayRow(`2026-08-${String(i + 1).padStart(2, '0')}`,
    366996 + (i % 7) * 4111, 122273 + (i % 5) * 3137, 280126));
  const s = costStructure(daily);
  const revenue = daily.reduce((a, d) => a + d.net, 0);
  const contribution = daily.reduce((a, d) => a + d.contribution, 0);
  const be = breakEven(s, { revenue, days: daily.length });
  assert.equal(be.operatingProfit, contribution, 'to the pesewa, with no standing cost declared');
});

// ---------------------------------------------------------------- bridge --

test('the group bridge adds up to the change exactly, to the pesewa', () => {
  const prior = [
    lineRow('restaurant', { net: 4000000, cost: 1400000, labour: 900000 }),
    lineRow('bar', { net: 1500000, cost: 500000, labour: 300000 }),
  ];
  const current = [
    lineRow('restaurant', { net: 4600000, cost: 1700000, labour: 1000000 }),
    lineRow('bar', { net: 1200000, cost: 430000, labour: 310000 }),
  ];
  const b = groupBridge(prior, current);
  assert.equal(b.known, true);
  const parts = b.parts.reduce((a, p) => a + p.amount, 0);
  assert.equal(parts, b.change, 'the bars must sum to the number above them');
  assert.equal(b.reconciled, true, 'and must do so without an unexplained bar');
  assert.equal(b.change, b.to - b.from);
});

test('a line that is new this period lands its whole contribution in mix', () => {
  const prior = [lineRow('restaurant', { net: 4000000, cost: 1400000, labour: 900000 })];
  const current = [
    lineRow('restaurant', { net: 4000000, cost: 1400000, labour: 900000 }),
    lineRow('laundry', { net: 500000, cost: 100000, labour: 150000 }),
  ];
  const b = groupBridge(prior, current);
  assert.equal(b.reconciled, true);
  assert.equal(b.parts.reduce((a, p) => a + p.amount, 0), b.change);
  assert.equal(b.change, 250000);
});

test('a line that stopped earning still adds up', () => {
  // Dropping the vanished line out of the loop is the easy bug here, and it
  // leaves the bars short by exactly what that line used to make.
  const prior = [
    lineRow('restaurant', { net: 4000000, cost: 1400000, labour: 900000 }),
    lineRow('bar', { net: 1000000, cost: 300000, labour: 200000 }),
  ];
  const current = [lineRow('restaurant', { net: 4200000, cost: 1500000, labour: 950000 })];
  const b = groupBridge(prior, current);
  assert.equal(b.reconciled, true, 'the bar should not have to be labelled unexplained');
  assert.equal(b.parts.reduce((a, p) => a + p.amount, 0), b.change);
});

test('a line that takes nothing gets a bar of its own', () => {
  // Housekeeping has no revenue, so it has no share and no margin, and a
  // decomposition built on revenue share is structurally blind to it. Before
  // the overhead bar existed, a 200,000 rise in what housekeeping cost was
  // being absorbed silently onto whichever other bar was largest — which is
  // exactly what the reconciliation check is there to catch.
  const prior = [
    lineRow('restaurant', { net: 4000000, cost: 1400000, labour: 900000 }),
    lineRow('housekeeping', { net: 0, cost: 50000, labour: 400000 }),
  ];
  const current = [
    lineRow('restaurant', { net: 4000000, cost: 1400000, labour: 900000 }),
    lineRow('housekeeping', { net: 0, cost: 50000, labour: 600000 }),
  ];
  const b = groupBridge(prior, current);
  assert.equal(b.reconciled, true);
  assert.equal(b.change, -200000);
  assert.equal(b.parts.find((p) => p.key === 'overhead').amount, -200000);
  assert.equal(b.parts.find((p) => p.key === 'margin').amount, 0);
  assert.equal(b.parts.reduce((a, p) => a + p.amount, 0), b.change);
});

test('the group bridge separates earning more from earning better', () => {
  // Same margin, more money: everything must land on the revenue bar.
  const prior = [lineRow('restaurant', { net: 1000000, cost: 400000, labour: 200000 })];
  const current = [lineRow('restaurant', { net: 2000000, cost: 800000, labour: 400000 })];
  const b = groupBridge(prior, current);
  assert.equal(b.parts.find((p) => p.key === 'revenue').amount, 400000);
  assert.equal(b.parts.find((p) => p.key === 'margin').amount, 0);
  assert.equal(b.parts.find((p) => p.key === 'mix').amount, 0);
});

test('the line bridge adds up, and separates volume from price', () => {
  const prior = lineRow('restaurant', { net: 1000000, cost: 400000, labour: 200000, covers: 500 });
  const current = lineRow('restaurant', { net: 1320000, cost: 480000, labour: 240000, covers: 600 });
  const b = lineBridge(prior, current);
  assert.equal(b.known, true);
  assert.equal(b.reconciled, true);
  assert.equal(b.parts.reduce((a, p) => a + p.amount, 0), b.change);
  // 100 more covers at the old margin of 800/cover.
  assert.equal(b.parts.find((p) => p.key === 'volume').amount, 80000);
  // Price went from 2,000 to 2,200 a cover, across 600 covers.
  assert.equal(b.parts.find((p) => p.key === 'price').amount, 120000);
});

test('serving more people is not a finding about spending more on food', () => {
  // Identical economics per cover, twice the covers. The cost bar must be
  // zero: a bridge built on totals rather than rates would report a
  // 400,000 deterioration in buying that did not happen.
  const prior = lineRow('restaurant', { net: 1000000, cost: 400000, labour: 200000, covers: 500 });
  const current = lineRow('restaurant', { net: 2000000, cost: 800000, labour: 400000, covers: 1000 });
  const b = lineBridge(prior, current);
  assert.equal(b.parts.find((p) => p.key === 'cost').amount, 0);
  assert.equal(b.parts.find((p) => p.key === 'price').amount, 0);
  assert.equal(b.parts.find((p) => p.key === 'volume').amount, 400000);
});

test('a line with no volume either side is declined rather than divided by zero', () => {
  const prior = lineRow('admin', { net: 0, cost: 100000, labour: 200000, days: 0 });
  const current = lineRow('admin', { net: 0, cost: 120000, labour: 210000, days: 0 });
  const b = lineBridge(prior, current);
  assert.equal(b.known, false);
  assert.equal(b.change, -30000);
});

// -------------------------------------------------------- working capital --

test('the cash gap is how long the business funds its customers', () => {
  const w = workingCapital({
    revenue: 3000000, outstanding: 400000, billed: 1500000, payable: 500000, days: 30,
  });
  assert.equal(w.dso, 4);
  assert.equal(w.dpo, 10);
  assert.equal(w.cashGapDays, -6, 'collected faster than paid: suppliers are funding it');
});

test('a cycle with no bills is unanswerable, not zero', () => {
  const w = workingCapital({ revenue: 3000000, outstanding: 400000, billed: 0, payable: 0, days: 30 });
  assert.equal(w.dpo, null);
  assert.equal(w.cashGapDays, null);
});

test('the missing stock valuation is declared, not silently omitted', () => {
  const w = workingCapital({ revenue: 1, outstanding: 0, billed: 1, payable: 0, days: 1 });
  assert.equal(w.inventoryDays, null);
  assert.match(w.inventoryNote, /stock/);
});

test('profit that has not become money is visible', () => {
  const q = earningsQuality({
    charged: 1000000, collected: 600000, contribution: 300000, billed: 500000, paid: 200000,
  });
  assert.equal(q.uncollected, 400000);
  assert.equal(q.unpaid, 300000);
  assert.equal(q.netMovement, 400000);
});

// --------------------------------------------------------- unit economics --

test('a line is compared with the weighted group, not the average of the lines', () => {
  // A tiny line at 90% margin and a large one at 50%. The mean of the lines is
  // 70%, which would report the line carrying the business as 20 points below
  // standard. The weighted figure is near 50%, which is the truth.
  const lines = [
    lineRow('restaurant', { net: 10000000, cost: 3000000, labour: 2000000, covers: 5000 }),
    lineRow('kiosk', { net: 100000, cost: 5000, labour: 5000, covers: 50 }),
  ];
  const u = unitEconomics(lines);
  assert.ok(Math.abs(u.group.marginRatio - 0.5) < 0.02);
  const restaurant = u.rows.find((r) => r.line === 'restaurant');
  assert.ok(Math.abs(restaurant.marginVsGroupPts) < 1, 'the line that is the business is the standard');
});

test('return on wage is comparable between a kitchen and a laundry', () => {
  const lines = [lineRow('laundry', { net: 500000, cost: 100000, labour: 200000, covers: 0, orders: 100 })];
  const u = unitEconomics(lines);
  assert.equal(u.rows[0].returnOnWage, 1);
  assert.equal(u.rows[0].unit, 'order');
  assert.equal(u.rows[0].contributionPerUnit, 2000);
});

test('a line the group is told about is a line the group can name', () => {
  // These rows are rendered into a table keyed on the label. An over-broad
  // edit once removed the name fields and the screen showed five nameless
  // rows of money — which every test still passed, because no test had ever
  // asked what the rows were called.
  const c = concentration([
    lineRow('restaurant', { net: 1000000, cost: 300000, labour: 200000 }),
    lineRow('housekeeping', { net: 0, cost: 50000, labour: 300000 }),
  ]);
  assert.equal(c.losing[0].line, 'housekeeping');
  assert.equal(c.losing[0].label, 'housekeeping');
  assert.equal(c.topLine.label, 'restaurant');
});

test('a line is judged against the lines that take money, not against the group', () => {
  // The group's own margin is dragged negative by housekeeping, which has no
  // takings at all and is pure cost by design. Benchmarked against that, the
  // restaurant reads as 64 points above standard — which is not a fact about
  // the restaurant, it is a fact about who pays for the cleaners.
  const u = unitEconomics([
    lineRow('restaurant', { net: 1000000, cost: 300000, labour: 200000, covers: 500 }),
    lineRow('housekeeping', { net: 0, cost: 50000, labour: 900000 }),
  ]);
  assert.ok(u.group.marginRatio < 0, 'the group as a whole lost money');
  assert.equal(u.group.benchmarkRatio, 0.5, 'the earning lines did not');
  const restaurant = u.rows.find((r) => r.line === 'restaurant');
  assert.equal(restaurant.marginVsGroupPts, 0, 'and the only earning line is exactly the standard');
});

test('a support line is not ranked on a number that cannot vary', () => {
  // A line with no takings and no purchases returns exactly -1.00 per wage
  // cedi every time, because its contribution is its wage bill negated.
  const u = unitEconomics([
    lineRow('restaurant', { net: 1000000, cost: 300000, labour: 200000, covers: 500 }),
    lineRow('admin', { net: 0, cost: 0, labour: 400000 }),
    lineRow('housekeeping', { net: 0, cost: 0, labour: 900000 }),
  ]);
  assert.equal(u.rows.find((r) => r.line === 'admin').returnOnWage, null);
  assert.equal(u.rows.find((r) => r.line === 'housekeeping').returnOnWage, null);
  assert.equal(u.rows.find((r) => r.line === 'restaurant').returnOnWage, 2.5);
});

test('shares of profit are withheld when there was no profit to share', () => {
  const u = unitEconomics([
    lineRow('restaurant', { net: 1000000, cost: 300000, labour: 200000 }),
    lineRow('housekeeping', { net: 0, cost: 0, labour: 900000 }),
  ]);
  assert.equal(u.group.sharesMeaningful, false);
  assert.equal(u.rows[0].shareOfContributionPct, null);
});

test('loss-making lines are kept out of the concentration denominator', () => {
  const lines = [
    lineRow('restaurant', { net: 1000000, cost: 300000, labour: 200000 }),
    lineRow('bar', { net: 400000, cost: 100000, labour: 100000 }),
    lineRow('housekeeping', { net: 0, cost: 50000, labour: 300000 }),
  ];
  const c = concentration(lines);
  // 500,000 + 200,000 earned. Including the -350,000 would give 350,000 and a
  // top share of 143%.
  assert.equal(c.totalEarned, 700000);
  assert.ok(c.topSharePct <= 100);
  assert.equal(c.losing.length, 1);
  assert.equal(c.drag, -350000);
});

// -------------------------------------------------------------- run rate --

test('the forecast is built on the median day, so one wedding does not set the month', () => {
  const daily = Array.from({ length: 10 }, (_, i) => dayRow(`2026-05-0${i}`, 0, 0, 0));
  daily.forEach((d, i) => { d.contribution = i === 0 ? 5000000 : 100000; });
  const r = runRate(daily, { daysInPeriod: 30 });
  // Mean day is 590,000; median is 100,000. A mean-based projection would put
  // the month at 16.6m against a truthful 6.9m.
  assert.equal(r.typicalDay, 100000);
  assert.equal(r.projected, 5900000 + 100000 * 20);
  assert.ok(r.projected < 8000000);
});

test('no forecast is offered from a handful of days', () => {
  assert.equal(runRate([dayRow('2026-05-01', 1, 0, 0)], { daysInPeriod: 30 }), null);
});

test('no forecast is offered once the period is over', () => {
  const daily = Array.from({ length: 30 }, (_, i) => dayRow(`2026-05-${i + 1}`, 100000, 0, 0));
  assert.equal(runRate(daily, { daysInPeriod: 30 }), null);
});

// -------------------------------------------------------------- assembly --

test('the whole analysis holds together on one set of numbers', () => {
  const daily = cleanDays();
  const lines = [
    lineRow('restaurant', { net: 6000000, cost: 2000000, labour: 1200000, covers: 3000, hours: 900 }),
    lineRow('bar', { net: 1500000, cost: 500000, labour: 300000, orders: 900, hours: 200 }),
    lineRow('housekeeping', { net: 0, cost: 100000, labour: 600000, hours: 400 }),
  ];
  const prior = [
    lineRow('restaurant', { net: 5500000, cost: 1800000, labour: 1150000, covers: 2800, hours: 880 }),
    lineRow('bar', { net: 1600000, cost: 520000, labour: 300000, orders: 950, hours: 210 }),
    lineRow('housekeeping', { net: 0, cost: 90000, labour: 580000, hours: 390 }),
  ];

  const a = financialAnalysis({
    currentDaily: daily, currentLines: lines,
    priorDaily: daily, priorLines: prior,
    charged: 7500000, collected: 7000000, outstanding: 500000,
    billed: 2600000, paid: 2000000, payable: 600000,
    daysInPeriod: 31,
  });

  assert.equal(a.totals.revenue, 7500000);
  assert.equal(a.totals.contribution, 7500000 - 2600000 - 2100000);
  // Wages are inside contribution already. Taking the whole fixed cost off it
  // would charge the group for its own wage bill twice — which would roughly
  // double the apparent loss, and look exactly like a bad month.
  assert.equal(a.totals.operatingProfit, a.totals.contribution - a.totals.standing);
  assert.equal(a.totals.standing, 0, 'nothing was declared, so nothing is deducted');
  assert.equal(a.bridge.parts.reduce((s, p) => s + p.amount, 0), a.bridge.change);
  assert.equal(a.concentration.losing.length, 1);
  assert.ok(a.lineBridges.length >= 2);
  assert.equal(a.bridge.reconciled, true);
  for (const b of a.lineBridges) {
    assert.equal(b.reconciled, true, `${b.line} bridge must reconcile without a remainder`);
    assert.equal(b.parts.reduce((s, p) => s + p.amount, 0), b.change, `${b.line} bridge must reconcile`);
  }
});

test('every money figure that leaves the analysis is a whole number of pesewas', () => {
  const a = financialAnalysis({
    currentDaily: cleanDays(),
    currentLines: [lineRow('restaurant', { net: 3333333, cost: 777777, labour: 555555, covers: 777 })],
    priorLines: [lineRow('restaurant', { net: 2222222, cost: 666666, labour: 444444, covers: 666 })],
    charged: 3333333, collected: 3000001, outstanding: 333332,
    billed: 777777, paid: 500000, payable: 277777,
    daysInPeriod: 60,
  });

  const moneyKeys = /^(net|cost|labour|contribution|revenue|fixed|fixedTotal|fixedPerDay|wages|wagesPerDay|standing|standingPerDay|standingTotal|purchases|grossMargin|operatingProfit|perDay|forPeriod|amount|change|from|to|projected|low|high|soFar|typicalDay|receivables|payables|charged|collected|uncollected|billed|paid|unpaid|netMovement|drag|totalEarned|short|profit)$/;
  const walk = (node, path) => {
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'number' && moneyKeys.test(k)) {
          assert.ok(Number.isInteger(v), `${path}.${k} is ${v}, not a whole pesewa`);
        }
        walk(v, `${path}.${k}`);
      }
    }
  };
  walk(a, 'analysis');
});
