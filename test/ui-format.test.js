import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  daysApart, fmtDay, fmtDayShort, fmtNum, fmtPct, monthOf, shiftDay, shiftMonth, todayISO,
} from '../public/js/util.js';
import { pathHasHole } from '../public/js/api.js';
import {
  asHours, byDepartment, byPosition, earliestFirst, shiftHours, shiftLabel, shiftMinutes,
  sortDepartments,
} from '../public/js/views/att-shared.js';

/**
 * The formatting helpers the browser uses, exercised in Node.
 *
 * These are shared by every screen, and they had a bug that reached production:
 * a whole-number format branch referring to a constant that no longer existed.
 * Nothing on the server side touches this file, so the tests never went near
 * it, and the failure showed up as a blank screen with the real cause hidden in
 * a console nobody was looking at.
 *
 * The lesson these tests encode is not "test formatting" — it is that a branch
 * only some callers reach will not be found by using the app. Every branch of
 * fmtNum is covered below on purpose, including the two-argument forms that
 * only the counts in tables use.
 *
 * Anything needing a DOM is left out: this file is a guard against dead
 * references and wrong output, not a browser test.
 */

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

test('whole numbers format without decimals', () => {
  // The branch that was broken. Every count in every table goes through it.
  assert.equal(fmtNum(0, 0), '0');
  assert.equal(fmtNum(7, 0), '7');
  assert.equal(fmtNum(1234, 0), '1,234');
  assert.equal(fmtNum(4.6, 0), '5', 'rounded, not truncated');
});

test('decimals are kept to the places asked for', () => {
  assert.equal(fmtNum(7.25, 1), '7.3');
  assert.equal(fmtNum(7.25, 2), '7.25');
  assert.equal(fmtNum(8), '8', 'a trailing .00 is noise on a screen');
});

test('nothing to show is a dash, not a zero', () => {
  // Zero worked minutes and "no reading yet" mean different things, and a
  // report that renders the second as the first is quietly wrong.
  assert.equal(fmtNum(null, 0), '—');
  assert.equal(fmtNum(undefined, 0), '—');
  assert.equal(fmtNum('', 0), '—');
  assert.equal(fmtNum('not a number', 0), '—');
  assert.equal(fmtNum(NaN, 2), '—');
});

test('a percentage carries its sign only when it is a rise', () => {
  assert.equal(fmtPct(3.2), '+3.2%');
  assert.equal(fmtPct(-3.2), '-3.2%');
  assert.equal(fmtPct(0), '0%');
  assert.equal(fmtPct(null), '—');
});

// ---------------------------------------------------------------------------
// Dates
//
// All of these read a plain 'YYYY-MM-DD' and must not shift a day. Ghana is on
// GMT+0 so a local-time bug would never show here, which is exactly why the
// helpers pin midday UTC and the tests check the boundaries.
// ---------------------------------------------------------------------------

test('a day reads the way somebody would say it', () => {
  assert.equal(fmtDay('2026-06-15'), 'Mon 15 Jun');
  // en-GB puts a comma in once the year is there, and not before. That is the
  // locale's business rather than ours, but it is pinned so a change is noticed.
  assert.equal(fmtDay('2026-06-15', { withYear: true }), 'Mon, 15 Jun 2026');
  assert.equal(fmtDayShort('2026-06-15'), '15 Jun');
  assert.equal(fmtDay(null), '—');
  assert.equal(fmtDayShort(''), '');
});

test('the first and last of a month do not slide into the neighbour', () => {
  assert.equal(fmtDay('2026-01-01'), 'Thu 1 Jan');
  assert.equal(fmtDay('2026-12-31'), 'Thu 31 Dec');
});

test('stepping a day crosses months and years', () => {
  assert.equal(shiftDay('2026-06-15', 1), '2026-06-16');
  assert.equal(shiftDay('2026-06-15', -1), '2026-06-14');
  assert.equal(shiftDay('2026-06-30', 1), '2026-07-01');
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
});

test('stepping a month wraps the year', () => {
  assert.equal(monthOf('2026-06-15'), '2026-06');
  assert.equal(shiftMonth('2026-06', 1), '2026-07');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
});

test("today is a date the rest of the app can parse", () => {
  assert.match(todayISO(), /^\d{4}-\d{2}-\d{2}$/);
});

// ---------------------------------------------------------------------------
// Requests with a hole in them
// ---------------------------------------------------------------------------

/**
 * `/api/att/staff/${id}` with an undefined id builds a path that looks entirely
 * valid, reaches the server, matches the update route, finds nothing, and comes
 * back as "No such member of staff" — which sends whoever reads it looking in
 * the wrong place entirely. It happened on the commonest path there is:
 * pressing "Add this person" against a number the terminal had been sending.
 */

test('a path with a missing id is recognised as broken', () => {
  assert.equal(pathHasHole('/api/att/staff/undefined'), true);
  assert.equal(pathHasHole('/api/att/staff/null'), true);
  assert.equal(pathHasHole('/api/att/staff/NaN'), true);
  assert.equal(pathHasHole('/api/att/leave/undefined/decide'), true, 'in the middle, too');
});

test('a real path is left alone', () => {
  assert.equal(pathHasHole('/api/att/staff'), false);
  assert.equal(pathHasHole('/api/att/staff/12'), false);
  assert.equal(pathHasHole('/api/att/leave/7/decide'), false);
  assert.equal(pathHasHole('/api/att/day?day=2026-08-16'), false);
  // Nothing here should trip on a word that merely contains one.
  assert.equal(pathHasHole('/api/att/undefinedish/4'), false);
  assert.equal(pathHasHole('/api/att/nullify'), false);
});

// ---------------------------------------------------------------------------
// How a shift is written, and how a list of them is ordered
// ---------------------------------------------------------------------------

/**
 * This property runs twenty-four shifts, four of them called some variation of
 * Housekeeper Helper. A dropdown of bare names asks whoever is building the
 * rota to remember what the system already knows, so the hours travel with the
 * name everywhere — and the departments band the list so it reads as five short
 * ones instead of a single long one.
 */

const shift = (name, starts_at, ends_at, department = null) =>
  ({ id: name.length, name, starts_at, ends_at, department, active: 1 });

test('a shift carries its hours', () => {
  assert.equal(shiftHours(shift('Main', '08:00', '17:00')), '08:00–17:00');
  assert.equal(shiftLabel(shift('Main', '08:00', '17:00')), 'Main · 08:00–17:00');
});

test('an overnight shift says so', () => {
  // Thirteen hours across two dates. Without the mark it reads as eleven hours
  // backwards, which is the one thing about a night shift everybody gets wrong.
  assert.equal(shiftHours(shift('Watchman', '17:30', '06:30')), '17:30–06:30 +1');
  // Twenty-four hours round to the same time is still the next day.
  assert.equal(shiftHours(shift('Odd', '08:00', '08:00')), '08:00–08:00 +1');
});

test('a shift with no hours is written as its name alone', () => {
  assert.equal(shiftHours(null), '');
  assert.equal(shiftHours({ name: 'Broken' }), '');
  assert.equal(shiftLabel({ name: 'Broken' }), 'Broken');
});

test('shifts band by department, unfiled ones last', () => {
  const groups = byDepartment([
    shift('Bar late', '17:00', '01:00', 'F&B'),
    shift('Odd job', '09:00', '17:00'),
    shift('Front desk', '07:00', '15:00', 'Reception'),
    shift('Bar early', '11:00', '19:00', 'F&B'),
  ]);

  assert.deepEqual(groups.map((g) => g.name), ['F&B', 'Reception', 'No department']);
  // Order within a band is the order they arrived, which is the order the
  // server sorted them: by the hour they start.
  assert.deepEqual(groups[0].shifts.map((s) => s.name), ['Bar late', 'Bar early']);
  assert.equal(groups[2].shifts.length, 1, 'the unfiled one is still there, just last');
});

test('departments sort alphabetically with the unfiled at the bottom', () => {
  assert.deepEqual(
    sortDepartments(['No department', 'Security', 'F&B']),
    ['F&B', 'Security', 'No department'],
  );
});

test('a shift lasts as long as the clock says, less its break', () => {
  assert.equal(shiftMinutes({ starts_at: '06:00', ends_at: '14:00' }), 480);
  assert.equal(shiftMinutes({ starts_at: '06:00', ends_at: '14:00', break_minutes: 30 }), 450);
  // A shift that ends at or before it starts runs into the next day.
  assert.equal(shiftMinutes({ starts_at: '22:00', ends_at: '06:00' }), 480);
  assert.equal(shiftMinutes({ starts_at: '20:00', ends_at: '20:00' }), 1440);
  assert.equal(shiftMinutes(null), 0);
});

test('hours read the way somebody would say them', () => {
  assert.equal(asHours(480), '8h');
  assert.equal(asHours(450), '7h 30m');
  assert.equal(asHours(0), '0h');
  assert.equal(asHours(-5), '0h');
});

test('days apart counts whole days, either way round', () => {
  assert.equal(daysApart('2026-06-01', '2026-06-05'), 4);
  assert.equal(daysApart('2026-06-05', '2026-06-05'), 0);
  assert.equal(daysApart('2026-06-05', '2026-06-01'), -4);
  // Across a month end, and across the day the clocks would change elsewhere.
  assert.equal(daysApart('2026-02-27', '2026-03-02'), 3);
  assert.equal(daysApart('2026-03-28', '2026-03-30'), 2);
});

test('a position stacks its shifts earliest first', () => {
  const at = (name, starts, ends, position) => ({ ...shift(name, starts, ends), position });
  const groups = byPosition([
    at('Housekeeping late', '14:00', '22:00', 'Housekeeping'),
    at('Breakfast 15', '06:00', '15:00', 'Breakfast'),
    at('Housekeeping early', '06:00', '14:00', 'Housekeeping'),
    at('Breakfast 14', '06:00', '14:00', 'Breakfast'),
    at('Night watch', '22:00', '06:00', null),
  ]);

  // Positions in the order the day happens, and the shifts inside each the
  // same way — which is how anybody reads a rota out loud.
  assert.deepEqual(groups.map((g) => g.name), ['Breakfast', 'Housekeeping', 'Night watch']);
  assert.deepEqual(groups[1].shifts.map((s) => s.name),
    ['Housekeeping early', 'Housekeeping late']);
  assert.equal(groups[0].grouped, true, 'two shifts under one name is a grouping');
  assert.equal(groups[2].grouped, false, 'and one on its own is not');
});

test('everything that stacks shifts stacks them by the clock', () => {
  const one = shift('Bistro shift 1', '11:00', '19:00');
  const two = shift('Bistro shift 2', '13:45', '22:00');

  // The cards in a day's cell come out of the people list, so without this
  // they stack in whatever order the names happen to be in — which is how an
  // 13:45 ended up sitting above an 11:00.
  assert.deepEqual([two, one].sort(earliestFirst).map((s) => s.name),
    ['Bistro shift 1', 'Bistro shift 2']);

  // A missing shift sorts first rather than throwing, because a cell can hold
  // an entry whose shift has since been retired.
  assert.equal(earliestFirst(undefined, one) < 0, true);

  // Same start, so the name settles it and the order never wobbles between
  // one drawing of the page and the next.
  const early = shift('Alpha', '06:00', '14:00');
  const late = shift('Beta', '06:00', '15:00');
  assert.deepEqual([late, early].sort(earliestFirst).map((s) => s.name), ['Alpha', 'Beta']);
});
