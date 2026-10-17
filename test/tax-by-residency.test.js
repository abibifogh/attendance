import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BANDS, RATES, flatRateFor, payeOn } from '../src/lib/tax.js';
import { computeLine } from '../src/lib/payroll.js';
import { RESIDENCIES, payeSchedule } from '../src/lib/statutory.js';

/**
 * Tax for somebody who is not a full-time resident in their main job.
 *
 * The GRA's September 2026 schedule (paye202609grra) works column 23 out at
 * one rate on the whole chargeable income for everybody but a full-time
 * resident: 25% non-resident, 10% part-time, 5% casual, and a second job at
 * the rate in its name. Nobody on the payroll is on any of those today; this
 * is so the day somebody is, the payslip and the return are right. Every
 * name is made up.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rates = { ...RATES, bands: BANDS };

const line = (over = {}) => computeLine({
  staff: { id: 1, name: 'Kofi Mensah' },
  basic: 3000,
  allowances: [{ name: 'Allowance', amount: 500, taxable: 1 }],
  ssnit: true,
  rates,
  ...over,
});

test('the flat rate each residency is taxed at', () => {
  assert.equal(flatRateFor('Resident-Full-Time'), null);
  assert.equal(flatRateFor(''), null);
  assert.equal(flatRateFor(null), null);
  assert.equal(flatRateFor('Non-Resident'), 0.25);
  assert.equal(flatRateFor('Resident-Part-Time'), 0.10);
  assert.equal(flatRateFor('Resident-Casual'), 0.05);
  assert.equal(flatRateFor('Secondary@17.5%'), 0.175);
  assert.equal(flatRateFor('Secondary@35%'), 0.35);
});

test('every residency the form offers can be picked, second jobs included', () => {
  for (const r of ['Secondary@5%', 'Secondary@10%', 'Secondary@17.5%', 'Secondary@25%', 'Secondary@30%', 'Secondary@35%']) {
    assert.ok(RESIDENCIES.includes(r), r);
  }
});

test('a full-time resident is still taxed on the bands', () => {
  const plain = line();
  const chargeable = round2(3500 - 3000 * 0.055);
  assert.equal(plain.paye.total, payeOn(chargeable, BANDS).tax);
  assert.equal(plain.flatRate, null);
});

test('everybody else pays one rate on the whole chargeable income', () => {
  const chargeable = round2(3500 - 3000 * 0.055);
  for (const [residency, rate] of [
    ['Non-Resident', 0.25], ['Resident-Part-Time', 0.10], ['Resident-Casual', 0.05], ['Secondary@17.5%', 0.175],
  ]) {
    const l = line({ residency });
    assert.equal(l.chargeable, chargeable, residency);
    assert.equal(l.paye.total, round2(chargeable * rate), residency);
    assert.equal(l.flatRate, rate);
    assert.equal(l.net, round2(3500 - l.ssnit.employee - l.paye.total), residency);
  }
});

test('the bonus under the ceiling keeps its 5%, and only the excess takes the flat rate', () => {
  // A gross bonus of 600 on a basic of 3,000: 450 fits under the monthly 15%
  // and is taxed at 5% as a final tax; the other 150 joins the income.
  const l = line({
    residency: 'Non-Resident', bonusIsNet: false,
    schemes: [{ id: 1, name: 'Nkosoɔ', amount: 600, score: 100 }],
  });
  assert.equal(l.bonus.atFinalRate, 450);
  assert.equal(l.bonus.atGraduated, 150);
  assert.equal(l.paye.finalOnBonus, round2(450 * 0.05));
  const chargeable = round2(3500 - 3000 * 0.055 + 150);
  assert.equal(l.paye.total, round2(chargeable * 0.25 + 450 * 0.05));
});

test('the return says Y in column 7 for a second job, and the residency in column 5', () => {
  const second = line({ residency: 'Secondary@10%' });
  const main = line({ staff: { id: 2, name: 'Ama Boateng' } });
  const { rows } = payeSchedule({ lines: [second, main] });
  assert.equal(rows[0].residency, 'Secondary@10%');
  assert.equal(rows[0].secondary, 'Y');
  assert.equal(rows[1].residency, 'Resident-Full-Time');
  assert.equal(rows[1].secondary, 'N');
  assert.equal(rows[0].tax, second.paye.total);
});
