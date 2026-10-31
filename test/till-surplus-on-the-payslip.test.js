import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RATES } from '../src/lib/tax.js';
import { computeLine, totalsOf } from '../src/lib/payroll.js';
import { journalFor } from '../src/lib/statutory.js';

/**
 * A till surplus paid with salary meets any till shortage on the same payslip
 * first; what is left is added to the pay, after tax and untaxed. Made-up
 * people and figures.
 */

const line = (over = {}) => computeLine({
  staff: { id: 1, name: 'Desk Person' },
  basic: 2000,
  allowances: [{ name: 'Allowance', amount: 500, taxable: 1 }],
  ssnit: true,
  rates: RATES,
  ...over,
});

const shortage = (amount) => ({ advanceId: 1, amount, what: 'till' });
const surplus = (amount) => ({ creditId: 1, amount });

test('a surplus nets against a shortage, and the rest is paid untaxed', () => {
  const plain = line();
  const short = line({ loans: [shortage(50)] });
  assert.equal(short.net, Math.round((plain.net - 50) * 100) / 100);

  // Over 30, short 50: 20 comes off.
  const both = line({ loans: [shortage(50)], tillCredits: [surplus(30)] });
  assert.equal(both.net, Math.round((plain.net - 20) * 100) / 100);
  assert.equal(both.loanTotal, 50, 'the shortage is recovered in full');
  assert.equal(both.tillCredit, 30);

  // Over 80, short 50: 30 is added.
  const more = line({ loans: [shortage(50)], tillCredits: [surplus(80)] });
  assert.equal(more.net, Math.round((plain.net + 30) * 100) / 100);

  // Untaxed: gross, PAYE and SSNIT do not move.
  assert.deepEqual([more.gross, more.paye.total, more.ssnit.employee], [plain.gross, plain.paye.total, plain.ssnit.employee]);
});

test('a take-home is not stretched to cancel a surplus out', () => {
  const plain = line({ takeHome: 2200 });
  const paid = line({ takeHome: 2200, tillCredits: [surplus(40)] });
  assert.equal(paid.workedOut, plain.workedOut, 'the allowance is worked out on a clean month');
  assert.equal(paid.net, Math.round((plain.net + 40) * 100) / 100);
});

test('the journal balances with a surplus paid back', () => {
  const lines = [line({ loans: [shortage(50)], tillCredits: [surplus(80)] }), line()];
  const totals = totalsOf(lines);
  assert.equal(totals.tillCredit, 80);
  const journal = journalFor({ lines, totals, rates: RATES });
  assert.ok(journal.debits.some((d) => d.account === 'Till surpluses paid back' && d.amount === 80));
  assert.ok(Math.abs(journal.difference) < 0.05, `debits and credits agree (${journal.difference})`);
});
