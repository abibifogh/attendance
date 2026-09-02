import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeLine, partMonth } from '../src/lib/payroll.js';
import { RATES } from '../src/lib/tax.js';

/**
 * Somebody who starts or leaves inside the month is paid for the days they
 * were here, on the calendar, and the payslip says so.
 */

const TIERS = { tier1: 0.135, tier2: 0.05 };
const line = (o) => computeLine({
  staff: { id: 1, name: 'Ama' },
  basic: o.basic,
  allowances: o.allow ? [{ name: 'Transport', amount: o.allow, taxable: true }] : [],
  ssnit: true,
  schemes: o.bonus ? [{ id: 1, name: 'Scheme', amount: o.bonus, score: 100 }] : [],
  penalties: [],
  loans: [],
  annualBasic: o.basic * 12,
  bonusPaidThisYear: 0,
  bonusIsNet: false,
  takeHome: o.takeHome ?? null,
  relief: 0,
  partMonth: o.part ?? null,
  rates: RATES,
  tiers: TIERS,
});

test('the part of the month, on the calendar', () => {
  assert.equal(partMonth({ month: '2026-09' }), null, 'a whole month is nothing to say');
  assert.equal(partMonth({ month: '2026-09', hiredOn: '2020-01-01', leftOn: null }), null);
  assert.equal(partMonth({ month: '2026-09', leftOn: '2026-10-05' }), null, 'leaving next month is a whole September');

  assert.deepEqual(partMonth({ month: '2026-09', hiredOn: '2026-09-20' }),
    { days: 11, of: 30, from: '2026-09-20', to: '2026-09-30' });
  assert.deepEqual(partMonth({ month: '2026-08', leftOn: '2026-08-10' }),
    { days: 10, of: 31, from: '2026-08-01', to: '2026-08-10' });
  assert.deepEqual(partMonth({ month: '2026-08', hiredOn: '2026-08-03', leftOn: '2026-08-14' }),
    { days: 12, of: 31, from: '2026-08-03', to: '2026-08-14' });
  assert.deepEqual(partMonth({ month: '2026-02', hiredOn: '2026-02-28' }),
    { days: 1, of: 28, from: '2026-02-28', to: '2026-02-28' });
  assert.equal(partMonth({ month: '2026-09', hiredOn: '2026-10-01' }).days, 0, 'not here yet');
  assert.equal(partMonth({ month: 'nonsense' }), null);
});

test('basic and the standing allowance scale; the bonus and the ceiling do not', () => {
  const whole = line({ basic: 3000, allow: 300, bonus: 500 });
  const part = line({ basic: 3000, allow: 300, bonus: 500, part: { days: 11, of: 30, from: '2026-09-20', to: '2026-09-30' } });

  assert.equal(part.basic, 1100, '3000 × 11/30');
  assert.equal(part.allowances[0].amount, 110);
  assert.equal(part.bonus.gross, whole.bonus.gross, 'scored, not accrued');
  assert.deepEqual(part.partMonth, { days: 11, of: 30, from: '2026-09-20', to: '2026-09-30', basis: 3000 });
  assert.equal(whole.partMonth, undefined);

  // SSNIT follows the basic actually paid.
  assert.equal(part.ssnit.employee, Math.round(1100 * RATES.ssnitEmployee * 100) / 100);
  assert.ok(part.net < whole.net);
});

test('an agreed take-home scales with the days as well', () => {
  const part = line({ basic: 2000, takeHome: 2480, part: { days: 15, of: 30, from: '2026-09-16', to: '2026-09-30' } });
  assert.equal(part.takeHome, 1240);
  assert.equal(part.net, 1240, 'and the allowance is worked out to land on the scaled figure');
});

test('a part-month that is the whole month changes nothing', () => {
  const a = line({ basic: 2500, allow: 200 });
  const b = line({ basic: 2500, allow: 200, part: { days: 30, of: 30, from: '2026-09-01', to: '2026-09-30' } });
  assert.equal(b.basic, a.basic);
  assert.equal(b.net, a.net);
  assert.equal(b.partMonth, undefined);
});

test('nought days is nought pay, not a crash', () => {
  const none = line({ basic: 2500, allow: 200, part: { days: 0, of: 30, from: '2026-10-01', to: '2026-09-30' } });
  assert.equal(none.basic, 0);
  assert.equal(none.gross, 0);
});
