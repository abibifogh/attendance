import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb } from './helpers.js';
import { pull, hourlyCost, rateOn } from '../src/connectors/attendance.js';
// HIVE's own arithmetic. Imported here and nowhere else: a test is not
// deployed, so reading across the two Workers costs nothing at run time, and
// it is the only way to hold the copy in the connector to the original.
import { perDayAndHour } from '../../src/lib/pay.js';

/**
 * What people are paid, coming out of HIVE and into the warehouse.
 *
 * Two things here can be wrong in a way nobody notices for a quarter.
 *
 * The unit. HIVE keeps money as REAL cedis — `pay_slip.cost` of `2450.75`
 * means GH₵2,450.75. This warehouse is whole pesewas. Loading it with `minor`
 * instead of `toMinor` gives 2,451 pesewas, or GH₵24.51: a wage bill a
 * hundredth of its real size, with no error, no warning, and a plausible
 * number on the screen. Every money assertion below is written in both units
 * so the factor is visible in the test as well as in the code.
 *
 * The basis. A monthly salary is not an hourly rate until you know how the
 * person's week is shaped, and the two apps must agree about that or the same
 * person costs two different amounts depending on which screen you are on.
 */

function hiveDb() {
  // HIVE's real migrations, not a copy of its schema, so a column renamed over
  // there fails here rather than in production.
  const { raw, db } = freshDb('../migrations');
  raw.exec(`
    DELETE FROM att_days; DELETE FROM att_staff; DELETE FROM att_holidays;
    INSERT INTO att_staff (id, employee_no, name, department, job_title, active, days_per_week)
      VALUES (1, 'E1', 'Ama Boateng', 'Housekeeping', 'Room Attendant', 1, 6),
             (2, 'E2', 'Kwesi Bediako', 'Kitchen', 'Head Chef', 1, 5),
             (3, 'E3', 'Yaw Owusu', 'Front Office', 'Porter', 1, NULL);

    -- A rise in the middle of the window, and an older rate that must not be
    -- carried backwards over it.
    INSERT INTO hr_pay (staff_id, basis, amount, from_day) VALUES
      (1, 'monthly', 1800.00, '2026-01-01'),
      (1, 'monthly', 2100.00, '2026-05-01'),
      (2, 'daily',    240.00, '2026-01-01');
    -- Yaw has no rate at all. He must stay uncosted rather than be guessed at.

    INSERT INTO att_days (staff_id, day, scheduled, expected_minutes, first_in, last_out,
                          worked_minutes, late_minutes, overtime_minutes, status, reason_code)
      VALUES (1, '2026-05-04', 1, 360, '07:05', '13:30', 355, 5, 0, 'late', 'late'),
             (2, '2026-05-04', 1, 720, '06:00', '18:20', 740, 0, 20, 'present', 'present');

    INSERT INTO pay_run (id, month, status) VALUES (1, '2026-05', 'final'), (2, '2026-06', 'draft');
    INSERT INTO pay_slip (run_id, staff_id, detail, gross, bonus_gross, ssf_employee, ssf_employer,
                          paye, loans, net, cost)
      VALUES (1, 1, '{}', 2450.75, 150.00, 115.50, 273.00, 210.25, 100.00, 2025.00, 2723.75),
             (1, 2, '{}', 5200.00, 0,      286.00, 676.00, 780.00,   0,    4134.00, 5876.00),
             -- A draft month, which must not be read at all.
             (2, 1, '{}', 9999.99, 0,      0,      0,      0,        0,    9999.99, 9999.99);
  `);
  return { raw, db };
}

const may = { from: '2026-05-01', to: '2026-05-31' };

test('a payslip arrives in pesewas, not in cedis', async () => {
  const { db } = hiveDb();
  const bundle = await pull({ db, ...may });

  const ama = bundle.payroll.find((p) => p.externalId === '1');
  assert.ok(ama, 'Ama has a payslip in this month');

  // GH₵2,723.75 employer cost. Written out in full because the whole risk here
  // is a factor of a hundred, and 272375 is the only value that is right.
  assert.equal(ama.cost, 272_375);
  assert.equal(ama.gross, 245_075);
  assert.equal(ama.net, 202_500);
  assert.equal(ama.paye, 21_025);
  assert.equal(ama.ssfEmployee, 11_550);
  assert.equal(ama.ssfEmployer, 27_300);
  assert.equal(ama.loans, 10_000);
  assert.equal(ama.bonusGross, 15_000);

  // The failure mode this exists to catch: `minor()` would have given 2,724.
  assert.notEqual(ama.cost, 2_724);
  assert.ok(ama.cost > 100_000, 'a wage bill a hundredth of its size is the bug');
});

test('every money field on a payslip is a whole number of pesewas', async () => {
  const { db } = hiveDb();
  const bundle = await pull({ db, ...may });
  for (const slip of bundle.payroll) {
    for (const [field, value] of Object.entries(slip)) {
      if (typeof value !== 'number') continue;
      assert.ok(Number.isInteger(value), `${slip.externalId}.${field} is ${value}`);
    }
  }
});

test('the employer cost includes the pension the employer pays', async () => {
  const { db } = hiveDb();
  const bundle = await pull({ db, ...may });
  const ama = bundle.payroll.find((p) => p.externalId === '1');

  // Gross plus the employer's 13%. A labour ratio struck on gross alone
  // understates what the business actually parts with, and does so by more
  // than most of the effects this warehouse looks for.
  assert.equal(ama.cost, ama.gross + ama.ssfEmployer);
  assert.ok(ama.ssfEmployer > 0);
});

test('a draft pay run is not read', async () => {
  const { db } = hiveDb();
  const bundle = await pull({ db, from: '2026-05-01', to: '2026-06-30' });

  assert.equal(bundle.payroll.filter((p) => p.month === '2026-06').length, 0,
    'a draft is somebody mid-calculation, not a fact');
  assert.equal(bundle.payroll.length, 2, 'only May, and only its two closed slips');
});

test('a payslip carries the line its person belongs to', async () => {
  const { db } = hiveDb();
  const bundle = await pull({ db, ...may });
  assert.equal(bundle.payroll.find((p) => p.externalId === '1').line, 'housekeeping');
  assert.equal(bundle.payroll.find((p) => p.externalId === '2').line, 'restaurant');
});

test('a window inside one month still gets that month\'s payroll', async () => {
  const { db } = hiveDb();
  const bundle = await pull({ db, from: '2026-05-03', to: '2026-05-09' });
  assert.equal(bundle.payroll.length, 2, 'a week in May is a week in which May\'s payroll applies');
});

// ----------------------------------------------------------------- rates --

test('each person is costed at their own rate, not one rate for everybody', async () => {
  const { db } = hiveDb();
  const bundle = await pull({ db, ...may });

  const ama = bundle.people.find((p) => p.externalId === '1');
  const chef = bundle.people.find((p) => p.externalId === '2');
  const porter = bundle.people.find((p) => p.externalId === '3');

  assert.ok(ama.hourCost > 0);
  assert.ok(chef.hourCost > 0);
  assert.notEqual(ama.hourCost, chef.hourCost, 'a room attendant and a head chef are not the same cost');
  assert.equal(porter.hourCost, null, 'nobody without a rate may be given one');
});

test('a rise applies from the day it starts, and not before', () => {
  const rates = [
    { basis: 'monthly', amount: 1800, from_day: '2026-01-01' },
    { basis: 'monthly', amount: 2100, from_day: '2026-05-01' },
  ];
  assert.equal(rateOn(rates, '2026-04-30').amount, 1800);
  assert.equal(rateOn(rates, '2026-05-01').amount, 2100);
  assert.equal(rateOn(rates, '2026-06-15').amount, 2100);
  // Before the first rate there is no rate. Carrying today's backwards would
  // restate last year's wage bill every time somebody got a rise.
  assert.equal(rateOn(rates, '2025-12-31'), null);
  assert.equal(rateOn([], '2026-05-01'), null);
});

test('how the week is shaped changes what an hour costs', () => {
  const salary = { basis: 'monthly', amount: 2100, from_day: '2026-01-01' };
  const five = hourlyCost(salary, { daysPerWeek: 5 });
  const six = hourlyCost(salary, { daysPerWeek: 6 });

  // The same money spread over more days is a lower hourly cost. Dividing by a
  // flat five would price the people who work the most as the most expensive,
  // which is exactly backwards.
  assert.ok(six < five, `six days ${six} should cost less an hour than five ${five}`);
});

test('a month is not four weeks', () => {
  // 52/12, not 4. The difference is about 8% of every salaried person's hourly
  // cost — larger than most of what this warehouse is trying to detect.
  const naive = Math.round((2100 / (4 * 5) / 8) * 100);
  assert.notEqual(hourlyCost({ basis: 'monthly', amount: 2100 }, { daysPerWeek: 5 }), naive);
});

test('the rate arithmetic agrees with HIVE\'s own', () => {
  // The connector holds a copy because the two apps are separate Workers and a
  // shared file between them is a shared deploy. A copy that drifts is worse
  // than no copy, so it is pinned to the original here.
  const shapes = [
    { daysPerWeek: 5, hoursPerDay: 8 },
    { daysPerWeek: 6, hoursPerDay: 8 },
    { daysPerWeek: 4, hoursPerDay: 12 },
    { daysPerWeek: 7, hoursPerDay: 6 },
  ];
  const rates = [
    { basis: 'monthly', amount: 1800 },
    { basis: 'monthly', amount: 2450.75 },
    { basis: 'daily', amount: 240 },
    { basis: 'hourly', amount: 18.5 },
  ];

  for (const shape of shapes) {
    for (const rate of rates) {
      const hive = perDayAndHour(rate, shape);
      const mine = hourlyCost(rate, shape);
      assert.equal(mine, Math.round(hive.hour * 100),
        `${rate.basis} ${rate.amount} at ${shape.daysPerWeek}×${shape.hoursPerDay}: `
        + `connector ${mine}, HIVE ${Math.round(hive.hour * 100)}`);
    }
  }
});

test('an hourly rate is itself, converted and nothing more', () => {
  assert.equal(hourlyCost({ basis: 'hourly', amount: 18.5 }), 1850);
  assert.equal(hourlyCost({ basis: 'daily', amount: 240 }, { hoursPerDay: 8 }), 3000);
});

test('a rate that is not a number is no rate, rather than zero', () => {
  assert.equal(hourlyCost(null), null);
  assert.equal(hourlyCost({ basis: 'monthly', amount: null }), null);
  assert.equal(hourlyCost({ basis: 'monthly', amount: 'nonsense' }), null);
  // Zero is a real answer and must survive: an unpaid intern costs nothing an
  // hour, which is different from nobody knowing what they cost.
  assert.equal(hourlyCost({ basis: 'monthly', amount: 0 }), 0);
});

// -------------------------------------------------------- what HIVE lacks --

test('a HIVE without payroll is read anyway, and says what was missing', async () => {
  const { raw, db } = hiveDb();
  raw.exec('DROP TABLE pay_slip; DROP TABLE hr_pay;');

  const bundle = await pull({ db, ...may });

  assert.equal(bundle.payroll.length, 0);
  assert.equal(bundle.personDays.length, 2, 'attendance is still read');
  assert.ok(bundle.people.every((p) => p.hourCost == null));
  const notes = bundle.notes.join(' ');
  assert.match(notes, /pay_slip is not in this HIVE database yet/);
  assert.match(notes, /hr_pay is not in this HIVE database yet/);
});

test('the run log says how many people have a rate of their own', async () => {
  const { db } = hiveDb();
  const bundle = await pull({ db, ...may });
  // Two of the three. Worth saying out loud: the third is costed at the
  // property-wide default, and a reader has no other way to know that the
  // wage bill is part measurement and part guess.
  assert.match(bundle.notes.join(' '), /3 staff \(2 with a rate of their own\)/);
});

test('what somebody was down to work is carried, not invented', async () => {
  const { db } = hiveDb();
  const bundle = await pull({ db, ...may });

  const ama = bundle.personDays.find((d) => d.externalId === '1');
  const chef = bundle.personDays.find((d) => d.externalId === '2');

  // A six-hour breakfast shift and a twelve-hour day. The warehouse used to
  // replace both with a hard-coded 480, which made rostered-against-worked a
  // comparison with a fiction.
  assert.equal(ama.expectedMinutes, 360);
  assert.equal(chef.expectedMinutes, 720);
  assert.notEqual(ama.expectedMinutes, 480);
});
