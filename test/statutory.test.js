import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RATES, ratesFrom, round2 } from '../src/lib/tax.js';
import { computeLine, totalsOf } from '../src/lib/payroll.js';
import { TIERS, journalFor, payeSchedule, tierSplit, tiersFrom } from '../src/lib/statutory.js';

/**
 * The month's two returns.
 *
 * Every figure below can be worked out on paper, because these end up on a
 * journal somebody types into the books and on a return somebody files with
 * the GRA. The pension split in particular: 18.5% of basic in total, divided
 * 13.5 to SSNIT and 5 to a private trustee under the National Pensions Act
 * 2008 (Act 766), which is not the same division as the 5.5 / 13 between the
 * worker and the property.
 */

const rates = ratesFrom({});

// ---------------------------------------------------------------------------
// The tier split
// ---------------------------------------------------------------------------

test('the pension is one deduction and two payments', () => {
  const split = tierSplit(2000, { rates });

  assert.equal(split.employee, 110, '5.5% from the worker');
  assert.equal(split.employer, 260, '13% from the property');
  assert.equal(split.total, 370, '18.5% in all');

  assert.equal(split.tier1, 270, '13.5% to SSNIT');
  assert.equal(split.tier2, 100, '5% to the trustee');
  assert.equal(split.tier1 + split.tier2, split.total, 'and the two add back up');
  assert.equal(split.unallocated, 0);
});

test('the tiers are not the worker and the property halves', () => {
  const split = tierSplit(1000, { rates });
  // The temptation is to call the worker's 5.5% tier two because it is the
  // smaller number. It is not: tier two is 5% of basic and comes out of the
  // pot, not out of anybody's half.
  assert.notEqual(split.tier2, split.employee);
  assert.equal(split.tier2, 50);
  assert.equal(split.employee, 55);
});

test('somebody outside SSNIT contributes nothing to either tier', () => {
  assert.deepEqual(tierSplit(2000, { qualifies: false, rates }), {
    employee: 0, employer: 0, total: 0, tier1: 0, tier2: 0, unallocated: 0,
  });
});

test('a rate a property has edited into something that does not add up is said out loud', () => {
  // 5.5 + 13 is 18.5, and 13.5 + 5 is 18.5. Move one and the return no longer
  // accounts for every cedi, which is worth a line rather than a silence.
  const bent = ratesFrom({ pay_ssnit_employer: '0.15' });
  const split = tierSplit(1000, { rates: bent });

  assert.equal(split.total, 205);
  assert.equal(split.tier1 + split.tier2, 185);
  assert.equal(split.unallocated, 20);
});

test('the tier rates can be set, and fall back when they are nonsense', () => {
  assert.deepEqual(tiersFrom({}), TIERS);
  assert.deepEqual(tiersFrom({ pay_tier1: '0.14', pay_tier2: '0.045' }), { tier1: 0.14, tier2: 0.045 });
  assert.deepEqual(tiersFrom({ pay_tier1: 'nonsense', pay_tier2: '-1' }), TIERS);
});

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

/** One person on 2,000 basic with a 300 allowance, and one on 1,200 with none. */
function month() {
  const lines = [
    computeLine({
      staff: { id: 1, name: 'Ama Boateng' },
      basic: 2000,
      allowances: [{ name: 'Transport', amount: 300, taxable: true }],
      ssnit: true,
      rates,
    }),
    computeLine({
      staff: { id: 2, name: 'Kofi Mensah' },
      basic: 1200,
      allowances: [],
      ssnit: true,
      rates,
    }),
  ];
  return { lines, totals: totalsOf(lines) };
}

test('the journal balances', () => {
  const { lines, totals } = month();
  const journal = journalFor({ lines, totals, rates });

  assert.equal(journal.debitTotal, journal.creditTotal);
  assert.equal(journal.difference, 0);
});

test('the journal debits the wages and the property’s own contribution', () => {
  const { lines, totals } = month();
  const journal = journalFor({ lines, totals, rates });
  const debit = (name) => journal.debits.find((r) => r.account === name)?.amount;

  assert.equal(debit('Salaries and wages'), 3500, '2,000 + 1,200 basic and a 300 allowance');
  assert.equal(debit('Employer pension contribution'), 416, '13% of 3,200 of basic');
  assert.equal(debit('Bonus'), undefined, 'no bonus this month, so no empty line for one');
});

test('the journal credits each tier separately', () => {
  const { lines, totals } = month();
  const journal = journalFor({ lines, totals, rates });
  const credit = (name) => journal.credits.find((r) => r.account === name)?.amount;

  assert.equal(credit('SSF payable, tier 1 (SSNIT)'), 432, '13.5% of 3,200');
  assert.equal(credit('SSF payable, tier 2 (trustee)'), 160, '5% of 3,200');
  assert.equal(credit('SSF payable, unallocated'), undefined, 'nothing left over to explain');
  assert.equal(credit('PAYE payable (GRA)'), totals.paye);
  assert.equal(credit('Net pay'), totals.net);
});

test('a month with nothing in it produces nothing rather than a page of zeros', () => {
  const journal = journalFor({ lines: [], totals: totalsOf([]), rates });
  assert.deepEqual(journal.debits, []);
  assert.deepEqual(journal.credits, []);
  assert.equal(journal.difference, 0);
});

test('advance repayments are a credit, not money that left the building', () => {
  const lines = [computeLine({
    staff: { id: 1, name: 'Ama Boateng' },
    basic: 2000,
    ssnit: true,
    loans: [{ advanceId: 4, amount: 250 }],
    rates,
  })];
  const journal = journalFor({ lines, totals: totalsOf(lines), rates });

  assert.equal(journal.credits.find((r) => r.account === 'Staff advances')?.amount, 250);
  assert.equal(journal.debitTotal, journal.creditTotal);
});

// ---------------------------------------------------------------------------
// The PAYE schedule
// ---------------------------------------------------------------------------

test('the schedule is a row per person with the GRA’s own columns', () => {
  const { lines } = month();
  const people = new Map([
    [1, { tin_number: 'P0012345678', ssnit_number: 'C123456789012' }],
  ]);
  const { rows, totals } = payeSchedule({ lines, people });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].no, 1);
  assert.equal(rows[0].name, 'Ama Boateng');
  assert.equal(rows[0].tin, 'P0012345678');
  assert.equal(rows[0].ssnitNumber, 'C123456789012');
  assert.equal(rows[0].basic, 2000);
  assert.equal(rows[0].allowances, 300);
  assert.equal(rows[0].totalCash, 2300);
  assert.equal(rows[0].ssf, 110);
  assert.equal(rows[0].chargeable, 2190);
  assert.equal(rows[0].total, rows[0].tax);

  // Nobody has a relief certificate in a payroll, so the column is empty
  // rather than a zero that would be filed as a claim of none.
  assert.equal(rows[0].relief, null);

  // A person with no record yet comes through with the money right and the
  // numbers blank, so the sheet still shows what is owed.
  assert.equal(rows[1].tin, '');
  assert.equal(rows[1].ssnitNumber, '');
  assert.equal(rows[1].basic, 1200);

  assert.equal(totals.basic, 3200);
  assert.equal(totals.totalCash, 3500);
  assert.equal(totals.ssf, 176);
});

test('a bonus is its own two columns on the schedule', () => {
  const lines = [computeLine({
    staff: { id: 1, name: 'Ama Boateng' },
    basic: 2000,
    ssnit: true,
    schemes: [{ id: 1, name: 'Service', amount: 500, score: 100 }],
    rates,
  })];
  const [row] = payeSchedule({ lines }).rows;

  assert.ok(row.bonus > 500, 'grossed up, because the property carries the tax');
  assert.ok(row.bonusTax > 0);
  // The whole PAYE is the salary tax and the bonus tax added up.
  assert.equal(row.total, Math.round((row.tax + row.bonusTax) * 100) / 100);
});

test('the published rates are still the published rates', () => {
  assert.equal(RATES.ssnitEmployee + RATES.ssnitEmployer, 0.185);
  assert.equal(TIERS.tier1 + TIERS.tier2, 0.185);
});


test('a bonus past the 15% ceiling is split on the schedule', () => {
  // 15% of 24,000 of annual basic is 3,600, so a bonus larger than that has an
  // excess: the first 3,600 at the 5% final rate, the rest added to income and
  // taxed on the graduated bands like any other pay.
  const lines = [computeLine({
    staff: { id: 1, name: 'Ama Boateng' },
    basic: 2000,
    ssnit: true,
    schemes: [{ id: 1, name: 'Year end', amount: 5000, score: 100 }],
    rates,
  })];
  const [row] = payeSchedule({ lines }).rows;

  assert.equal(row.bonus, 3600, 'the ceiling, at the final rate');
  assert.equal(row.bonusTax, 180, '5% of 3,600');
  assert.ok(row.excessBonus > 0, 'and the rest is excess');

  // The excess is income, so it is inside the chargeable figure rather than
  // beside it. Salary chargeable is 2,000 less 110 of SSNIT.
  assert.equal(row.chargeable, round2(1890 + row.excessBonus));

  // The whole row reconciles down the page, which is what a return is for:
  // everything paid, less the part taxed separately, less the contribution,
  // is what the graduated bands were applied to.
  assert.equal(row.totalCash, round2(row.basic + row.allowances + row.bonus + row.excessBonus));
  assert.equal(row.chargeable, round2(row.totalCash - row.bonus - row.ssf));
  assert.equal(row.total, round2(row.tax + row.bonusTax));
});

test('a bonus inside the ceiling has no excess at all', () => {
  const lines = [computeLine({
    staff: { id: 1, name: 'Ama Boateng' },
    basic: 2000,
    ssnit: true,
    schemes: [{ id: 1, name: 'Service', amount: 500, score: 100 }],
    rates,
  })];
  const [row] = payeSchedule({ lines }).rows;

  assert.equal(row.excessBonus, 0);
  assert.equal(row.bonusTax, round2(row.bonus * 0.05));
  // Nothing of the bonus reached the graduated bands, so chargeable income is
  // the salary less the contribution and nothing else.
  assert.equal(row.chargeable, 1890);
});

test('the schedule totals the excess with everything else', () => {
  const lines = [
    computeLine({
      staff: { id: 1, name: 'Ama Boateng' },
      basic: 2000,
      ssnit: true,
      schemes: [{ id: 1, name: 'Year end', amount: 5000, score: 100 }],
      rates,
    }),
    computeLine({ staff: { id: 2, name: 'Kofi Mensah' }, basic: 1200, ssnit: true, rates }),
  ];
  const { rows, totals } = payeSchedule({ lines });

  assert.equal(totals.excessBonus, round2(rows[0].excessBonus + rows[1].excessBonus));
  assert.equal(totals.total, round2(totals.tax + totals.bonusTax));
});
