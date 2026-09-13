import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dayLedger, overUnder } from '../src/lib/attendance.js';
import { ISSUE_MAP, issuesOnDay } from '../src/lib/signoff.js';

/**
 * Sick leave on a day off is not a day worked.
 *
 * Leave is recorded against every date somebody types into the leave book:
 * Monday to Sunday, rest days included, because that is how a week off is
 * written down. The ledger credited all seven as days delivered, so a person
 * ill for a week came out two days ahead of a week that only ever expected
 * five of them.
 *
 * The sign-off screen then put the rest day in front of a manager with
 * "nothing clocked", "Sick leave" and "Worked unrostered" on the same card.
 * Every word of that was true except the last one, which was the only one with
 * a number behind it.
 *
 * Nothing was expected of that day and nothing was lost. It is neither
 * delivered nor missed, and the leave book has always counted it that way: a
 * rest day inside a fortnight off is not charged against the balance either.
 */

const MON = '2026-03-02';
const week = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06',
  '2026-03-07', '2026-03-08'];

/** A day, in the shape computeDay hands out. */
const day = (date, extra = {}) => ({
  staff_id: 1,
  day: date,
  shift_id: extra.scheduled === 0 ? null : 1,
  scheduled: 1,
  first_in: null,
  last_out: null,
  worked_minutes: 0,
  expected_minutes: 480,
  late_minutes: 0,
  early_minutes: 0,
  status: 'absent',
  reason_code: 'absent',
  resolution: 'settled',
  ...extra,
});

const worked = (date) => day(date, {
  first_in: `${date} 08:00`, last_out: `${date} 17:00`, worked_minutes: 480, status: 'present',
});
const off = (date) => day(date, { scheduled: 0, shift_id: null, status: 'rest' });
const sick = (date, { scheduled = 1 } = {}) => day(date, {
  scheduled,
  shift_id: scheduled ? 1 : null,
  status: 'leave',
  reason_code: 'sick_leave',
  expected_minutes: scheduled ? 480 : 0,
});

// ---------------------------------------------------------------------------
// What a day is worth
// ---------------------------------------------------------------------------

test('leave on a day they were rostered is a day delivered', () => {
  assert.equal(dayLedger(sick(MON)).owed, 1);
});

test('leave on a day they were not is not', () => {
  const led = dayLedger(sick('2026-03-08', { scheduled: 0 }));
  assert.equal(led.owed, 0, 'nothing was asked of that day');
  assert.equal(led.onLeave, true, 'and it is still a day on leave');
  assert.equal(led.worked, false);
});

test('a day actually worked still counts, rostered or not', () => {
  assert.equal(dayLedger(worked(MON)).owed, 1);
  assert.equal(dayLedger({ ...worked(MON), scheduled: 0, shift_id: null }).owed, 1);
});

// ---------------------------------------------------------------------------
// What a week comes to
// ---------------------------------------------------------------------------

test('a week off sick comes to the week, not the week and a weekend', () => {
  // Five rostered days and two rest days, and the leave book has the whole
  // Monday-to-Sunday range against all seven.
  const records = week.map((d, i) => sick(d, { scheduled: i < 5 ? 1 : 0 }));
  const out = overUnder(records);

  assert.equal(out.delivered, 5, 'the five days that were asked for');
  assert.equal(out.quota, 5);
  assert.equal(out.difference, 0, 'neither owed nor owing');
  assert.deepEqual(out.overs, [], 'and the weekend is not two extra days');
});

test('the same week before the fix would have read as two days over', () => {
  // Kept as arithmetic rather than as history: seven credits against a
  // five-day expectation is the figure that was appearing on the sign-off, and
  // the point of the rule above is that it cannot come back by accident.
  const seven = week.map((d) => sick(d)).reduce((n, r) => n + dayLedger(r).owed, 0);
  assert.equal(seven, 7, 'all seven, if every one of them had been rostered');

  const real = week.map((d, i) => sick(d, { scheduled: i < 5 ? 1 : 0 }))
    .reduce((n, r) => n + dayLedger(r).owed, 0);
  assert.equal(real, 5);
});

test('an ordinary week still balances, and a missed shift still shows', () => {
  const records = [
    worked('2026-03-02'), worked('2026-03-03'), worked('2026-03-04'),
    sick('2026-03-05'), worked('2026-03-06'), off('2026-03-07'), off('2026-03-08'),
  ];
  const out = overUnder(records);
  assert.equal(out.difference, 0, 'four worked and one sick is still five days');
  assert.deepEqual(out.unders, []);

  // And a rostered day nobody worked is still a day missed.
  const missed = records.map((r) => (r.day === '2026-03-06' ? day('2026-03-06') : r));
  assert.deepEqual(overUnder(missed).unders.map((u) => u.day), ['2026-03-06']);
});

test('a day genuinely worked off the rota is still an over, and says so', () => {
  const records = [
    ...['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'].map(worked),
    { ...worked('2026-03-07'), scheduled: 0, shift_id: null, status: 'unscheduled' },
    off('2026-03-08'),
  ];
  const out = overUnder(records);
  assert.deepEqual(out.overs.map((o) => o.day), ['2026-03-07']);
  assert.equal(out.overs[0].why, 'Worked a day the rota did not ask for');
  assert.equal(out.difference, 1);
});

test('somebody taken off the rota for a month of sick leave owes nothing', () => {
  // The other way this could have gone wrong. A planner who leaves a
  // long-term absentee out of the rota altogether has a month of days that
  // were never asked for, and the month must not read as a debt: the same
  // guard that spares a starter whose first week is next week covers them.
  const records = week.map((d) => sick(d, { scheduled: 0 }));
  const asked = records.some((r) => r.scheduled);
  assert.equal(asked, false);
  assert.equal(overUnder(records, { expected: asked }).difference, 0);
});

// ---------------------------------------------------------------------------
// And what the sign-off screen makes of it
// ---------------------------------------------------------------------------

test('a leave day carries nothing for a manager to answer', () => {
  const records = week.map((d, i) => sick(d, { scheduled: i < 5 ? 1 : 0 }));
  const out = overUnder(records);
  const counted = new Map([
    ...out.overs.map((o) => [o.day, 'over']),
    ...out.unders.map((u) => [u.day, 'under']),
  ]);

  for (const record of records) {
    assert.deepEqual(
      issuesOnDay(record, { counted: counted.get(record.day) ?? null }),
      [],
      `${record.day} put something in front of somebody`,
    );
  }
});

test('and it is never the one that reads "Worked unrostered"', () => {
  // The label that was on the card. It exists, it means something, and a day
  // with nothing clocked on it is not it.
  assert.equal(ISSUE_MAP.get('over').label, 'Worked unrostered');

  const restDaySick = sick('2026-03-08', { scheduled: 0 });
  const out = overUnder([restDaySick]);
  assert.deepEqual(out.overs, []);
  assert.equal(issuesOnDay(restDaySick, { counted: null }).includes('over'), false);
});
