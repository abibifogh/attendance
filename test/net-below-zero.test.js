import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { belowZero } from '../public/js/pay-checks.js';

/**
 * A warning when deductions take somebody's net pay below zero: nothing in the
 * sums stops it, so the payroll screen says so before the month is closed.
 * Made-up people only.
 */

const line = (name, net, extra = {}) => ({
  staff: { id: name.length, name }, net, gross: 300, ssnit: { employee: 16.5 }, paye: { total: 0 },
  loanTotal: 0, loans: [], ...extra,
});

test('only those below zero, worst first, with what took them there', () => {
  const out = belowZero([
    line('Fine Person', 120),
    line('Desk One', -40, { loanTotal: 323.5, loans: [{ what: 'till', amount: 200 }, { what: 'other', amount: 123.5 }] }),
    line('Desk Two', -5, { loanTotal: 288.5, loans: [{ what: 'till', amount: 288.5 }] }),
    line('Exactly Zero', 0),
  ]);
  assert.deepEqual(out.map((p) => p.name), ['Desk One', 'Desk Two']);
  assert.deepEqual(out[0], { staffId: 8, name: 'Desk One', net: -40, gross: 300, ssnit: 16.5, paye: 0, advances: 123.5, till: 200 });
  assert.equal(out[1].advances, 0);
  assert.deepEqual(belowZero([]), []);
});

test('the payroll screen warns above the table and again when closing', () => {
  const view = readFileSync('public/js/views/att-payroll.js', 'utf8');
  assert.match(view, /belowZeroAlert\(belowZero\(data\.lines/);
  assert.match(view, /'Close it anyway'/);
  assert.match(view, /'below zero'/);
});
