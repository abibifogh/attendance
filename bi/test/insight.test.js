import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import { runEtl } from '../src/warehouse/etl.js';
import { analyse, RULES } from '../src/insight/engine.js';
import { median, mad, robustZ, halves, trendSlope, correlation } from '../src/insight/stats.js';
import { pct, ratio, change, toMinor, minor, formatMoney } from '../src/lib/money.js';
import { all, run } from '../src/lib/db.js';

/**
 * The rules, against a warehouse with a known shape.
 *
 * The demonstration hotel has problems planted in it on purpose: housekeeping
 * that did not shrink when the hotel emptied, a tomato supplier charging the
 * restaurant more than the kitchen, laundry bills that go uncollected, and one
 * cashier whose till is short far more often than anybody else's. If a rule
 * stops finding the thing it was written to find, these tests say so.
 */

const WINDOW = { from: '2026-03-01', to: '2026-07-15' };

async function analysed() {
  const { raw, db } = freshDb('migrations');
  await runEtl({ DB: db }, { ...WINDOW, trigger: 'test' });
  const result = await analyse(db, WINDOW);
  return { raw, db, ...result };
}

test('no rule throws, and every one that fires is well formed', async () => {
  const { findings, errors } = await analysed();
  assert.deepEqual(errors, [], 'a rule that throws costs the whole brief');
  assert.ok(findings.length >= 8, `expected a handful of findings, got ${findings.length}`);

  for (const finding of findings) {
    assert.ok(finding.headline?.length > 10, 'a finding needs a sentence, not a label');
    assert.ok(finding.detail?.length > 40, `${finding.ruleId} must explain itself`);
    assert.ok(['critical', 'warning', 'info', 'good'].includes(finding.severity));
    assert.ok(['high', 'medium', 'low'].includes(finding.confidence));
    assert.ok(Number.isInteger(finding.impactMonthly) && finding.impactMonthly >= 0,
      `${finding.ruleId} impact must be whole pesewas`);
    assert.ok(finding.evidence && typeof finding.evidence === 'object',
      `${finding.ruleId} must show its working`);
  }
});

test('findings are ranked by what they are worth, not by how loud they sound', async () => {
  const { findings } = await analysed();
  for (let i = 1; i < findings.length; i += 1) {
    assert.ok(findings[i - 1].impactMonthly >= findings[i].impactMonthly);
  }
});

test('the cross-system rules each find the thing they were written for', async () => {
  const { findings } = await analysed();
  const fired = new Set(findings.map((f) => f.ruleId));

  // Each of these needs at least two source systems to reach its conclusion.
  // That is the whole claim of the application, so it is the thing tested.
  for (const ruleId of [
    'price-divergence',           // breakfast purchases vs POS purchases
    'uncollected-revenue',        // laundry charged vs collected
    'labour-share',               // attendance hours vs POS and laundry takings
    'absence-to-missed-work',     // attendance absence vs housekeeping rounds
    'coverage-gaps',              // what none of the four systems records
  ]) {
    assert.ok(fired.has(ruleId), `${ruleId} found nothing in a warehouse built to trip it`);
  }
});

test('the supplier overcharge is found, and names both sides', async () => {
  const { findings } = await analysed();
  const finding = findings.find((f) => f.ruleId === 'price-divergence');
  assert.ok(finding, 'the two-price purchase was not found');
  assert.match(finding.headline.toLowerCase(), /tomato/);
  assert.ok(finding.evidence.dearer.unitCost > finding.evidence.cheaper.unitCost);
  assert.ok(finding.evidence.gapPct >= 12);
  assert.ok(finding.sources.includes('breakfast') && finding.sources.includes('pos'),
    'a finding that crossed two systems must say so');
});

test('missed housekeeping checks are tied to who was absent', async () => {
  const { findings } = await analysed();
  const finding = findings.find((f) => f.ruleId === 'absence-to-missed-work');
  assert.ok(finding);
  assert.ok(finding.evidence.fullTeamCompletionPct > finding.evidence.shortTeamCompletionPct);
  assert.ok(finding.evidence.fullDays >= 5 && finding.evidence.shortDays >= 5,
    'the comparison must rest on enough days of each kind');
});

test('the missing rooms system is stated rather than quietly omitted', async () => {
  const { findings } = await analysed();
  const finding = findings.find((f) => f.ruleId === 'coverage-gaps' && f.line === 'rooms');
  assert.ok(finding, 'a group margin without room revenue must say so on its own screen');
  assert.equal(finding.evidence.roomsRevenue, 0);
  assert.ok(finding.evidence.roomsLabour + finding.evidence.housekeepingCost > 0);
});

test('a dismissed finding stays dismissed when the rule fires again', async () => {
  const { raw, db } = freshDb('migrations');
  await runEtl({ DB: db }, { ...WINDOW, trigger: 'test' });
  await analyse(db, WINDOW);

  const target = raw.prepare("SELECT * FROM findings WHERE state = 'open' LIMIT 1").get();
  assert.ok(target, 'expected at least one open finding');
  await run(db, "UPDATE findings SET state = 'dismissed' WHERE id = ?1", target.id);

  await analyse(db, WINDOW);
  const after = raw.prepare('SELECT state FROM findings WHERE id = ?').get(target.id);
  assert.equal(after.state, 'dismissed',
    'a finding somebody put down must not be back at the top of the brief tomorrow');
});

test('a finding that stops being true stops being live', async () => {
  const { raw, db } = freshDb('migrations');
  await runEtl({ DB: db }, { ...WINDOW, trigger: 'test' });
  await analyse(db, WINDOW);
  const before = raw.prepare("SELECT COUNT(*) AS n FROM findings WHERE state = 'open'").get().n;
  assert.ok(before > 0);

  // A window with nothing in it: every rule falls silent.
  await analyse(db, { from: '2020-01-01', to: '2020-01-10' });
  const stillOpen = raw.prepare(
    "SELECT COUNT(*) AS n FROM findings WHERE state = 'open' AND rule_id <> 'coverage-gaps'").get().n;
  assert.equal(stillOpen, 0, 'the brief must clear itself when the evidence goes away');
});

// ------------------------------------------------------------ statistics --

test('the statistics refuse to answer questions they cannot', () => {
  assert.equal(median([]), null);
  assert.equal(mad([5, 5, 5]), 0);
  assert.equal(robustZ(9, [5, 5, 5]), null, 'no spread means no z-score, not an infinite one');
  assert.equal(halves([1, 2, 3], 5), null, 'too few points is null, not a trend');
  assert.equal(trendSlope([1, 2]), null);
  assert.equal(correlation([1, 2, 3], [1, 2, 3]), null, 'three points is not a correlation');
});

test('medians ignore the one catastrophic day that a mean would not', () => {
  const ordinary = [100, 102, 98, 101, 99, 103, 97];
  const withDisaster = [...ordinary, 5000];

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  // The mean is dragged more than six hundred points by a single wedding.
  assert.ok(mean(withDisaster) - mean(ordinary) > 600);
  // The median barely moves, which is why every rule in this app uses one.
  assert.ok(Math.abs(median(withDisaster) - median(ordinary)) <= 1,
    'one wedding must not redefine a normal day');

  // The same property, for the spread: a MAD is not widened by an outlier
  // until nothing is ever unusual again.
  assert.ok(mad(withDisaster) < 10);
});

test('a split-half comparison reports the direction and the size', () => {
  const falling = [100, 100, 100, 100, 100, 100, 60, 60, 60, 60, 60, 60];
  const split = halves(falling, 5);
  assert.equal(split.before, 100);
  assert.equal(split.after, 60);
  assert.equal(split.changePct, -40);
});

// ----------------------------------------------------------------- money --

test('money never becomes a float, and a ratio with no denominator is null', () => {
  assert.equal(toMinor(12.34), 1234);
  assert.equal(toMinor('0.1') + toMinor('0.2'), toMinor(0.3),
    'the reason every figure in this app is an integer');
  assert.equal(minor('4500'), 4500);
  assert.equal(minor(null), 0);

  assert.equal(pct(50, 0), null, 'a labour ratio on a day with no revenue has no answer');
  assert.equal(ratio(1, 0), null);
  assert.equal(change(0, 5), null);
  assert.equal(pct(25, 100), 25);
  assert.equal(change(100, 150), 50);
});

test('money formats as the group would write it', () => {
  assert.equal(formatMoney(123456, { symbol: 'GH₵' }), 'GH₵1,234.56');
  assert.equal(formatMoney(-500, { symbol: 'GH₵' }), '-GH₵5.00');
  assert.equal(formatMoney(0, { symbol: 'GH₵' }), 'GH₵0.00');
});

test('every rule declares an id and a title, and the ids are unique', () => {
  const ids = RULES.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length, 'two rules sharing an id would overwrite each other');
  for (const rule of RULES) {
    assert.ok(rule.id && rule.title, 'a rule needs a name a person can search for');
    assert.equal(typeof rule.run, 'function');
  }
});
