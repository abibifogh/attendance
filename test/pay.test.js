import { test } from 'node:test';
import assert from 'node:assert/strict';

import { costFor, money, perDayAndHour, rateOn } from '../src/lib/pay.js';

/**
 * What the rota costs.
 *
 * Every case here is one somebody could check on paper, because these figures
 * end up in a conversation about whether the property can afford a sixth cook.
 */

const rates = [
  { basis: 'monthly', amount: 1200, currency: 'GHS', from_day: '2026-01-01' },
  { basis: 'monthly', amount: 1500, currency: 'GHS', from_day: '2026-06-01' },
];

test('the rate in force is the latest one that had started', () => {
  assert.equal(rateOn(rates, '2026-03-15').amount, 1200);
  assert.equal(rateOn(rates, '2026-06-01').amount, 1500, 'the day it starts, it applies');
  assert.equal(rateOn(rates, '2026-12-31').amount, 1500);
});

test('before anybody set a rate there is no rate, not a zero', () => {
  assert.equal(rateOn(rates, '2025-12-31'), null);
  assert.equal(rateOn([], '2026-03-15'), null);
  // A zero would look like an answer. Nothing is the truth.
  assert.equal(costFor({ rates: [], days: [{ day: '2026-03-02', hours: 8 }] }), null);
});

test('a rise in June does not change what January cost', () => {
  const january = costFor({
    rates,
    days: [{ day: '2026-01-05', hours: 8 }],
    span: 31,
    daysPerWeek: 5,
  });
  const july = costFor({
    rates,
    days: [{ day: '2026-07-06', hours: 8 }],
    span: 31,
    daysPerWeek: 5,
  });
  assert.equal(january.rate, 1200);
  assert.equal(july.rate, 1500);
  assert.ok(july.fixed > january.fixed, 'and the later month costs more');
});

test('a monthly salary is converted with the shape of the week, not an assumption', () => {
  const five = perDayAndHour({ basis: 'monthly', amount: 1300 }, { daysPerWeek: 5, hoursPerDay: 8 });
  const six = perDayAndHour({ basis: 'monthly', amount: 1300 }, { daysPerWeek: 6, hoursPerDay: 8 });

  // 1300 a month over 52/12 weeks: five days a week is 60 a day, six is 50.
  assert.equal(Math.round(five.day), 60);
  assert.equal(Math.round(six.day), 50);
  assert.ok(six.day < five.day, 'six days for the same money is a lower daily rate');
});

test('a salary does not go up because somebody worked a sixth day', () => {
  const five = costFor({
    rates: [{ basis: 'monthly', amount: 1200, from_day: '2026-01-01' }],
    days: Array.from({ length: 10 }, (unused, i) => ({ day: `2026-03-0${(i % 9) + 1}`, hours: 8 })),
    span: 14,
  });
  const six = costFor({
    rates: [{ basis: 'monthly', amount: 1200, from_day: '2026-01-01' }],
    days: Array.from({ length: 12 }, (unused, i) => ({ day: `2026-03-0${(i % 9) + 1}`, hours: 8 })),
    span: 14,
  });

  assert.equal(five.total, six.total, 'the bank balance does not notice');
  assert.equal(five.variable, 0, 'nothing here is the rota’s doing');
  assert.ok(five.fixed > 0);
});

test('a daily rate does go up, which is the whole difference', () => {
  const build = (n) => costFor({
    rates: [{ basis: 'daily', amount: 70, from_day: '2026-01-01' }],
    days: Array.from({ length: n }, (unused, i) => ({ day: `2026-03-1${i % 9}`, hours: 8 })),
    span: 14,
  });

  assert.equal(build(10).variable, 700);
  assert.equal(build(12).variable, 840);
  assert.equal(build(10).fixed, 0, 'a casual costs nothing on a day nobody called them in');
});

test('an hourly rate follows the hours, not the days', () => {
  const cost = costFor({
    rates: [{ basis: 'hourly', amount: 9, from_day: '2026-01-01' }],
    days: [
      { day: '2026-03-02', hours: 8 },
      { day: '2026-03-03', hours: 12 },
    ],
    span: 14,
  });
  assert.equal(cost.variable, 180, '20 hours at 9');
});

test('overtime is a premium on top, and a salary still feels it', () => {
  const plain = costFor({
    rates: [{ basis: 'monthly', amount: 1200, from_day: '2026-01-01' }],
    days: [{ day: '2026-03-02', hours: 8 }],
    span: 14,
  });
  const withOvertime = costFor({
    rates: [{ basis: 'monthly', amount: 1200, from_day: '2026-01-01' }],
    days: [{ day: '2026-03-02', hours: 8 }],
    overtimeHours: 10,
    span: 14,
    overtimeMultiplier: 1.5,
  });

  assert.equal(plain.premium, 0);
  assert.ok(withOvertime.premium > 0,
    'a salaried cook working ten hours over still costs the property something');
  assert.equal(withOvertime.total, plain.total + withOvertime.premium);
});

test('for somebody paid by the hour, overtime is only the extra half', () => {
  // Their ordinary hours are already in `variable`, so charging 1.5x again
  // would bill the first hour twice.
  const cost = costFor({
    rates: [{ basis: 'hourly', amount: 10, from_day: '2026-01-01' }],
    days: [{ day: '2026-03-02', hours: 10 }],
    overtimeHours: 2,
    span: 14,
    overtimeMultiplier: 1.5,
  });
  assert.equal(cost.variable, 100, 'ten hours at ten');
  assert.equal(cost.premium, 10, 'two overtime hours, half again on each');
  assert.equal(cost.total, 110);
});

test('money reads the way somebody would write it', () => {
  assert.equal(money(1200, 'GHS'), 'GHS 1,200');
  assert.equal(money(1234.5, 'GHS'), 'GHS 1,234.50');
  assert.equal(money(0, 'GHS'), 'GHS 0');
});
