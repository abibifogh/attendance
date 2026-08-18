import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ISSUES, daysBetween, describePeriod, effectiveDays, findClash,
  issuesInPeriod, issuesOnDay, parseDays, unsignedDays,
} from '../src/lib/signoff.js';

/**
 * Signing off part of a period.
 *
 * One rule here is load-bearing and the rest is arithmetic. It used to be "no
 * two signed spans may share a date", checked against the raw dates, and that
 * was right while a sign-off always covered everything between them. It stops
 * being right the moment a month can leave three days out: signing those three
 * afterwards would be refused by the very month that deliberately excluded
 * them, and there would be no way to settle them at all.
 */

const review = (from, to, excluded = null) => ({
  from_day: from, to_day: to, excluded_days: excluded && JSON.stringify(excluded),
});

// ---------------------------------------------------------------------------
// Days, and what a sign-off actually signed
// ---------------------------------------------------------------------------

test('a span is the days between its ends, inclusive', () => {
  assert.deepEqual(daysBetween('2026-08-17', '2026-08-19'),
    ['2026-08-17', '2026-08-18', '2026-08-19']);
  assert.deepEqual(daysBetween('2026-08-17', '2026-08-17'), ['2026-08-17']);
  assert.deepEqual(daysBetween('2026-08-19', '2026-08-17'), [], 'backwards is nothing');
});

test('what a sign-off signed is the span less what it left out', () => {
  const signed = effectiveDays(review('2026-08-17', '2026-08-21', ['2026-08-19']));
  assert.deepEqual(signed, ['2026-08-17', '2026-08-18', '2026-08-20', '2026-08-21']);
});

test('a sign-off with nothing left out signs the lot', () => {
  assert.equal(effectiveDays(review('2026-08-01', '2026-08-31')).length, 31);
});

test('a corrupt exclusion list is read as none rather than throwing', () => {
  // Whatever else happens, a bad row must not take the sign-off screen down.
  assert.deepEqual(parseDays('not json'), []);
  assert.deepEqual(parseDays(null), []);
  assert.deepEqual(parseDays(['2026-08-01']), ['2026-08-01']);
  assert.equal(effectiveDays({ from_day: '2026-08-01', to_day: '2026-08-02', excluded_days: '{' }).length, 2);
});

// ---------------------------------------------------------------------------
// The rule that changed
// ---------------------------------------------------------------------------

test('two sign-offs sharing a signed day are refused, and it names the day', () => {
  // Charging the same absence through a week and again through its month is a
  // wrong number nothing downstream would ever notice.
  const clash = findClash(
    daysBetween('2026-08-17', '2026-08-23'),
    [review('2026-08-01', '2026-08-31')],
  );

  assert.ok(clash);
  assert.equal(clash.day, '2026-08-17', 'the first day they share, so the message can say which');
  assert.equal(clash.review.from_day, '2026-08-01');
});

test('a day a month deliberately left out can still be signed on its own', () => {
  // The whole reason the comparison moved off the raw dates. Without this, the
  // three days a month excluded could never be settled by anybody.
  const august = review('2026-08-01', '2026-08-31', ['2026-08-19', '2026-08-20']);

  assert.equal(findClash(['2026-08-19'], [august]), null);
  assert.equal(findClash(['2026-08-19', '2026-08-20'], [august]), null);
  // And a day it did sign is still protected.
  assert.ok(findClash(['2026-08-21'], [august]));
});

test('nothing is outstanding once every day is covered', () => {
  const august = review('2026-08-01', '2026-08-31');
  assert.deepEqual(unsignedDays('2026-08-01', '2026-08-31', [august]), []);
});

test('what is outstanding is what nobody signed', () => {
  const week = review('2026-08-17', '2026-08-23');
  const partial = review('2026-08-24', '2026-08-26', ['2026-08-25']);

  assert.deepEqual(
    unsignedDays('2026-08-17', '2026-08-27', [week, partial]),
    ['2026-08-25', '2026-08-27'],
  );
});

test('overlapping sign-offs do not double-count what is left', () => {
  const a = review('2026-08-01', '2026-08-10');
  const b = review('2026-08-05', '2026-08-15');
  assert.deepEqual(unsignedDays('2026-08-01', '2026-08-16', [a, b]), ['2026-08-16']);
});

// ---------------------------------------------------------------------------
// What is wrong with a day
// ---------------------------------------------------------------------------

test('a day that nobody has settled is an issue, and a blocking one', () => {
  assert.deepEqual(issuesOnDay({ status: 'open' }), ['open']);
  assert.equal(issuesInPeriod([{ issues: ['open'] }]).blocking, true);
});

test('an absence somebody has already ruled on is not still an issue', () => {
  assert.deepEqual(issuesOnDay({ status: 'absent' }), ['absent']);
  assert.deepEqual(issuesOnDay({ status: 'absent', resolved_by: 'Ama' }), []);
});

test('a day can be wrong in more than one way', () => {
  const found = issuesOnDay({ status: 'late_early', scheduled: 1 });
  assert.deepEqual(found.sort(), ['early', 'late']);
});

test('a minute inside the grace period is not lateness', () => {
  // Grace exists so that somebody due at 06:00 who arrives at 06:01 is not
  // late. The rules already decided that, and this reads their verdict rather
  // than the raw minutes — otherwise the screen would carry a warning beside
  // half the property every morning, and stop being read.
  assert.deepEqual(issuesOnDay({ status: 'present', late_minutes: 1, scheduled: 1 }), []);
  assert.deepEqual(issuesOnDay({ status: 'late', late_minutes: 47, scheduled: 1 }), ['late']);
});

test('lateness is worth seeing and not worth stopping for', () => {
  const period = issuesInPeriod([{ issues: ['late'] }, { issues: ['late', 'early'] }]);
  assert.equal(period.total, 3);
  assert.equal(period.blocking, false, 'three minutes late should not hold up a month');
  assert.deepEqual(period.counts, { late: 2, early: 1 });
});

test('working a day the rota did not ask for is counted once, not twice', () => {
  // Without the guard it would read as both "worked unrostered" and "no shift",
  // which is the same fact told two ways and reads as two problems.
  assert.deepEqual(issuesOnDay({ scheduled: 0, worked_minutes: 480 }, { counted: 'over' }), ['over']);
  assert.deepEqual(issuesOnDay({ scheduled: 0, worked_minutes: 120 }, { counted: null }), ['noshift']);
});

test('a clean day raises nothing', () => {
  assert.deepEqual(
    issuesOnDay({ status: 'present', scheduled: 1, worked_minutes: 480, late_minutes: 0, early_minutes: 0 }),
    [],
  );
  assert.equal(issuesInPeriod([{ issues: [] }]).total, 0);
});

test('every issue has a name somebody could act on', () => {
  for (const issue of ISSUES) {
    assert.ok(issue.label && issue.detail, `${issue.key} is unexplained`);
    assert.equal(typeof issue.blocking, 'boolean');
  }
});

// ---------------------------------------------------------------------------
// The line in the queue
// ---------------------------------------------------------------------------

test('a period reads as a sentence rather than a row of numbers', () => {
  const unsigned = [{ day: '1' }, { day: '2' }, { day: '3' }];
  const issues = issuesInPeriod([{ issues: ['absent'] }, { issues: ['late'] }, { issues: ['late'] }]);

  assert.equal(
    describePeriod({ name: 'Angela Asare Ayima', unsigned, issues }),
    'Angela Asare Ayima — 3 days, 1 absent, 2 late',
  );
});

test('a clean period says so rather than saying nothing', () => {
  assert.equal(
    describePeriod({ name: 'Kofi', unsigned: [{ day: '1' }], issues: issuesInPeriod([{ issues: [] }]) }),
    'Kofi — 1 day, nothing wrong',
  );
});
