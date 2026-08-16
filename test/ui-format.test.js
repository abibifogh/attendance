import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fmtDay, fmtDayShort, fmtNum, fmtPct, monthOf, shiftDay, shiftMonth, todayISO,
} from '../public/js/util.js';
import { pathHasHole } from '../public/js/api.js';

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
