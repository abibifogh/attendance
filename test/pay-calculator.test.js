import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grossFor, payFrom } from '../src/routes/pay-calculator.js';
import { ratesForResidency, ratesFrom } from '../src/lib/tax.js';

const rates = ratesFrom({});

test('2,000 in hand on a basic of 1,000 is a gross of 2,346.82', () => {
  const r = grossFor(2000, { basic: 1000, rates });
  assert.equal(r.gross, 2346.82);
  assert.equal(r.allowances, 1346.82);
  assert.equal(r.ssnitEmployee, 55);
  assert.equal(r.paye, 291.82);
  assert.equal(r.net, 2000);
  assert.equal(r.cost, 2476.82);
});

test('gross to net is the same arithmetic the other way', () => {
  assert.equal(payFrom(2346.82, 1000, { rates }).net, 2000);
});

test('the gross found is the smallest that pays enough, at every amount', () => {
  for (const net of [400, 489.99, 750, 1234.56, 5000, 25000]) {
    const r = grossFor(net, { basic: null, rates });
    assert.ok(r.net >= net, `${net}: ${r.net}`);
    assert.ok(payFrom(r.gross - 0.01, r.gross - 0.01, { rates }).net < net, `${net} is the smallest`);
  }
});

test('a basic that already pays more than asked is refused', () => {
  assert.match(grossFor(500, { basic: 1000, rates }).error, /Lower the basic/);
});

test('a non-resident is taxed at the flat rate, and no SSNIT where it does not apply', () => {
  const nr = ratesForResidency(rates, 'Non-Resident');
  const r = payFrom(1000, 1000, { rates: nr, ssnit: false });
  assert.equal(r.ssnitEmployee, 0);
  assert.equal(r.paye, 250);
  assert.equal(r.net, 750);
});
